import { Intent, Round, Match, HookData, ExecutionResult, RoundIntentRef } from '@/lib/types';
import { generateHexString } from '@/lib/utils';
import { IExecDataProtector } from '@iexec/dataprotector';
import type { DataObject } from '@iexec/dataprotector';
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeAbiParameters,
  decodeErrorResult,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseUnits,
  toBytes,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { arbitrum, arbitrumSepolia } from 'viem/chains';

// Simulated network delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const MOCK_MATCHES: Match[] = [];
const relayerFetchBackoff = new Map<string, number>();

let shadowPoolEthereumProvider: ConstructorParameters<typeof IExecDataProtector>[0] | null = null;
type ViemCustomProvider = Parameters<typeof custom>[0];

const FALLBACK_IEXEC_APP_ADDRESS = '0xd09c0e287bE3600B9fb615Fa3dC67a448EAa3954' as const;
const HOOK_ERROR_SELECTORS: Record<string, string> = {
  '0x1c8b6259': 'RootNotSet',
  '0x9ba67430': 'RootExpired',
  '0x09bde339': 'InvalidProof',
  '0xa7a77970': 'LeafAlreadyUsed',
  '0x416a1e93': 'MatchAlreadyUsed',
  '0xd59b569a': 'InvalidHookData',
  '0x8baa579f': 'InvalidSignature',
  '0x56a01e6a': 'MatchExpired',
  '0x5c427cd9': 'UnauthorizedCaller',
  '0x5037072d': 'InvalidSwapParams',
  '0xe026c11b': 'InvalidTeeSigner',
  '0xd2932843': 'MinAmountOutNotMet',
};
const POOLS_SLOT = 6n;
const POOL_LIQUIDITY_OFFSET = 3n;
const U128_MASK = (1n << 128n) - 1n;
const U160_MASK = (1n << 160n) - 1n;
const I128_SIGN = 1n << 127n;

function toSigned128(value: bigint): bigint {
  const v = value & U128_MASK;
  return v >= I128_SIGN ? v - (1n << 128n) : v;
}

function decodeBalanceDelta(delta: bigint): { amount0: bigint; amount1: bigint } {
  const amount0 = delta >> 128n;
  const amount1 = toSigned128(delta);
  return { amount0, amount1 };
}

export function setShadowPoolEthereumProvider(
  provider: ConstructorParameters<typeof IExecDataProtector>[0] | null
) {
  shadowPoolEthereumProvider = provider;
}

export function getConfiguredTokenAddresses(): Address[] {
  const candidates = [
    import.meta.env.VITE_TOKEN_A_ADDRESS,
    import.meta.env.VITE_TOKEN_B_ADDRESS,
    import.meta.env.VITE_TOKEN_C_ADDRESS,
    import.meta.env.VITE_TOKEN_D_ADDRESS,
  ];

  const out: Address[] = [];
  for (const c of candidates) {
    if (typeof c !== 'string' || !c.startsWith('0x')) continue;
    try {
      out.push(asAddress(c));
    } catch {
      continue;
    }
  }
  return out;
}

export type Erc20TokenMetadata = {
  address: Address;
  symbol: string | null;
  name: string | null;
  status: 'ok' | 'no_contract' | 'read_failed';
  error: string | null;
};

const tokenMetadataCache = new Map<string, { symbol: string; name: string; decimals: number }>();

async function resolveTokenMetadata(address: string) {
  const key = address.toLowerCase();
  const cached = tokenMetadataCache.get(key);
  if (cached) return cached;
  let normalized: Address;
  try {
    normalized = asAddress(address);
  } catch {
    return null;
  }
  const client = await getPublicClientForReads();
  const abi = parseAbi([
    'function symbol() view returns (string)',
    'function name() view returns (string)',
    'function decimals() view returns (uint8)',
  ]);
  const [symbolRes, nameRes, decimalsRes] = await Promise.allSettled([
    client.readContract({ address: normalized, abi, functionName: 'symbol' }),
    client.readContract({ address: normalized, abi, functionName: 'name' }),
    client.readContract({ address: normalized, abi, functionName: 'decimals' }),
  ]);
  const symbol =
    symbolRes.status === 'fulfilled' && typeof symbolRes.value === 'string'
      ? symbolRes.value.trim()
      : 'TKN';
  const name =
    nameRes.status === 'fulfilled' && typeof nameRes.value === 'string'
      ? nameRes.value.trim()
      : 'Token';
  const decimals =
    decimalsRes.status === 'fulfilled' && Number.isFinite(Number(decimalsRes.value))
      ? Number(decimalsRes.value)
      : 18;
  const meta = { symbol: symbol || 'TKN', name: name || 'Token', decimals };
  tokenMetadataCache.set(key, meta);
  return meta;
}

function formatRpcError(err: unknown): string {
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return;
    if (parts.includes(value)) return;
    const clipped = value.length > 400 ? `${value.slice(0, 400)}…` : value;
    parts.push(clipped);
  };
  const addMeta = (meta: unknown) => {
    if (!Array.isArray(meta)) return;
    for (const entry of meta) {
      if (typeof entry === 'string') push(entry);
    }
  };
  const unwrap = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const anyErr = value as {
      shortMessage?: string;
      message?: string;
      details?: string;
      metaMessages?: string[];
      cause?: unknown;
      data?: unknown;
    };
    push(anyErr.shortMessage);
    push(anyErr.message);
    push(anyErr.details);
    addMeta(anyErr.metaMessages);
    if (typeof anyErr.data === 'string' && anyErr.data.startsWith('0x')) {
      push(`revert data: ${anyErr.data.slice(0, 120)}…`);
    }
    if (anyErr.cause) unwrap(anyErr.cause);
  };

  unwrap(err);
  if (parts.length > 0) return parts.join(' | ');
  return String(err);
}

export async function fetchErc20TokenMetadata(tokenAddresses: Address[]): Promise<Erc20TokenMetadata[]> {
  if (tokenAddresses.length === 0) return [];
  const { publicClient } = await getViemClients();
  const symbolAbi = parseAbi(['function symbol() view returns (string)']);
  const nameAbi = parseAbi(['function name() view returns (string)']);

  const settled = await Promise.allSettled(
    tokenAddresses.map(async (address) => {
      const code = await publicClient.getCode({ address });
      if (!code || code === '0x') {
        return { address, symbol: null, name: null, status: 'no_contract', error: null } as const;
      }
      try {
        const [symbolHex, nameHex] = await Promise.all([
          publicClient.request({
            method: 'eth_call',
            params: [{ to: address, data: encodeFunctionData({ abi: symbolAbi, functionName: 'symbol' }) }, 'latest'],
          }),
          publicClient.request({
            method: 'eth_call',
            params: [{ to: address, data: encodeFunctionData({ abi: nameAbi, functionName: 'name' }) }, 'latest'],
          }),
        ]);
        const symbol = decodeFunctionResult({ abi: symbolAbi, functionName: 'symbol', data: symbolHex as Hex });
        const name = decodeFunctionResult({ abi: nameAbi, functionName: 'name', data: nameHex as Hex });
        return { address, symbol: String(symbol), name: String(name), status: 'ok', error: null } as const;
      } catch (err) {
        return { address, symbol: null, name: null, status: 'read_failed', error: formatRpcError(err) } as const;
      }
    })
  );

  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { address: tokenAddresses[i]!, symbol: null, name: null, status: 'read_failed', error: formatRpcError(r.reason) };
  });
}

export type Erc20TokenBalance = {
  address: Address;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  balance: string | null;
  status: 'ok' | 'no_contract' | 'read_failed';
  error: string | null;
};

export async function fetchConfiguredTokenBalances(): Promise<Erc20TokenBalance[]> {
  return fetchErc20TokenBalances(getConfiguredTokenAddresses());
}

export async function fetchConfiguredTokenBalancesFor(account: string): Promise<Erc20TokenBalance[]> {
  const tokens = getConfiguredTokenAddresses();
  if (tokens.length === 0) return [];
  const publicClient = await getPublicClientForReads();
  const resolvedAccount = asAddress(account);
  return fetchErc20TokenBalances(tokens, { publicClient, account: resolvedAccount });
}

export async function fetchErc20TokenBalances(
  tokenAddresses: Address[],
  options?: { publicClient?: Awaited<ReturnType<typeof getPublicClientForReads>>; account?: Address }
): Promise<Erc20TokenBalance[]> {
  if (tokenAddresses.length === 0) return [];
  const needsClient = !options?.publicClient || !options?.account;
  const fallback = needsClient ? await getViemClients() : null;
  const publicClient = options?.publicClient ?? fallback!.publicClient;
  const account = options?.account ?? fallback!.account;
  const symbolAbi = parseAbi(['function symbol() view returns (string)']);
  const nameAbi = parseAbi(['function name() view returns (string)']);
  const decimalsAbi = parseAbi(['function decimals() view returns (uint8)']);
  const balanceOfAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);

  const settled = await Promise.allSettled(
    tokenAddresses.map(async (address) => {
      const code = await publicClient.getCode({ address });
      if (!code || code === '0x') {
        return { address, symbol: null, name: null, decimals: null, balance: null, status: 'no_contract', error: null } as const;
      }
      try {
        const [symbolHex, nameHex, decimalsHex, balanceHex] = await Promise.all([
          publicClient.request({
            method: 'eth_call',
            params: [{ to: address, data: encodeFunctionData({ abi: symbolAbi, functionName: 'symbol' }) }, 'latest'],
          }),
          publicClient.request({
            method: 'eth_call',
            params: [{ to: address, data: encodeFunctionData({ abi: nameAbi, functionName: 'name' }) }, 'latest'],
          }),
          publicClient.request({
            method: 'eth_call',
            params: [{ to: address, data: encodeFunctionData({ abi: decimalsAbi, functionName: 'decimals' }) }, 'latest'],
          }),
          publicClient.request({
            method: 'eth_call',
            params: [
              { to: address, data: encodeFunctionData({ abi: balanceOfAbi, functionName: 'balanceOf', args: [account] }) },
              'latest',
            ],
          }),
        ]);

        const symbol = decodeFunctionResult({ abi: symbolAbi, functionName: 'symbol', data: symbolHex as Hex });
        const name = decodeFunctionResult({ abi: nameAbi, functionName: 'name', data: nameHex as Hex });
        const decimals = decodeFunctionResult({ abi: decimalsAbi, functionName: 'decimals', data: decimalsHex as Hex });
        const rawBalance = decodeFunctionResult({ abi: balanceOfAbi, functionName: 'balanceOf', data: balanceHex as Hex });

        const decimalsNum = Number(decimals);
        return {
          address,
          symbol: String(symbol),
          name: String(name),
          decimals: decimalsNum,
          balance: formatUnits(rawBalance as bigint, decimalsNum),
          status: 'ok',
          error: null,
        } as const;
      } catch (err) {
        return { address, symbol: null, name: null, decimals: null, balance: null, status: 'read_failed', error: formatRpcError(err) } as const;
      }
    })
  );

  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      address: tokenAddresses[i]!,
      symbol: null,
      name: null,
      decimals: null,
      balance: null,
      status: 'read_failed',
      error: formatRpcError(r.reason),
    };
  });
}

function getEthereumProvider() {
  if (shadowPoolEthereumProvider) {
    return shadowPoolEthereumProvider;
  }

  const ethereum = (window as Window & { ethereum?: unknown }).ethereum;
  if (!ethereum) {
    throw new Error('No injected wallet found');
  }
  return ethereum as unknown as ConstructorParameters<typeof IExecDataProtector>[0];
}

export function getReadRpcUrl(): string | null {
  return (
    import.meta.env.VITE_RPC_URL ??
    import.meta.env.VITE_PUBLIC_RPC_URL ??
    import.meta.env.VITE_ARBITRUM_SEPOLIA_RPC_URL ??
    import.meta.env.VITE_ALCHEMY_ARBITRUM_SEPOLIA_RPC_URL ??
    import.meta.env.VITE_ALCHEMY_RPC_URL ??
    null
  );
}

function getPostEndMatchingSeconds(): bigint {
  const env = parseEnvBigInt(
    import.meta.env.VITE_POST_END_MATCHING_SECONDS ??
      import.meta.env.VITE_MATCHING_GRACE_SECONDS ??
      import.meta.env.VITE_MATCHING_WINDOW_AFTER_END_SECONDS
  );
  return env != null && env > 0n ? env : 3600n;
}

function getRootValiditySeconds(): number {
  const env = parseEnvBigInt(
    import.meta.env.VITE_ROOT_VALIDITY_SECONDS ??
      import.meta.env.VITE_ROOT_VALID_UNTIL_SECONDS ??
      import.meta.env.VITE_ROOT_TTL_SECONDS
  );
  const seconds = env != null && env > 0n ? Number(env) : 3600;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
}

function getViemProvider(): ViemCustomProvider {
  const provider = getEthereumProvider();
  if (typeof provider === 'string') {
    throw new Error('Unsupported wallet provider');
  }
  return provider as unknown as ViemCustomProvider;
}

function normalizeChainIdValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    let v = value.trim();
    if (!v) return null;
    if (v.includes(':')) {
      const parts = v.split(':');
      v = parts[parts.length - 1] ?? v;
    }
    if (v.startsWith('0x')) {
      const parsed = Number.parseInt(v, 16);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const parsed = Number.parseInt(v, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function ensureArbitrumSepoliaChain(): Promise<void> {
  const provider = getEthereumProvider() as {
    request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  };
  if (!provider?.request) return;

  const chainIdRaw = await provider.request({ method: 'eth_chainId' }).catch(() => null);
  const chainId = normalizeChainIdValue(chainIdRaw);
  if (chainId === arbitrumSepolia.id) return;

  const chainIdHex = `0x${arbitrumSepolia.id.toString(16)}`;
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    const anyErr = err as { code?: number; message?: string; data?: { originalError?: { code?: number } } };
    const code = anyErr?.code ?? anyErr?.data?.originalError?.code;
    const msg = anyErr?.message ?? '';
    const shouldAdd =
      code === 4902 || /unknown chain/i.test(msg) || /not added/i.test(msg);
    if (!shouldAdd) {
      throw new Error('Please switch your wallet to Arbitrum Sepolia.');
    }

    const rpcUrl = getReadRpcUrl() ?? arbitrumSepolia.rpcUrls.default.http[0];
    const explorer = arbitrumSepolia.blockExplorers?.default?.url;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: chainIdHex,
          chainName: arbitrumSepolia.name,
          rpcUrls: [rpcUrl],
          nativeCurrency: arbitrumSepolia.nativeCurrency,
          blockExplorerUrls: explorer ? [explorer] : [],
        },
      ],
    });
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
  }
}

async function getPublicClientForReads() {
  const rpcUrl = getReadRpcUrl();
  if (rpcUrl) {
    // Always prefer the configured read RPC to avoid wallet-provider caching/latency.
    return createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
  }
  if (shadowPoolEthereumProvider) {
    try {
      const transport = custom(getViemProvider());
      const walletClientBase = createWalletClient({ transport });
      const chainId = await walletClientBase.getChainId();
      const chain =
        chainId === arbitrumSepolia.id ? arbitrumSepolia : chainId === arbitrum.id ? arbitrum : undefined;
      if (chain) {
        return createPublicClient({ chain, transport });
      }
      // fall through
    } catch {
      return createPublicClient({ chain: arbitrumSepolia, transport: http() });
    }
  }
  return createPublicClient({ chain: arbitrumSepolia, transport: http() });
}

function getDataProtectorCore() {
  const dataProtector = new IExecDataProtector(getEthereumProvider(), {
    allowExperimentalNetworks: true,
  });
  return dataProtector.core;
}

export function getIExecAppAddress(): string {
  return (
    import.meta.env.VITE_IEXEC_APP_ADDRESS ??
    import.meta.env.VITE_IEXEC_APP ??
    import.meta.env.VITE_IEXEC_APP_WHITELIST ??
    FALLBACK_IEXEC_APP_ADDRESS
  );
}

function getRootRegistryAddress(): Address | null {
  const fromEnv =
    import.meta.env.VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS ??
    import.meta.env.VITE_SHADOWPOOL_CLEARINGHOUSE_ADDRESS ??
    null;
  if (!fromEnv) return null;
  return asAddress(fromEnv);
}

function getIntentRegistryAddress(): Address | null {
  const fromEnv = import.meta.env.VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS ?? null;
  if (!fromEnv) return null;
  return asAddress(fromEnv);
}

function parseEnvBigInt(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  try {
    if (v.startsWith('0x') || v.startsWith('0X')) return BigInt(v);
    if (!/^-?\d+$/.test(v)) return null;
    return BigInt(v);
  } catch {
    return null;
  }
}

function getShadowPoolLogsFromBlock(overrides?: { intentRegistry?: Address | null; rootRegistry?: Address | null }): bigint {
  const intentRegistryAddress = overrides?.intentRegistry ?? getIntentRegistryAddress();
  const rootRegistryAddress = overrides?.rootRegistry ?? getRootRegistryAddress();

  const intentFromBlock = parseEnvBigInt(import.meta.env.VITE_SHADOWPOOL_INTENT_REGISTRY_FROM_BLOCK);
  if (intentFromBlock != null && intentRegistryAddress) return intentFromBlock;

  const rootFromBlock = parseEnvBigInt(import.meta.env.VITE_SHADOWPOOL_ROOT_REGISTRY_FROM_BLOCK);
  if (rootFromBlock != null && rootRegistryAddress) return rootFromBlock;

  const fallback = parseEnvBigInt(import.meta.env.VITE_SHADOWPOOL_FROM_BLOCK);
  return fallback ?? 0n;
}

function getShadowPoolLogsChunkSize(): bigint {
  const env = parseEnvBigInt(import.meta.env.VITE_SHADOWPOOL_LOG_CHUNK_SIZE);
  const n = env ?? 50_000n;
  return n > 0n ? n : 50_000n;
}

async function getLogsChunked<TLog>(args: {
  publicClient: { getLogs: (params: Record<string, unknown>) => Promise<TLog[]> };
  params: Record<string, unknown>;
  fromBlock: bigint;
  toBlock: bigint;
  chunkSize: bigint;
}): Promise<TLog[]> {
  const out: TLog[] = [];
  let start = args.fromBlock;
  while (start <= args.toBlock) {
    const end = start + args.chunkSize - 1n;
    const to = end > args.toBlock ? args.toBlock : end;
    const logs = await args.publicClient.getLogs({ ...args.params, fromBlock: start, toBlock: to });
    out.push(...logs);
    start = to + 1n;
  }
  return out;
}

function getHookAddress(): Address | null {
  const fromEnv =
    import.meta.env.VITE_SHADOWPOOL_HOOK_ADDRESS ??
    import.meta.env.VITE_UNISWAP_V4_HOOK_ADDRESS ??
    null;
  if (!fromEnv) return null;
  return asAddress(fromEnv);
}

function getSwapRouterAddress(): Address | null {
  const fromEnv =
    import.meta.env.VITE_POOL_SWAP_TEST_ADDRESS ??
    import.meta.env.VITE_UNISWAP_V4_SWAP_ROUTER_ADDRESS ??
    import.meta.env.VITE_UNISWAP_V4_ROUTER_ADDRESS ??
    null;
  if (!fromEnv) return null;
  return asAddress(fromEnv);
}

function getPoolFee(): number {
  const raw =
    import.meta.env.VITE_POOL_FEE ??
    import.meta.env.VITE_UNISWAP_V4_POOL_FEE ??
    import.meta.env.VITE_UNISWAP_V4_FEE ??
    null;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function getTickSpacing(): number {
  const raw =
    import.meta.env.VITE_POOL_TICK_SPACING ??
    import.meta.env.VITE_UNISWAP_V4_TICK_SPACING ??
    import.meta.env.VITE_UNISWAP_V4_POOL_TICK_SPACING ??
    null;
  if (!raw) return 60;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 60;
}

function toRoundIdBytes32(roundId: string): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(roundId)) return roundId as Hex;
  const bytes = new TextEncoder().encode(roundId);
  return keccak256(bytes) as Hex;
}

async function getViemClients() {
  await ensureArbitrumSepoliaChain();
  const walletTransport = custom(getViemProvider());
  const walletClientBase = createWalletClient({ transport: walletTransport });
  const chainId = await walletClientBase.getChainId();
  const chain = chainId === arbitrumSepolia.id ? arbitrumSepolia : chainId === arbitrum.id ? arbitrum : undefined;
  if (!chain) {
    throw new Error(`Unsupported network (chainId ${chainId})`);
  }
  const walletClient = createWalletClient({ chain, transport: walletTransport });
  const readRpcUrl = getReadRpcUrl();
  const publicTransport = readRpcUrl ? http(readRpcUrl) : walletTransport;
  const publicClient = createPublicClient({ chain, transport: publicTransport });
  const [account] = await walletClient.getAddresses();
  if (!account) throw new Error('Wallet not connected');
  return { publicClient, walletClient, account, chainId };
}

function normalizeHex(input: string): Hex {
  if (input.startsWith('0x')) return input as Hex;
  return `0x${input}` as Hex;
}

function asBytes32(input: string): Hex {
  const h = normalizeHex(input);
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) {
    throw new Error(`Invalid bytes32: ${input}`);
  }
  return h;
}

function asAddress(input: string): Address {
  const h = normalizeHex(input);
  if (!/^0x[0-9a-fA-F]{40}$/.test(h)) {
    throw new Error(`Invalid address: ${input}`);
  }
  return h as Address;
}

function asBytes32Array(arr: string[]): Hex[] {
  return arr.map(asBytes32);
}

async function readPoolState(params: {
  publicClient: ReturnType<typeof createPublicClient>;
  swapRouterAddress: Address;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}): Promise<{
  manager: Address;
  poolId: Hex;
  sqrtPriceX96: bigint;
  liquidity: bigint;
} | null> {
  try {
    const managerAbi = parseAbi([
      'function manager() view returns (address)',
      'function extsload(bytes32 slot) view returns (bytes32)',
    ]);
    const manager = (await params.publicClient.readContract({
      address: params.swapRouterAddress,
      abi: managerAbi,
      functionName: 'manager',
    })) as Address;
    const poolId = keccak256(
      encodeAbiParameters(
        [
          { type: 'address' },
          { type: 'address' },
          { type: 'uint24' },
          { type: 'int24' },
          { type: 'address' },
        ],
        [params.currency0, params.currency1, params.fee, params.tickSpacing, params.hooks]
      )
    );
    const poolStateSlot = keccak256(
      encodePacked(['bytes32', 'uint256'], [poolId, POOLS_SLOT])
    );
    const poolState = (await params.publicClient.readContract({
      address: manager,
      abi: managerAbi,
      functionName: 'extsload',
      args: [poolStateSlot],
    })) as Hex;
    const sqrtPriceX96 = BigInt(poolState) & U160_MASK;
    const liquiditySlot = toHex(BigInt(poolStateSlot) + POOL_LIQUIDITY_OFFSET, {
      size: 32,
    });
    const liquidityWord = (await params.publicClient.readContract({
      address: manager,
      abi: managerAbi,
      functionName: 'extsload',
      args: [liquiditySlot],
    })) as Hex;
    const liquidity = BigInt(liquidityWord) & U128_MASK;
    return { manager, poolId, sqrtPriceX96, liquidity };
  } catch {
    return null;
  }
}

const hookPayloadParams = [
  {
    name: 'payload',
    type: 'tuple',
    components: [
      { name: 'roundId', type: 'bytes32' },
      { name: 'matchIdHash', type: 'bytes32' },
      { name: 'trader', type: 'address' },
      { name: 'counterparty', type: 'address' },
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'expiry', type: 'uint256' },
      { name: 'proof', type: 'bytes32[]' },
      { name: 'signature', type: 'bytes' },
    ],
  },
] as const;

export function encodeHookPayload(args: {
  roundId: Hex;
  matchIdHash: Hex;
  trader: Address;
  counterparty: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  expiry: bigint;
  merkleProof: Hex[];
  signature: Hex;
}): Hex {
  return encodeAbiParameters(
    hookPayloadParams,
    [
      {
        roundId: args.roundId,
        matchIdHash: args.matchIdHash,
        trader: args.trader,
        counterparty: args.counterparty,
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        amountIn: args.amountIn,
        minAmountOut: args.minAmountOut,
        expiry: args.expiry,
        proof: args.merkleProof,
        signature: args.signature,
      },
    ]
  ) as Hex;
}

export function normalizeHookDataInput(input: unknown): HookData {
  if (!input || typeof input !== 'object') {
    throw new Error('Hook data must be an object');
  }

  const obj = input as Record<string, unknown>;

  const matchIdRaw = obj.matchId;
  const matchId = typeof matchIdRaw === 'string' ? matchIdRaw : '';
  if (!matchId.trim()) {
    throw new Error('Missing matchId');
  }

  const roundId = asBytes32(String(obj.roundId ?? ''));
  const matchIdHash = asBytes32(String(obj.matchIdHash ?? ''));
  const trader = asAddress(String(obj.trader ?? ''));
  const counterparty = asAddress(String(obj.counterparty ?? ''));
  const tokenIn = asAddress(String(obj.tokenIn ?? ''));
  const tokenOut = asAddress(String(obj.tokenOut ?? ''));

  let amountIn: bigint;
  try {
    amountIn = BigInt(String(obj.amountIn ?? ''));
  } catch {
    throw new Error('Invalid amountIn (expected integer string)');
  }

  let minAmountOut: bigint;
  try {
    minAmountOut = BigInt(String(obj.minAmountOut ?? ''));
  } catch {
    throw new Error('Invalid minAmountOut (expected integer string)');
  }

  const expiryRaw = obj.expiry;
  let expirySeconds: bigint;
  try {
    if (typeof expiryRaw === 'bigint') expirySeconds = expiryRaw;
    else if (typeof expiryRaw === 'number') expirySeconds = BigInt(Math.trunc(expiryRaw));
    else expirySeconds = BigInt(String(expiryRaw ?? ''));
  } catch {
    throw new Error('Invalid expiry (expected unix seconds)');
  }
  if (expirySeconds < 0n) throw new Error('Invalid expiry (must be >= 0)');
  if (expirySeconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid expiry (too large)');

  const merkleProofRaw = obj.merkleProof;
  if (!Array.isArray(merkleProofRaw)) {
    throw new Error('Invalid merkleProof (expected bytes32[])');
  }
  const merkleProof = asBytes32Array(merkleProofRaw.map((x) => String(x)));

  const signatureRaw = String(obj.signature ?? '');
  const signature = normalizeHex(signatureRaw);
  if (!/^0x[0-9a-fA-F]+$/.test(signature) || signature.length < 4) {
    throw new Error('Invalid signature (expected hex string)');
  }

  const encodedHookData = encodeHookPayload({
    roundId,
    matchIdHash,
    trader,
    counterparty,
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
    expiry: expirySeconds,
    merkleProof,
    signature,
  });

  return {
    roundId,
    matchId,
    matchIdHash,
    trader,
    counterparty,
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    minAmountOut: minAmountOut.toString(),
    expiry: Number(expirySeconds),
    merkleProof,
    signature,
    encodedHookData,
  };
}

function computeRoundStartSeconds(timestampSeconds: bigint, durationSeconds: bigint): bigint {
  if (durationSeconds <= 0n) return 0n;
  return (timestampSeconds / durationSeconds) * durationSeconds;
}

function computeRoundId(namespace: Hex, roundStartSeconds: bigint): Hex {
  return keccak256(encodePacked(['bytes32', 'uint256'], [namespace, roundStartSeconds])) as Hex;
}

async function getRoundConfig(intentRegistryAddress: Address, publicClient: Awaited<ReturnType<typeof getViemClients>>['publicClient']) {
  const namespaceAbi = parseAbi(['function namespace() view returns (bytes32)']);
  const durationSecondsAbi = parseAbi(['function durationSeconds() view returns (uint256)']);
  const intakeWindowSecondsAbi = parseAbi(['function intakeWindowSeconds() view returns (uint256)']);

  const [namespaceHex, durationHex, intakeHex] = await Promise.all([
    publicClient.request({
      method: 'eth_call',
      params: [{ to: intentRegistryAddress, data: encodeFunctionData({ abi: namespaceAbi, functionName: 'namespace' }) }, 'latest'],
    }),
    publicClient.request({
      method: 'eth_call',
      params: [{ to: intentRegistryAddress, data: encodeFunctionData({ abi: durationSecondsAbi, functionName: 'durationSeconds' }) }, 'latest'],
    }),
    publicClient.request({
      method: 'eth_call',
      params: [
        { to: intentRegistryAddress, data: encodeFunctionData({ abi: intakeWindowSecondsAbi, functionName: 'intakeWindowSeconds' }) },
        'latest',
      ],
    }),
  ]);

  const namespace = decodeFunctionResult({ abi: namespaceAbi, functionName: 'namespace', data: namespaceHex as Hex });
  const durationSeconds = decodeFunctionResult({ abi: durationSecondsAbi, functionName: 'durationSeconds', data: durationHex as Hex });
  const intakeWindowSeconds = decodeFunctionResult({ abi: intakeWindowSecondsAbi, functionName: 'intakeWindowSeconds', data: intakeHex as Hex });

  return {
    namespace: namespace as Hex,
    durationSeconds: durationSeconds as bigint,
    intakeWindowSeconds: intakeWindowSeconds as bigint,
  };
}

function toRoundPhase(args: {
  nowSeconds: bigint;
  roundStartSeconds: bigint;
  durationSeconds: bigint;
  intakeWindowSeconds: bigint;
  root?: Hex;
  rootValidUntil?: bigint;
  postEndMatchingSeconds?: bigint;
}): Round['phase'] {
  const roundEnd = args.roundStartSeconds + args.durationSeconds;
  const inRound = args.nowSeconds < roundEnd;
  const inIntake = inRound && (args.nowSeconds - args.roundStartSeconds) < args.intakeWindowSeconds;
  if (inIntake) return 'intake';
  if (inRound) return 'matching';

  const hasRoot = typeof args.root === 'string' && args.root !== '0x0000000000000000000000000000000000000000000000000000000000000000';
  const isActive =
    hasRoot &&
    typeof args.rootValidUntil === 'bigint' &&
    args.rootValidUntil > 0n &&
    args.nowSeconds <= args.rootValidUntil;
  if (isActive) return 'executable';
  if (!hasRoot) {
    const postEndMatchingSeconds = args.postEndMatchingSeconds ?? 0n;
    if (postEndMatchingSeconds > 0n && args.nowSeconds < roundEnd + postEndMatchingSeconds) {
      return 'matching';
    }
  }
  return 'completed';
}

function upsertMockMatches(next: Match[]) {
  const byId = new Map(MOCK_MATCHES.map((m) => [m.id, m]));
  for (const m of next) {
    const existing = byId.get(m.id);
    if (!existing) {
      byId.set(m.id, m);
      continue;
    }
    const merged: Match = {
      ...m,
      signature: m.signature || existing.signature,
      leaf: m.leaf || existing.leaf,
      merkleProof:
        Array.isArray(m.merkleProof) && m.merkleProof.length > 0
          ? m.merkleProof
          : existing.merkleProof,
      executed: existing.executed || m.executed,
      executedAt: existing.executedAt ?? m.executedAt,
      executionTxHash: existing.executionTxHash ?? m.executionTxHash,
    };
    byId.set(m.id, merged);
  }
  MOCK_MATCHES.splice(0, MOCK_MATCHES.length, ...Array.from(byId.values()));
}

/**
 * Protect intent data by encrypting it via iExec DataProtector
 * Returns a protectedDataAddress that can be used for granting access
 */
export async function protectData(
  intent: Omit<Intent, 'id' | 'status' | 'createdAt' | 'protectedDataAddress'>,
  trader: string
): Promise<{ protectedDataAddress: string; salt: string }> {
  await ensureArbitrumSepoliaChain();
  const expirySeconds = Math.floor(intent.expiry.getTime() / 1000);
  const salt = generateHexString(32);

  const tokenPairData: DataObject = {
    base: {
      symbol: intent.tokenPair.base.symbol,
      name: intent.tokenPair.base.name,
      address: intent.tokenPair.base.address,
      decimals: intent.tokenPair.base.decimals,
    } as DataObject,
    quote: {
      symbol: intent.tokenPair.quote.symbol,
      name: intent.tokenPair.quote.name,
      address: intent.tokenPair.quote.address,
      decimals: intent.tokenPair.quote.decimals,
    } as DataObject,
  };

  const protectedData = await getDataProtectorCore().protectData({
    name: 'iExec ShadowPool Intent',
    data: {
      version: '1',
      trader,
      side: intent.side,
      baseToken: intent.tokenPair.base.address,
      quoteToken: intent.tokenPair.quote.address,
      amountBase: intent.amount,
      limitPrice: intent.limitPrice,
      expiry: expirySeconds,
      salt,
      tokenPair: tokenPairData,
      slippageMin: intent.slippageMin,
      slippageMax: intent.slippageMax,
      notes: intent.notes,
    },
  });

  return { protectedDataAddress: protectedData.address, salt };
}

function computeIntentCommitment(args: {
  side: 'buy' | 'sell';
  trader: Address;
  baseToken: Address;
  quoteToken: Address;
  amountBase: string;
  baseDecimals: number;
  limitPrice: string;
  expirySeconds: bigint;
  saltBytes32: Hex;
}): Hex {
  const sideAsUint8 = args.side === 'buy' ? 0 : 1;
  const amountBaseWei = parseUnits(args.amountBase, args.baseDecimals);
  const limitPriceWad = parseUnits(args.limitPrice, 18);

  return keccak256(
    encodeAbiParameters(
      [
        { name: 'sideAsUint8', type: 'uint8' },
        { name: 'trader', type: 'address' },
        { name: 'baseToken', type: 'address' },
        { name: 'quoteToken', type: 'address' },
        { name: 'amountBaseWei', type: 'uint256' },
        { name: 'limitPriceWad', type: 'uint256' },
        { name: 'expirySeconds', type: 'uint64' },
        { name: 'saltBytes32', type: 'bytes32' },
      ],
      [
        sideAsUint8,
        args.trader,
        args.baseToken,
        args.quoteToken,
        amountBaseWei,
        limitPriceWad,
        args.expirySeconds,
        args.saltBytes32,
      ]
    )
  ) as Hex;
}

/**
 * Grant access to the protected data for the TEE app and authorized user
 */
export async function grantAccess(
  protectedDataAddress: string,
  authorizedApp: string,
  authorizedUser: string
): Promise<{ success: boolean; grantId: string }> {
  await ensureArbitrumSepoliaChain();
  let granted: unknown;
  try {
    granted = await getDataProtectorCore().grantAccess({
      protectedData: protectedDataAddress,
      authorizedApp,
      authorizedUser,
      allowBulk: true,
      pricePerAccess: 0,
    });
  } catch (err) {
    throw new Error(formatRpcError(err));
  }

  const grantId =
    (granted as { address?: string; id?: string; orderHash?: string }).address ??
    (granted as { address?: string; id?: string; orderHash?: string }).id ??
    (granted as { address?: string; id?: string; orderHash?: string }).orderHash ??
    generateHexString(32);

  return { success: true, grantId };
}

/**
 * Submit protected data to a specific round
 */
export async function submitToRound(
  protectedDataAddress: string,
  roundId: string,
  commitmentInput?: {
    side: 'buy' | 'sell';
    baseToken: string;
    quoteToken: string;
    baseDecimals: number;
    amountBase: string;
    limitPrice: string;
    expirySeconds: number;
    saltBytes32: string;
  }
): Promise<{ success: boolean; position: number }> {
  await ensureArbitrumSepoliaChain();
  const intentRegistryAddress = getIntentRegistryAddress();
  if (!intentRegistryAddress) {
    throw new Error('Missing VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS');
  }

  const roundIdBytes32 = toRoundIdBytes32(roundId);
  const { publicClient, walletClient, account } = await getViemClients();

  const abi = parseAbi([
    'function registerIntent(bytes32 roundId, address protectedData, bytes32 commitment) external returns (uint256)',
  ]);

  const commitment = commitmentInput
    ? computeIntentCommitment({
        side: commitmentInput.side,
        trader: account,
        baseToken: commitmentInput.baseToken as Address,
        quoteToken: commitmentInput.quoteToken as Address,
        amountBase: commitmentInput.amountBase,
        baseDecimals: commitmentInput.baseDecimals,
        limitPrice: commitmentInput.limitPrice,
        expirySeconds: BigInt(commitmentInput.expirySeconds),
        saltBytes32: commitmentInput.saltBytes32 as Hex,
      })
    : (keccak256(
        encodeAbiParameters(
          [
            { name: 'roundId', type: 'bytes32' },
            { name: 'protectedData', type: 'address' },
          ],
          [roundIdBytes32, protectedDataAddress as Address]
        )
      ) as Hex);

  const { request, result } = await publicClient.simulateContract({
    address: intentRegistryAddress,
    abi,
    functionName: 'registerIntent',
    args: [roundIdBytes32, protectedDataAddress as Address, commitment],
    account,
  });

  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    throw new Error(`registerIntent reverted (tx=${txHash})`);
  }
  return { success: true, position: Number(result) };
}

/**
 * Run the batch matching round in the TEE
 * This simulates the iExec TEE app processing all intents and finding matches
 */
export async function runBatchRound(
  roundId: string,
  protectedDataAddresses: string[]
): Promise<{ matches: Match[]; matchCount: number; merkleRoot?: string; roundExpiry?: number }> {
  await ensureArbitrumSepoliaChain();
  const core = getDataProtectorCore();

  const accessResults = await Promise.all(
    protectedDataAddresses.map(async (addr) => {
      try {
        return await core.getGrantedAccess({
          protectedData: addr,
          authorizedApp: getIExecAppAddress(),
          authorizedUser: getViemAccountAddress(),
          bulkOnly: true,
          pageSize: 1000,
        });
      } catch {
        return { grantedAccess: [] as unknown[] };
      }
    })
  );
  const bulkAccesses = accessResults.flatMap((res) => (Array.isArray(res?.grantedAccess) ? res.grantedAccess : []));

  if (bulkAccesses.length === 0) {
    return { matches: [], matchCount: 0 };
  }

  let commitmentsByProtectedData: Record<string, string> | undefined;
  if (getIntentRegistryAddress()) {
    try {
      const refs = await getRoundIntents(roundId);
      const map: Record<string, string> = {};
      for (const r of refs) {
        if (typeof r.protectedData !== 'string' || typeof r.commitment !== 'string') continue;
        map[r.protectedData.toLowerCase()] = r.commitment;
      }
      if (Object.keys(map).length > 0) commitmentsByProtectedData = map;
    } catch {
      commitmentsByProtectedData = undefined;
    }
  }

  const { bulkRequest } = await core.prepareBulkRequest({
    bulkAccesses,
    app: getIExecAppAddress(),
    args: JSON.stringify({ roundId, commitmentsByProtectedData: commitmentsByProtectedData ?? null }),
    encryptResult: false,
    maxProtectedDataPerTask: 100,
  });

  const { tasks } = await core.processBulkRequest({
    bulkRequest,
    waitForResult: true,
  });

  const decoder = new TextDecoder();
  const matches: Match[] = [];
  let merkleRoot: string | undefined;
  let roundExpiry: number | undefined;

  for (const t of tasks as Array<Record<string, unknown>>) {
    const result = t.result as ArrayBuffer | undefined;
    if (!(result instanceof ArrayBuffer)) continue;
    const text = decoder.decode(new Uint8Array(result));
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      continue;
    }

    if (!json || typeof json !== 'object') continue;
    const obj = json as Record<string, unknown>;

    if (typeof obj.merkleRoot === 'string') merkleRoot = obj.merkleRoot;
    if (typeof obj.roundExpiry === 'number') roundExpiry = obj.roundExpiry;

    const out = Array.isArray(obj.matches) ? obj.matches : [];
    for (const m of out) {
      if (!m || typeof m !== 'object') continue;
      const mo = m as Record<string, unknown>;
      if (typeof mo.matchId !== 'string') continue;
      if (typeof mo.matchIdHash !== 'string') continue;
      if (typeof mo.trader !== 'string') continue;
      if (typeof mo.counterparty !== 'string') continue;
      if (typeof mo.tokenIn !== 'string') continue;
      if (typeof mo.tokenOut !== 'string') continue;

      const tokenInAddress = mo.tokenIn as string;
      const tokenOutAddress = mo.tokenOut as string;
      const proofRaw = (Array.isArray(mo.merkleProof) ? mo.merkleProof : Array.isArray(mo.proof) ? mo.proof : []) as unknown[];
      const proof = proofRaw.filter((x): x is string => typeof x === 'string');
      const signature = typeof mo.signature === 'string' ? mo.signature : null;
      const leaf = typeof mo.leaf === 'string' ? mo.leaf : undefined;
      const traderProtectedDataAddress =
        typeof mo.traderProtectedDataAddress === 'string' ? (mo.traderProtectedDataAddress as string) : undefined;
      const counterpartyProtectedDataAddress =
        typeof mo.counterpartyProtectedDataAddress === 'string'
          ? (mo.counterpartyProtectedDataAddress as string)
          : undefined;

      const match: Match = {
        id: mo.matchId,
        roundId,
        trader: mo.trader,
        counterparty: mo.counterparty,
        tokenIn: { symbol: 'TKN', name: 'Token', address: tokenInAddress, decimals: 18 },
        tokenOut: { symbol: 'TKN', name: 'Token', address: tokenOutAddress, decimals: 18 },
        amountIn: typeof mo.amountIn === 'string' ? mo.amountIn : String(mo.amountIn),
        minAmountOut: typeof mo.minAmountOut === 'string' ? mo.minAmountOut : String(mo.minAmountOut),
        expiry: new Date((Number(mo.expiry) || 0) * 1000),
        matchIdHash: mo.matchIdHash,
        leaf,
        merkleProof: proof,
        signature: signature ?? undefined,
        traderProtectedDataAddress,
        counterpartyProtectedDataAddress,
        proofAvailable:
          proof.length > 0 &&
          typeof mo.matchIdHash === 'string' &&
          (typeof signature === 'string' || typeof leaf === 'string'),
        executed: false,
      };

      matches.push(match);
    }
  }

  upsertMockMatches(matches);

  return {
    matches,
    matchCount: matches.length,
    merkleRoot,
    roundExpiry,
  };
}

type FetchRelayerMode = 'public' | 'private';

type RelayerFetchResult = {
  matches: Match[];
  merkleRoot?: string;
  roundExpiry?: number;
  matchCount?: number;
};

const privateMatchesAuthCache = new Map<string, { signature: string; timestamp: number }>();
const PRIVATE_MATCHES_TTL_SECONDS = Number(
  import.meta.env.VITE_PRIVATE_MATCHES_TTL_SECONDS ?? 60 * 60 * 24 * 7
);
const PRIVATE_MATCHES_STORAGE_PREFIX = 'shadowpool:matches-auth:';

function loadPrivateMatchesAuth(address: string) {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${PRIVATE_MATCHES_STORAGE_PREFIX}${address}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { signature?: string; timestamp?: number };
    if (typeof parsed.signature !== 'string' || typeof parsed.timestamp !== 'number') return null;
    return { signature: parsed.signature, timestamp: parsed.timestamp };
  } catch {
    return null;
  }
}

function savePrivateMatchesAuth(address: string, signature: string, timestamp: number) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      `${PRIVATE_MATCHES_STORAGE_PREFIX}${address}`,
      JSON.stringify({ signature, timestamp })
    );
  } catch {
    return;
  }
}

async function getPrivateMatchesAuth(roundId: string) {
  const { walletClient, account } = await getViemClients();
  const address = account;
  const cacheKey = address.toLowerCase();
  const cached = privateMatchesAuthCache.get(cacheKey) ?? loadPrivateMatchesAuth(cacheKey);
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.timestamp < PRIVATE_MATCHES_TTL_SECONDS) {
    return { address, signature: cached.signature, timestamp: cached.timestamp };
  }

  const message = `shadowpool:matches:${address}:${now}`;
  const signature = await walletClient.signMessage({
    account,
    message,
  });
  privateMatchesAuthCache.set(cacheKey, { signature, timestamp: now });
  savePrivateMatchesAuth(cacheKey, signature, now);
  return { address, signature, timestamp: now };
}

export async function fetchRelayerMatches(
  roundId: string,
  opts: { mode?: FetchRelayerMode } = {}
): Promise<RelayerFetchResult | null> {
  const mode = opts.mode ?? 'public';
  const backoffKey = `${mode}:${roundId}`;
  const nowMs = Date.now();
  const nextAllowed = relayerFetchBackoff.get(backoffKey);
  if (nextAllowed && nowMs < nextAllowed) {
    return null;
  }
  const base = import.meta.env.VITE_MATCHES_API_BASE ?? '';
  const apiUrl =
    mode === 'private'
      ? `${base}/api/rounds/${roundId}/matches/private`
      : `${base}/api/rounds/${roundId}/matches`;
  const fallbackUrl = `/relayer/${roundId}.json`;
  try {
    let res: Response;
    if (mode === 'private') {
      const auth = await getPrivateMatchesAuth(roundId);
      res = await fetch(apiUrl, {
        cache: 'no-store',
        headers: {
          'x-shadowpool-address': auth.address,
          'x-shadowpool-signature': auth.signature,
          'x-shadowpool-timestamp': String(auth.timestamp),
        },
      });
    } else {
      res = await fetch(apiUrl, { cache: 'no-store' });
      if (!res.ok) {
        res = await fetch(fallbackUrl, { cache: 'no-store' });
      }
    }

    if (!res.ok) {
      const backoffMs = res.status === 404 ? 20000 : 10000;
      relayerFetchBackoff.set(backoffKey, Date.now() + backoffMs);
      return null;
    }
    relayerFetchBackoff.delete(backoffKey);
    const payload = (await res.json()) as Record<string, unknown>;
    const rawMatches = Array.isArray(payload.matches) ? payload.matches : [];
    const merkleRoot = typeof payload.merkleRoot === 'string' ? payload.merkleRoot : undefined;
    const roundExpiry = typeof payload.roundExpiry === 'number' ? payload.roundExpiry : undefined;
    const matchCount =
      typeof payload.matchesCount === 'number' ? payload.matchesCount : rawMatches.length;

    if (mode === 'public' || rawMatches.length === 0) {
      return { matches: [], merkleRoot, roundExpiry, matchCount };
    }

    const tokenLabelMap = new Map<string, { symbol: string; name: string; decimals: number }>();
    const addLabel = (addr?: string | null, symbol?: string | null, name?: string | null, decimals?: number) => {
      if (!addr || typeof addr !== 'string') return;
      const key = addr.toLowerCase();
      if (tokenLabelMap.has(key)) return;
      tokenLabelMap.set(key, {
        symbol: symbol?.trim() || 'TKN',
        name: name?.trim() || 'Token',
        decimals: Number.isFinite(decimals) ? (decimals as number) : 18,
      });
    };
    addLabel(import.meta.env.VITE_TOKEN_A_ADDRESS, 'TKA', 'TokenA', 18);
    addLabel(import.meta.env.VITE_TOKEN_B_ADDRESS, 'TKB', 'TokenB', 18);
    addLabel(import.meta.env.VITE_TOKEN_C_ADDRESS, 'TKC', 'TokenC', 18);
    addLabel(import.meta.env.VITE_TOKEN_D_ADDRESS, 'TKD', 'TokenD', 18);

    const unknownTokens = new Set<string>();
    for (const m of rawMatches) {
      if (!m || typeof m !== 'object') continue;
      const mo = m as Record<string, unknown>;
      const tokenInAddress = typeof mo.tokenIn === 'string' ? mo.tokenIn : '';
      const tokenOutAddress = typeof mo.tokenOut === 'string' ? mo.tokenOut : '';
      if (tokenInAddress) {
        const key = tokenInAddress.toLowerCase();
        if (!tokenLabelMap.has(key)) unknownTokens.add(tokenInAddress);
      }
      if (tokenOutAddress) {
        const key = tokenOutAddress.toLowerCase();
        if (!tokenLabelMap.has(key)) unknownTokens.add(tokenOutAddress);
      }
    }
    if (unknownTokens.size > 0) {
      const unknownList = Array.from(unknownTokens);
      const resolved = await Promise.all(unknownList.map((addr) => resolveTokenMetadata(addr)));
      resolved.forEach((meta, idx) => {
        if (!meta) return;
        const addr = unknownList[idx];
        if (!addr) return;
        tokenLabelMap.set(addr.toLowerCase(), meta);
      });
    }

    const matches: Match[] = [];
    for (const m of rawMatches) {
      if (!m || typeof m !== 'object') continue;
      const mo = m as Record<string, unknown>;
      const matchId = typeof mo.matchId === 'string' ? mo.matchId : null;
      if (!matchId) continue;
      const matchIdHash =
        typeof mo.matchIdHash === 'string'
          ? mo.matchIdHash
          : matchId
            ? keccak256(toBytes(matchId))
            : undefined;
      const tokenInAddress = typeof mo.tokenIn === 'string' ? mo.tokenIn : '';
      const tokenOutAddress = typeof mo.tokenOut === 'string' ? mo.tokenOut : '';
      const leaf = typeof mo.leaf === 'string' ? mo.leaf : undefined;
      const proofRaw = (Array.isArray(mo.merkleProof) ? mo.merkleProof : Array.isArray(mo.proof) ? mo.proof : []) as unknown[];
      const proof = proofRaw.filter((x): x is string => typeof x === 'string');
      const signature = typeof mo.signature === 'string' ? mo.signature : undefined;

      const tokenInLabel = tokenLabelMap.get(tokenInAddress.toLowerCase());
      const tokenOutLabel = tokenLabelMap.get(tokenOutAddress.toLowerCase());

      matches.push({
        id: matchId,
        roundId,
        trader: typeof mo.trader === 'string' ? mo.trader : '',
        counterparty: typeof mo.counterparty === 'string' ? mo.counterparty : undefined,
        traderProtectedDataAddress:
          typeof mo.traderProtectedDataAddress === 'string' ? mo.traderProtectedDataAddress : undefined,
        counterpartyProtectedDataAddress:
          typeof mo.counterpartyProtectedDataAddress === 'string'
            ? mo.counterpartyProtectedDataAddress
            : undefined,
        tokenIn: {
          symbol: tokenInLabel?.symbol ?? 'TKN',
          name: tokenInLabel?.name ?? 'Token',
          address: tokenInAddress,
          decimals: tokenInLabel?.decimals ?? 18,
        },
        tokenOut: {
          symbol: tokenOutLabel?.symbol ?? 'TKN',
          name: tokenOutLabel?.name ?? 'Token',
          address: tokenOutAddress,
          decimals: tokenOutLabel?.decimals ?? 18,
        },
        amountIn: typeof mo.amountIn === 'string' ? mo.amountIn : String(mo.amountIn ?? ''),
        minAmountOut: typeof mo.minAmountOut === 'string' ? mo.minAmountOut : String(mo.minAmountOut ?? ''),
        expiry: new Date((Number(mo.expiry) || 0) * 1000),
        matchIdHash,
        leaf,
        merkleProof: proof,
        signature,
        proofAvailable:
          proof.length > 0 &&
          typeof matchIdHash === 'string' &&
          (typeof signature === 'string' || typeof leaf === 'string'),
        executed: false,
      });
    }

    if (matches.length > 0) {
      upsertMockMatches(matches);
    }
    return { matches, merkleRoot, roundExpiry, matchCount };
  } catch {
    return null;
  }
}

/**
 * Post the merkle root on-chain
 */
export async function postRoundRoot(
  roundId: string,
  merkleRoot: string,
  expiry: number
): Promise<{ txHash: string; blockNumber: number }> {
  const rootRegistryAddress = getRootRegistryAddress();
  if (!rootRegistryAddress) {
    throw new Error('Missing VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS');
  }

  const roundIdBytes32 = toRoundIdBytes32(roundId);
  const { publicClient, walletClient, account } = await getViemClients();

  const abi = parseAbi([
    'function closeRound(bytes32 roundId) external',
    'function postRoot(bytes32 roundId, bytes32 root, uint256 validUntil) external',
  ]);

  const { request: closeRequest } = await publicClient.simulateContract({
    address: rootRegistryAddress,
    abi,
    functionName: 'closeRound',
    args: [roundIdBytes32],
    account,
  });
  const closeHash = await walletClient.writeContract(closeRequest);
  await publicClient.waitForTransactionReceipt({ hash: closeHash });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const validitySeconds = getRootValiditySeconds();
  const validUntil =
    Number.isFinite(expiry) && expiry > nowSeconds ? expiry : nowSeconds + validitySeconds;

  const { request: postRequest } = await publicClient.simulateContract({
    address: rootRegistryAddress,
    abi,
    functionName: 'postRoot',
    args: [roundIdBytes32, merkleRoot as Hex, BigInt(validUntil)],
    account,
  });
  const txHash = await walletClient.writeContract(postRequest);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, blockNumber: Number(receipt.blockNumber ?? 0n) };
}

/**
 * Generate hook data for a specific match
 */
export async function generateHookData(matchId: string): Promise<HookData> {
  console.log('[ShadowPool] Generating hook data for match:', matchId);
  
  const match = MOCK_MATCHES.find(m => m.id === matchId);
  if (!match) {
    throw new Error(`Match not found: ${matchId}`);
  }
  if (!match.matchIdHash || !match.counterparty || !match.merkleProof) {
    throw new Error(`Missing TEE proof data for match: ${matchId}`);
  }
  
  const roundId = toRoundIdBytes32(match.roundId);
  const trader = asAddress(match.trader);
  const counterparty = asAddress(match.counterparty);
  const tokenIn = asAddress(match.tokenIn.address);
  const tokenOut = asAddress(match.tokenOut.address);
  const amountIn = BigInt(match.amountIn.replace(/,/g, ''));
  const minAmountOut = BigInt(match.minAmountOut.replace(/,/g, ''));
  const expiry = BigInt(Math.floor(match.expiry.getTime() / 1000));
  const matchIdHash = asBytes32(match.matchIdHash);
  const merkleProof = asBytes32Array(match.merkleProof);
  const signature = match.signature ? normalizeHex(match.signature) : undefined;
  if (!signature) {
    throw new Error('Missing TEE signature for match. Relayer must sign the leaf.');
  }
  const encodedHookData = encodeHookPayload({
    roundId,
    matchIdHash,
    trader,
    counterparty,
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
    expiry,
    merkleProof,
    signature,
  });

  const decoded = decodeAbiParameters(hookPayloadParams, encodedHookData)[0] as unknown as {
    roundId: Hex;
    matchIdHash: Hex;
    trader: Address;
    counterparty: Address;
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    minAmountOut: bigint;
    expiry: bigint;
    proof: Hex[];
    signature: Hex;
  };
  if (
    decoded.roundId.toLowerCase() !== roundId.toLowerCase() ||
    decoded.matchIdHash.toLowerCase() !== matchIdHash.toLowerCase() ||
    decoded.trader.toLowerCase() !== trader.toLowerCase() ||
    decoded.counterparty.toLowerCase() !== counterparty.toLowerCase() ||
    decoded.tokenIn.toLowerCase() !== tokenIn.toLowerCase() ||
    decoded.tokenOut.toLowerCase() !== tokenOut.toLowerCase() ||
    decoded.amountIn !== amountIn ||
    decoded.minAmountOut !== minAmountOut ||
    decoded.expiry !== expiry ||
    decoded.proof.length !== merkleProof.length ||
    decoded.proof.some((x, i) => x.toLowerCase() !== merkleProof[i]!.toLowerCase()) ||
    decoded.signature.toLowerCase() !== signature.toLowerCase()
  ) {
    throw new Error('HookData ABI encoding mismatch');
  }
  
  const hookData: HookData = {
    roundId,
    matchId: match.id,
    matchIdHash,
    trader,
    counterparty,
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    minAmountOut: minAmountOut.toString(),
    expiry: Number(expiry),
    merkleProof,
    signature,
    encodedHookData,
  };
  
  console.log('[ShadowPool] Hook data generated:', hookData);
  
  return hookData;
}

/**
 * Execute trade via Uniswap v4 hook with merkle proof
 */
export async function executeTradeWithProof(hookData: HookData): Promise<ExecutionResult> {
  const swapRouterAddress = getSwapRouterAddress();
  if (!swapRouterAddress) {
    throw new Error('Missing VITE_POOL_SWAP_TEST_ADDRESS (or VITE_UNISWAP_V4_SWAP_ROUTER_ADDRESS)');
  }

  const hookAddress = getHookAddress();
  if (!hookAddress) {
    throw new Error('Missing VITE_SHADOWPOOL_HOOK_ADDRESS');
  }

  const { publicClient, walletClient, account } = await getViemClients();

  const tokenIn = asAddress(hookData.tokenIn);
  const tokenOut = asAddress(hookData.tokenOut);

  const addrA = tokenIn.toLowerCase();
  const addrB = tokenOut.toLowerCase();
  const currency0 = (addrA < addrB ? tokenIn : tokenOut) as Address;
  const currency1 = (addrA < addrB ? tokenOut : tokenIn) as Address;
  const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();

  const amountIn = BigInt(hookData.amountIn);
  const minAmountOut = BigInt(hookData.minAmountOut);

  // Uniswap v4 TickMath bounds (avoid hitting PriceLimitAlreadyExceeded)
  // TickMath.MIN_SQRT_PRICE = 4295128739
  // TickMath.MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342
  const MIN_PRICE_LIMIT = 4295128739n + 1n;
  const MAX_PRICE_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;

  const swapAbi = parseAbi([
    // PoolSwapTest returns BalanceDelta (int256). Using int128/int128 here causes decode errors.
    'function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,(bool takeClaims,bool settleUsingBurn) settings, bytes hookData) payable returns (int256 delta)',
    'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
    'error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)',
  ]);

  const erc20Abi = parseAbi([
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 value) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ]);

  const [balanceBefore, decimalsOut, tokenInBalance, decimalsIn] = await Promise.all([
    publicClient.readContract({
      address: tokenOut,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    }),
    publicClient.readContract({ address: tokenOut, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    }),
    publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'decimals' }),
  ]);

  if ((tokenInBalance as bigint) < amountIn) {
    const have = formatUnits(tokenInBalance as bigint, Number(decimalsIn));
    const need = formatUnits(amountIn, Number(decimalsIn));
    return {
      success: false,
      error: 'insufficient_balance',
      message: `Insufficient token balance. Need ${need}, have ${have}.`,
    };
  }

  let currentAllowance: bigint = 0n;
  currentAllowance = (await publicClient.readContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account, swapRouterAddress],
  })) as bigint;

  if (currentAllowance < amountIn) {
    try {
      const { request: approveRequest } = await publicClient.simulateContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: 'approve',
        args: [swapRouterAddress, amountIn],
        account,
      });
      const approveHash = await walletClient.writeContract(approveRequest);
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      currentAllowance = amountIn;
    } catch (err) {
      const baseMsg = formatRpcError(err);
      const normalized = baseMsg.toLowerCase();
      if (normalized.includes('user rejected') || normalized.includes('user rejected the request')) {
        return { success: false, error: 'token_error', message: 'Token approval was rejected in your wallet.' };
      }
      return { success: false, error: 'token_error', message: `Token approval failed. ${baseMsg}` };
    }
  }

  const fee = getPoolFee();
  const tickSpacing = getTickSpacing();

  const encodedHookData = hookData.encodedHookData as Hex;

  const hookCheckAbi = parseAbi([
    'function matchUsed(bytes32 roundId, bytes32 matchIdHash) view returns (bool used)',
  ]) as Abi;
  const alreadyUsed = await publicClient.readContract({
    address: hookAddress,
    abi: hookCheckAbi,
    functionName: 'matchUsed',
    args: [asBytes32(hookData.roundId), asBytes32(hookData.matchIdHash)],
  });
  if (alreadyUsed) {
    return {
      success: false,
      error: 'already_executed',
      message: 'This match was already executed.',
    };
  }

  const poolState = await readPoolState({
    publicClient,
    swapRouterAddress,
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks: hookAddress,
  });
  if (poolState && poolState.sqrtPriceX96 === 0n) {
    return {
      success: false,
      error: 'invalid_swap_params',
      message:
        'Pool not initialized for this key (token pair / fee / tickSpacing / hook). Check the swap router + hook addresses.',
    };
  }
  if (poolState && poolState.liquidity === 0n) {
    // Some deployments store liquidity in a different slot; avoid false negatives here
    // and let simulateContract verify actual swap viability.
    console.warn('[ShadowPool] Pool liquidity read as zero; continuing with simulation.');
  }

  try {
    const { request, result } = await publicClient.simulateContract({
      address: swapRouterAddress,
      abi: swapAbi,
      functionName: 'swap',
      args: [
        {
          currency0,
          currency1,
          fee,
          tickSpacing,
          hooks: hookAddress,
        },
        {
          zeroForOne,
          amountSpecified: -amountIn,
          sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT,
        },
        {
          takeClaims: false,
          settleUsingBurn: false,
        },
        encodedHookData,
      ],
      account,
    });

    if (typeof result === 'bigint') {
      const { amount0, amount1 } = decodeBalanceDelta(result);
      const expectedOut = zeroForOne ? amount1 : amount0;
      const expectedOutAbs = expectedOut < 0n ? -expectedOut : expectedOut;
      if (expectedOutAbs < minAmountOut) {
        const formattedOut = formatUnits(expectedOutAbs, Number(decimalsOut));
        const formattedMin = formatUnits(minAmountOut, Number(decimalsOut));
        return {
          success: false,
          error: 'insufficient_liquidity',
          message: `Expected output ${formattedOut} is below minAmountOut ${formattedMin}.`,
        };
      }
    }

    const txHash = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const balanceAfter = await publicClient.readContract({
      address: tokenOut,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    });

    const rawOut = (balanceAfter as bigint) - (balanceBefore as bigint);
    if (rawOut < minAmountOut) {
      return {
        success: false,
        error: 'insufficient_liquidity',
        message: 'Swap completed but output was below minAmountOut.',
      };
    }

    const used = await publicClient.readContract({
      address: hookAddress,
      abi: hookCheckAbi,
      functionName: 'matchUsed',
      args: [asBytes32(hookData.roundId), asBytes32(hookData.matchIdHash)],
    });

    if (!used) {
      return {
        success: false,
        error: 'invalid_proof',
        message: 'Swap executed but match was not marked as used by the hook.',
      };
    }

    const idx = MOCK_MATCHES.findIndex((m) => m.id === hookData.matchId);
    if (idx >= 0) {
      const prev = MOCK_MATCHES[idx];
      MOCK_MATCHES[idx] = { ...prev, executed: true, executedAt: new Date(), executionTxHash: txHash };
    }

    return {
      success: true,
      txHash,
      amountOut: formatUnits(rawOut, Number(decimalsOut)),
    };
  } catch (err) {
    console.error('[ShadowPool] swap failed', err);
    const maybeData =
      (err as { data?: unknown; cause?: { data?: unknown } })?.cause?.data ??
      (err as { data?: unknown }).data;
    if (
      maybeData &&
      typeof maybeData === 'object' &&
      'errorName' in maybeData &&
      (maybeData as { errorName?: unknown }).errorName === 'Panic'
    ) {
      const code = (maybeData as { args?: unknown[] }).args?.[0];
      if (code === 17n) {
        const have = formatUnits(tokenInBalance as bigint, Number(decimalsIn));
        const need = formatUnits(amountIn, Number(decimalsIn));
        const allowanceFmt = formatUnits(currentAllowance, Number(decimalsIn));
        return {
          success: false,
          error: 'token_error',
          message: `Token transfer failed (likely missing approval). Need ${need}, balance ${have}, allowance ${allowanceFmt}.`,
        };
      }
    }
    let hookErrorName: string | null = null;
    let decodedDetail = '';
    if (typeof maybeData === 'string' && maybeData.startsWith('0x')) {
      try {
        const decoded = decodeErrorResult({ abi: swapAbi, data: maybeData as Hex });
        if (decoded.errorName === 'WrappedError' && Array.isArray(decoded.args)) {
          const [, , reason] = decoded.args as [string, string, string, string];
          const mapped = typeof reason === 'string' ? HOOK_ERROR_SELECTORS[reason.toLowerCase()] : undefined;
          if (mapped) hookErrorName = mapped;
          decodedDetail = mapped
            ? `Hook revert: ${mapped}`
            : `WrappedError(${JSON.stringify(decoded.args)})`;
        } else if (decoded.errorName === 'PriceLimitAlreadyExceeded') {
          decodedDetail = 'PriceLimitAlreadyExceeded';
        } else {
          decodedDetail = `${decoded.errorName}(${JSON.stringify(decoded.args)})`;
        }
      } catch {
        decodedDetail = '';
      }
    }
    if (hookErrorName) {
      switch (hookErrorName) {
        case 'MatchAlreadyUsed':
        case 'LeafAlreadyUsed':
          return { success: false, error: 'already_executed', message: 'This match was already executed.' };
        case 'InvalidSignature':
          return {
            success: false,
            error: 'invalid_signature',
            message: 'Invalid TEE signature. Regenerate matches with relayer signing enabled.',
          };
        case 'InvalidProof':
          return { success: false, error: 'invalid_proof', message: 'Invalid merkle proof.' };
        case 'RootExpired':
        case 'MatchExpired':
          return { success: false, error: 'expired', message: 'This match is expired.' };
        case 'UnauthorizedCaller':
          return {
            success: false,
            error: 'unauthorized_caller',
            message: 'Swap router is not authorized in the hook.',
          };
        case 'MinAmountOutNotMet':
          return { success: false, error: 'insufficient_liquidity', message: 'Minimum output was not met.' };
        case 'InvalidSwapParams':
          return {
            success: false,
            error: 'invalid_swap_params',
            message: 'Invalid swap params for this pool.',
          };
        case 'InvalidTeeSigner':
          return {
            success: false,
            error: 'invalid_signature',
            message: 'TEE signer mismatch. Regenerate matches with the correct relayer key.',
          };
        default:
          break;
      }
    }
    const baseMsg = formatRpcError(err);
    const msg = [baseMsg, decodedDetail].filter(Boolean).join(' | ');
    const normalized = msg.toLowerCase();
    if (normalized.includes('insufficient funds') || normalized.includes('insufficient balance')) {
      return { success: false, error: 'token_error', message: 'Insufficient funds to execute this swap.' };
    }
    if (normalized.includes('user rejected') || normalized.includes('user rejected the request')) {
      return { success: false, error: 'token_error', message: 'Transaction was rejected in your wallet.' };
    }
    if (normalized.includes('invalidproof')) {
      return { success: false, error: 'invalid_proof', message: 'Invalid merkle proof.' };
    }
    if (normalized.includes('invalidsignature')) {
      return {
        success: false,
        error: 'invalid_signature',
        message: 'Invalid TEE signature. Regenerate matches with relayer signing enabled.',
      };
    }
    if (normalized.includes('rootexpired') || normalized.includes('matchexpired')) {
      return { success: false, error: 'expired', message: 'This match is expired.' };
    }
    if (normalized.includes('matchalreadyused') || normalized.includes('leafalreadyused')) {
      return { success: false, error: 'already_executed', message: 'This match was already executed.' };
    }
    if (normalized.includes('unauthorizedcaller')) {
      return {
        success: false,
        error: 'unauthorized_caller',
        message: 'Swap router is not authorized in the hook.',
      };
    }
    if (normalized.includes('minamountoutnotmet')) {
      return { success: false, error: 'insufficient_liquidity', message: 'Minimum output was not met.' };
    }
    if (normalized.includes('pricelimitalreadyexceeded')) {
      return {
        success: false,
        error: 'invalid_swap_params',
        message:
          'Price limit already exceeded. This usually means the pool is not initialized for the current key (token pair/fee/tickSpacing/hook) or you are using the wrong swap router.',
      };
    }
    return { success: false, error: 'invalid_proof', message: msg };
  }
}

export async function faucetMintTestTokens(args?: {
  amount?: string;
  tokenAddresses?: string[];
}): Promise<{ minted: Array<{ token: Address; txHash: Hex; amount: string; decimals: number }> }> {
  const { publicClient, walletClient, account } = await getViemClients();

  const tokens =
    Array.isArray(args?.tokenAddresses) && args?.tokenAddresses.length > 0
      ? args.tokenAddresses.map((x) => asAddress(String(x)))
      : getConfiguredTokenAddresses();

  if (tokens.length === 0) {
    throw new Error('No tokens configured (set VITE_TOKEN_A_ADDRESS / VITE_TOKEN_B_ADDRESS)');
  }

  const amountRaw = String(args?.amount ?? '1000');
  const amountNum = Number(amountRaw);
  if (!amountRaw.trim() || Number.isNaN(amountNum) || amountNum <= 0 || amountNum > 1000) {
    throw new Error('Invalid faucet amount');
  }

  const decimalsAbi = parseAbi(['function decimals() view returns (uint8)']);
  const mintAbi = parseAbi(['function mint(address to, uint256 amount)']);

  const minted: Array<{ token: Address; txHash: Hex; amount: string; decimals: number }> = [];

  for (const token of tokens) {
    const decimalsHex = await publicClient.request({
      method: 'eth_call',
      params: [{ to: token, data: encodeFunctionData({ abi: decimalsAbi, functionName: 'decimals' }) }, 'latest'],
    });
    const decimals = Number(decodeFunctionResult({ abi: decimalsAbi, functionName: 'decimals', data: decimalsHex as Hex }));
    const amountWei = parseUnits(amountRaw, decimals);

    const { request } = await publicClient.simulateContract({
      address: token,
      abi: mintAbi,
      functionName: 'mint',
      args: [account, amountWei],
      account,
    });

    const txHash = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    minted.push({ token, txHash, amount: amountRaw, decimals });
  }

  return { minted };
}

export async function getRounds(options?: { lookbackRounds?: number }): Promise<Round[]> {
  const intentRegistryAddress = getIntentRegistryAddress();
  if (!intentRegistryAddress) return [];

  const rootRegistryAddress = getRootRegistryAddress();
  const publicClient = await getPublicClientForReads();

  const { namespace, durationSeconds, intakeWindowSeconds } = await getRoundConfig(intentRegistryAddress, publicClient);
  const postEndMatchingSeconds = getPostEndMatchingSeconds();

  const lookbackRounds = Math.max(1, options?.lookbackRounds ?? 10);
  const block = await publicClient.getBlock();
  const nowSeconds = BigInt(block.timestamp);
  const currentRoundStartSeconds = computeRoundStartSeconds(nowSeconds, durationSeconds);

  const intentCountAbi = parseAbi(['function getIntentCount(bytes32 roundId) external view returns (uint256)']);
  const rootInfoAbi = rootRegistryAddress
    ? parseAbi([
        'function getRoundInfo(bytes32 roundId) external view returns (bytes32 root, uint256 validUntil, address matcher, bool rootLocked, bool roundClosed, bool rootActive)',
      ])
    : null;

  const planned = Array.from({ length: lookbackRounds }, (_, i) => {
    const roundStartSeconds = currentRoundStartSeconds - BigInt(i) * durationSeconds;
    const id = computeRoundId(namespace, roundStartSeconds);
    return { id, roundStartSeconds };
  });

  const intentCountCalls = planned.map(({ id }) => ({
    address: intentRegistryAddress,
    abi: intentCountAbi,
    functionName: 'getIntentCount' as const,
    args: [id] as const,
  }));
  const intentCountResults = await publicClient.multicall({ contracts: intentCountCalls });

  const rootInfoResults =
    rootRegistryAddress && rootInfoAbi
      ? await publicClient.multicall({
          contracts: planned.map(({ id }) => ({
            address: rootRegistryAddress,
            abi: rootInfoAbi,
            functionName: 'getRoundInfo' as const,
            args: [id] as const,
          })),
        })
      : null;

  return planned.map(({ id, roundStartSeconds }, idx) => {
    const countRes = intentCountResults[idx];
    const intentsCount =
      countRes && countRes.status === 'success' ? Number((countRes.result as unknown as bigint) ?? 0n) : 0;

    let root: Hex | undefined;
    let validUntil: bigint | undefined;
    const rootRes = rootInfoResults?.[idx];
    if (rootRes && rootRes.status === 'success') {
      const tuple = rootRes.result as unknown as [Hex, bigint, Address, boolean, boolean, boolean];
      root = tuple[0];
      validUntil = tuple[1];
    }

    const phase = toRoundPhase({
      nowSeconds,
      roundStartSeconds,
      durationSeconds,
      intakeWindowSeconds,
      root,
      rootValidUntil: validUntil,
      postEndMatchingSeconds,
    });

    return {
      id,
      phase,
      intentsCount,
      matchedCount: 0,
      startTime: new Date(Number(roundStartSeconds) * 1000),
      endTime: new Date(Number(roundStartSeconds + durationSeconds) * 1000),
      rootValidUntil: validUntil && validUntil > 0n ? new Date(Number(validUntil) * 1000) : undefined,
      merkleRoot: root && root !== '0x0000000000000000000000000000000000000000000000000000000000000000' ? root : undefined,
    };
  });
}

export async function getRoundIntents(roundId: string): Promise<RoundIntentRef[]> {
  return getRoundIntentsWithOptions(roundId);
}

export async function getRoundIntentsWithOptions(
  roundId: string,
  options?: {
    intentRegistryAddress?: Address | null;
    rootRegistryAddress?: Address | null;
    publicClient?: Awaited<ReturnType<typeof getPublicClientForReads>>;
    fromBlock?: bigint;
    chunkSize?: bigint;
  }
): Promise<RoundIntentRef[]> {
  const intentRegistryAddress = options?.intentRegistryAddress ?? getIntentRegistryAddress();
  const rootRegistryAddress = options?.rootRegistryAddress ?? getRootRegistryAddress();
  if (!intentRegistryAddress && !rootRegistryAddress) return [];

  const roundIdBytes32 = toRoundIdBytes32(roundId);
  const publicClient = options?.publicClient ?? (await getPublicClientForReads());
  const fromBlock = options?.fromBlock ?? getShadowPoolLogsFromBlock({ intentRegistry: intentRegistryAddress, rootRegistry: rootRegistryAddress });
  const chunkSize = options?.chunkSize ?? getShadowPoolLogsChunkSize();

  if (intentRegistryAddress) {
    const intentRegisteredEvent = parseAbiItem(
      'event IntentRegistered(bytes32 indexed roundId,address indexed trader,address indexed protectedData,bytes32 commitment,uint256 position,bytes32 intentId,uint256 timestamp)'
    );
    const abi = parseAbi([
      'function getIntentCount(bytes32 roundId) external view returns (uint256 count)',
      'function getIntentAt(bytes32 roundId, uint256 index) external view returns (address trader,address protectedData,bytes32 commitment,bytes32 intentId,uint64 timestamp)',
    ]) as Abi;
    let loggedIntentCount: number | undefined;

    try {
      const latestBlock = await publicClient.getBlockNumber();
      const logs = await getLogsChunked({
        publicClient,
        params: {
          address: intentRegistryAddress,
          event: intentRegisteredEvent,
          args: { roundId: roundIdBytes32 },
        },
        fromBlock,
        toBlock: latestBlock,
        chunkSize,
      });

      if (logs.length > 0) {
        const byPosition = new Map<number, RoundIntentRef>();
        for (const log of logs as unknown as Array<{
          args: {
            trader: Address;
            protectedData: Address;
            commitment: Hex;
            position: bigint;
            intentId: Hex;
            timestamp: bigint;
          };
        }>) {
          const position = Number(log.args.position);
          if (!Number.isFinite(position) || position <= 0) continue;
          const ts = Number(log.args.timestamp);
          byPosition.set(position, {
            roundId: roundIdBytes32,
            position,
            trader: log.args.trader,
            protectedData: log.args.protectedData,
            commitment: log.args.commitment,
            intentId: log.args.intentId,
            timestamp: Number.isFinite(ts) ? new Date(ts * 1000) : undefined,
          });
        }
        const intents = Array.from(byPosition.values());
        intents.sort((a, b) => a.position - b.position);
        if (intents.length > 0) {
          try {
            const count = await publicClient.readContract({
              address: intentRegistryAddress,
              abi,
              functionName: 'getIntentCount',
              args: [roundIdBytes32],
            });
            loggedIntentCount = Number((count as unknown as bigint) ?? 0n);
            if (loggedIntentCount <= intents.length) {
              return intents;
            }
          } catch {
            return intents;
          }
        }
      }
    } catch (err) {
      void err;
    }

    const count =
      typeof loggedIntentCount === 'number'
        ? loggedIntentCount
        : Number(
            await publicClient.readContract({
              address: intentRegistryAddress,
              abi,
              functionName: 'getIntentCount',
              args: [roundIdBytes32],
            })
          );
    const total = Number.isFinite(count) ? count : 0;
    if (total === 0) return [];

    const calls = Array.from({ length: total }, (_, i) => ({
      address: intentRegistryAddress,
      abi,
      functionName: 'getIntentAt' as const,
      args: [roundIdBytes32, BigInt(i)],
    }));

    const results = await publicClient.multicall({ contracts: calls });

    const intents: RoundIntentRef[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== 'success') continue;
      const value = r.result as unknown;
      let trader: Address;
      let protectedData: Address;
      let commitment: Hex;
      let intentId: Hex;
      let timestamp: bigint;
      if (Array.isArray(value)) {
        trader = value[0] as Address;
        protectedData = value[1] as Address;
        commitment = value[2] as Hex;
        intentId = value[3] as Hex;
        timestamp = value[4] as bigint;
      } else {
        const obj = value as {
          trader: Address;
          protectedData: Address;
          commitment: Hex;
          intentId: Hex;
          timestamp: bigint;
        };
        trader = obj.trader;
        protectedData = obj.protectedData;
        commitment = obj.commitment;
        intentId = obj.intentId;
        timestamp = obj.timestamp;
      }
      intents.push({
        roundId: roundIdBytes32,
        position: i + 1,
        trader,
        protectedData,
        commitment,
        intentId,
        timestamp: new Date(Number(timestamp) * 1000),
      });
    }

    if (total > 0 && intents.length === 0) {
      throw new Error(`Failed to fetch intents for round ${roundIdBytes32}`);
    }
    return intents;
  }

  const intentSubmittedEvent = parseAbiItem(
    'event IntentSubmitted(bytes32 indexed roundId,address indexed protectedData,uint256 position)'
  );

  try {
    const latestBlock = await publicClient.getBlockNumber();
    const logs = await getLogsChunked({
      publicClient,
      params: {
        address: rootRegistryAddress as Address,
        event: intentSubmittedEvent,
        args: { roundId: roundIdBytes32 },
      },
      fromBlock,
      toBlock: latestBlock,
      chunkSize,
    });

    if (logs.length > 0) {
      const blockNumbers = Array.from(
        new Set(
          (logs as unknown as Array<{ blockNumber?: bigint }>).map((l) => l.blockNumber).filter((x): x is bigint => typeof x === 'bigint')
        )
      );
      const blockTimes = new Map<bigint, number>();
      await Promise.allSettled(
        blockNumbers.map(async (bn) => {
          const block = await publicClient.getBlock({ blockNumber: bn });
          blockTimes.set(bn, Number(block.timestamp));
        })
      );

      const byPosition = new Map<number, RoundIntentRef>();
      for (const log of logs as unknown as Array<{
        args: { protectedData: Address; position: bigint };
        blockNumber?: bigint;
      }>) {
        const position = Number(log.args.position);
        if (!Number.isFinite(position) || position <= 0) continue;
        const ts = log.blockNumber != null ? blockTimes.get(log.blockNumber) : undefined;
        byPosition.set(position, {
          roundId: roundIdBytes32,
          position,
          protectedData: log.args.protectedData,
          timestamp: typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts * 1000) : undefined,
        });
      }
      const intents = Array.from(byPosition.values());
      intents.sort((a, b) => a.position - b.position);
      return intents;
    }
  } catch (err) {
    void err;
  }

  const abi = parseAbi([
    'function getIntentCount(bytes32 roundId) external view returns (uint256 count)',
    'function getIntentAt(bytes32 roundId, uint256 index) external view returns (address protectedData)',
  ]) as Abi;
  const count = await publicClient.readContract({
    address: rootRegistryAddress as Address,
    abi,
    functionName: 'getIntentCount',
    args: [roundIdBytes32],
  });
  const total = Number(count ?? 0n);
  if (total === 0) return [];

  const calls = Array.from({ length: total }, (_, i) => ({
    address: rootRegistryAddress as Address,
    abi,
    functionName: 'getIntentAt' as const,
    args: [roundIdBytes32, BigInt(i)],
  }));
  const results = await publicClient.multicall({ contracts: calls });

  const intents: RoundIntentRef[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== 'success') continue;
    const protectedData = r.result as Address;
    intents.push({
      roundId: roundIdBytes32,
      position: i + 1,
      protectedData,
    });
  }
  if (total > 0 && intents.length === 0) {
    throw new Error(`Failed to fetch intents for round ${roundIdBytes32}`);
  }
  return intents;
}

/**
 * Get active rounds
 */
export async function getActiveRounds(): Promise<Round[]> {
  const rounds = await getRounds();
  return rounds.filter((r) => r.phase !== 'completed');
}

/**
 * Get round by ID
 */
export async function getRound(roundId: string): Promise<Round | null> {
  const rounds = await getRounds();
  return rounds.find((r) => r.id === roundId) ?? null;
}

async function syncMatchesExecutionState(matches: Match[]): Promise<Match[]> {
  const hookAddress = getHookAddress();
  if (!hookAddress) return matches;

  let publicClient: Awaited<ReturnType<typeof getViemClients>>['publicClient'] | null = null;
  try {
    ({ publicClient } = await getViemClients());
  } catch {
    publicClient = null;
  }
  if (!publicClient) return matches;

  const hookAbi = parseAbi([
    'function matchUsed(bytes32 roundId, bytes32 matchIdHash) view returns (bool used)',
  ]) as Abi;

  const indexed: Array<{ index: number; roundId: Hex; matchIdHash: Hex }> = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m.matchIdHash) continue;
    try {
      indexed.push({
        index: i,
        roundId: toRoundIdBytes32(m.roundId),
        matchIdHash: asBytes32(m.matchIdHash),
      });
    } catch {
      continue;
    }
  }
  if (indexed.length === 0) return matches;

  const contracts = indexed.map((x) => ({
    address: hookAddress,
    abi: hookAbi,
    functionName: 'matchUsed' as const,
    args: [x.roundId, x.matchIdHash] as const,
  }));

  const results = await publicClient.multicall({ contracts });
  const next = matches.slice();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== 'success') continue;
    const used = Boolean(r.result);
    const idx = indexed[i].index;
    const prev = next[idx];
    if (!prev) continue;
    if (used && !prev.executed) {
      next[idx] = { ...prev, executed: true };
    }
  }

  upsertMockMatches(next);
  return next;
}

/**
 * Get matches for a round
 */
export async function getRoundMatches(roundId: string): Promise<Match[]> {
  await delay(300);
  const matches = MOCK_MATCHES.filter((m) => m.roundId === roundId);
  return await syncMatchesExecutionState(matches);
}

/**
 * Get available matches for execution (proof available, not executed)
 */
export async function getExecutableMatches(): Promise<Match[]> {
  await delay(300);
  const matches = MOCK_MATCHES.filter((m) => m.proofAvailable);
  const synced = await syncMatchesExecutionState(matches);
  return synced.filter((m) => !m.executed);
}

export type NagleMetrics = {
  status: 'idle' | 'running' | 'stopped';
  lastTickAt: number | null;
  rounds: {
    lastSuccessAt: number | null;
    lastErrorAt: number | null;
    consecutiveErrors: number;
    lastErrorMessage: string | null;
  };
  intents: {
    lastSuccessAt: number | null;
    lastErrorAt: number | null;
    consecutiveErrors: number;
    lastErrorMessage: string | null;
  };
};

export type NagleConfig = {
  tickMs?: number;
  roundsPollMs?: number;
  intentsPollMs?: number;
  intentsStaleMs?: number;
  lookbackRounds?: number;
  maxActiveRounds?: number;
  retries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

export async function nagleRetry<T>(
  fn: () => Promise<T>,
  opts?: { retries?: number; baseDelayMs?: number; maxDelayMs?: number }
): Promise<T> {
  const retries = Math.max(0, opts?.retries ?? 2);
  const baseDelayMs = Math.max(0, opts?.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(baseDelayMs, opts?.maxDelayMs ?? 2500);

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      const nextAttempt = attempt + 1;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * Math.min(250, backoff));
      await delay(backoff + jitter);
      attempt = nextAttempt;
    }
  }
}

type NagleRoundIntentsCache = {
  fetchedAt: number;
  intentsCount: number | null;
  data: RoundIntentRef[];
};

let nagleMetrics: NagleMetrics = {
  status: 'idle',
  lastTickAt: null,
  rounds: { lastSuccessAt: null, lastErrorAt: null, consecutiveErrors: 0, lastErrorMessage: null },
  intents: { lastSuccessAt: null, lastErrorAt: null, consecutiveErrors: 0, lastErrorMessage: null },
};

export function getNagleMetrics(): NagleMetrics {
  return nagleMetrics;
}

export function startNagle(options?: {
  config?: NagleConfig;
  fetchRounds?: (params?: Parameters<typeof getRounds>[0]) => Promise<Round[]>;
  fetchRoundIntents?: (roundId: string) => Promise<RoundIntentRef[]>;
  onRounds?: (rounds: Round[]) => void;
  onRoundIntents?: (roundId: string, intents: RoundIntentRef[]) => void;
  onMetrics?: (metrics: NagleMetrics) => void;
}): () => void {
  const cfg = options?.config ?? {};
  const tickMs = Math.max(250, cfg.tickMs ?? 1000);
  const roundsPollMs = Math.max(tickMs, cfg.roundsPollMs ?? 5000);
  const intentsPollMs = Math.max(tickMs, cfg.intentsPollMs ?? 4000);
  const intentsStaleMs = Math.max(intentsPollMs, cfg.intentsStaleMs ?? 15000);
  const lookbackRounds = Math.max(1, cfg.lookbackRounds ?? 12);
  const maxActiveRounds = Math.max(1, cfg.maxActiveRounds ?? 2);
  const retries = Math.max(0, cfg.retries ?? 2);
  const retryBaseDelayMs = Math.max(0, cfg.retryBaseDelayMs ?? 250);
  const retryMaxDelayMs = Math.max(retryBaseDelayMs, cfg.retryMaxDelayMs ?? 2500);

  const fetchRounds = options?.fetchRounds ?? getRounds;
  const fetchRoundIntents = options?.fetchRoundIntents ?? getRoundIntents;

  const roundIntentsCache = new Map<string, NagleRoundIntentsCache>();
  let lastRoundsAt = 0;
  let lastIntentsSweepAt = 0;
  let latestRounds: Round[] = [];
  let stopped = false;
  let inFlightRounds = false;
  const inFlightIntents = new Set<string>();

  const emitMetrics = () => {
    options?.onMetrics?.(nagleMetrics);
  };

  const updateRoundsError = (err: unknown) => {
    nagleMetrics = {
      ...nagleMetrics,
      rounds: {
        ...nagleMetrics.rounds,
        lastErrorAt: Date.now(),
        consecutiveErrors: nagleMetrics.rounds.consecutiveErrors + 1,
        lastErrorMessage: formatRpcError(err),
      },
    };
    emitMetrics();
  };

  const updateRoundsSuccess = () => {
    nagleMetrics = {
      ...nagleMetrics,
      rounds: {
        ...nagleMetrics.rounds,
        lastSuccessAt: Date.now(),
        consecutiveErrors: 0,
        lastErrorMessage: null,
      },
    };
    emitMetrics();
  };

  const updateIntentsError = (err: unknown) => {
    nagleMetrics = {
      ...nagleMetrics,
      intents: {
        ...nagleMetrics.intents,
        lastErrorAt: Date.now(),
        consecutiveErrors: nagleMetrics.intents.consecutiveErrors + 1,
        lastErrorMessage: formatRpcError(err),
      },
    };
    emitMetrics();
  };

  const updateIntentsSuccess = () => {
    nagleMetrics = {
      ...nagleMetrics,
      intents: {
        ...nagleMetrics.intents,
        lastSuccessAt: Date.now(),
        consecutiveErrors: 0,
        lastErrorMessage: null,
      },
    };
    emitMetrics();
  };

  const pickActiveRounds = (rounds: Round[]) => {
    const active = rounds.filter((r) => r.phase !== 'completed');
    active.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
    return active.slice(0, maxActiveRounds);
  };

  const shouldRefreshIntents = (round: Round, now: number) => {
    const cached = roundIntentsCache.get(round.id);
    if (!cached) return true;
    if (cached.intentsCount !== round.intentsCount) return true;
    if (now - cached.fetchedAt > intentsStaleMs) return true;
    return false;
  };

  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    nagleMetrics = { ...nagleMetrics, lastTickAt: now };
    emitMetrics();

    if (!inFlightRounds && now - lastRoundsAt >= roundsPollMs) {
      inFlightRounds = true;
      try {
        const rounds = await nagleRetry(
          () => fetchRounds({ lookbackRounds }),
          { retries, baseDelayMs: retryBaseDelayMs, maxDelayMs: retryMaxDelayMs }
        );
        if (stopped) return;
        latestRounds = rounds;
        lastRoundsAt = Date.now();
        options?.onRounds?.(rounds);
        updateRoundsSuccess();
      } catch (err) {
        updateRoundsError(err);
      } finally {
        inFlightRounds = false;
      }
    }

    if (now - lastIntentsSweepAt < intentsPollMs) return;
    lastIntentsSweepAt = now;

    const activeRounds = pickActiveRounds(latestRounds);
    for (const round of activeRounds) {
      if (stopped) return;
      if (inFlightIntents.has(round.id)) continue;
      if (!shouldRefreshIntents(round, now)) continue;
      inFlightIntents.add(round.id);
      try {
        const intents = await nagleRetry(
          () => fetchRoundIntents(round.id),
          { retries, baseDelayMs: retryBaseDelayMs, maxDelayMs: retryMaxDelayMs }
        );
        if (stopped) return;
        if (round.intentsCount > 0 && intents.length === 0) {
          throw new Error(`Unexpected empty intents for round ${round.id} (count=${round.intentsCount})`);
        }
        roundIntentsCache.set(round.id, { fetchedAt: Date.now(), intentsCount: round.intentsCount, data: intents });
        options?.onRoundIntents?.(round.id, intents);
        updateIntentsSuccess();
      } catch (err) {
        updateIntentsError(err);
      } finally {
        inFlightIntents.delete(round.id);
      }
    }
  };

  nagleMetrics = { ...nagleMetrics, status: 'running' };
  emitMetrics();

  void tick();
  const id = setInterval(() => {
    void tick();
  }, tickMs);

  return () => {
    stopped = true;
    clearInterval(id);
    nagleMetrics = { ...nagleMetrics, status: 'stopped' };
    emitMetrics();
  };
}

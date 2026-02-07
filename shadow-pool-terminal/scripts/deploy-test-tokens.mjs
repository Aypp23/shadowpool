import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { arbitrumSepolia } from 'viem/chains';
import { IExecDataProtector } from '@iexec/dataprotector';
import { IExec } from 'iexec';
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodePacked,
  http,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  parseUnits,
  toBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

dns.setDefaultResultOrder('ipv4first');

function parseDotEnv(raw) {
  const env = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asHexData(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  return null;
}

async function withTimeout(label, promise, ms) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withRetries(label, fn, { retries = 6, baseDelayMs = 1200 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        console.log(`${label}: retrying in ${delay}ms`);
        await sleep(delay);
      }
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function ensureFreeAppOrderPublished({ ethProvider, app }) {
  const iexec = new IExec({ ethProvider }, { allowExperimentalNetworks: true });

  const minTag = ['tee', 'scone'];
  const maxTag = ['tee', 'scone'];
  const appLower = String(app).toLowerCase();

  const hasFreeOrder = await withRetries(
    'fetchAppOrderbook',
    async () => {
      const book = await iexec.orderbook.fetchAppOrderbook({ app: appLower, minTag, maxTag });
      const orders = Array.isArray(book?.orders) ? book.orders : [];
      return orders.some((o) => {
        const order = o?.order;
        if (!order || typeof order !== 'object') return false;
        if (String(order.app).toLowerCase() !== appLower) return false;
        const price = Number(order.appprice ?? Number.NaN);
        return Number.isFinite(price) && price <= 0;
      });
    },
    { retries: 6, baseDelayMs: 1200 }
  );

  if (hasFreeOrder) return;

  await withRetries(
    'publishApporder',
    async () => {
      const tpl = await iexec.order.createApporder({ app: appLower, appprice: 0, volume: 1000000, tag: minTag });
      const signed = await iexec.order.signApporder(tpl);
      await iexec.order.publishApporder(signed, { preflightCheck: false });
    },
    { retries: 4, baseDelayMs: 1500 }
  );
}

function asNrlcBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (value && typeof value === 'object' && typeof value.toString === 'function') {
    const s = value.toString();
    if (typeof s === 'string' && /^\d+$/.test(s)) return BigInt(s);
  }
  return 0n;
}

async function ensureRequesterStake({ ethProvider, minStakeNrlc }) {
  const iexec = new IExec({ ethProvider }, { allowExperimentalNetworks: true });
  const minStake = asNrlcBigInt(minStakeNrlc);
  if (minStake <= 0n) return;

  const requesterAddress = await withRetries('getRequesterAddress', () => iexec.wallet.getAddress(), { retries: 2, baseDelayMs: 800 });
  const before = await withRetries('checkAccountBalance', () => iexec.account.checkBalance(requesterAddress), {
    retries: 2,
    baseDelayMs: 800,
  });
  const stakeBefore = asNrlcBigInt(before?.stake);
  if (stakeBefore >= minStake) return;

  const buffer = 100_000_000n;
  const toDeposit = minStake - stakeBefore + buffer;
  console.log(`Depositing to iExec account stake nRLC=${toDeposit.toString()}`);
  await withRetries('accountDeposit', () => iexec.account.deposit(toDeposit.toString()), { retries: 2, baseDelayMs: 1200 });

  const after = await withRetries('checkAccountBalance', () => iexec.account.checkBalance(requesterAddress), { retries: 2, baseDelayMs: 800 });
  const stakeAfter = asNrlcBigInt(after?.stake);
  console.log(`Requester stake after deposit nRLC=${stakeAfter.toString()}`);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRootEnvPath = path.resolve(__dirname, '../../.env');
if (!fs.existsSync(repoRootEnvPath)) {
  throw new Error(`Missing .env at ${repoRootEnvPath}`);
}

const env = parseDotEnv(fs.readFileSync(repoRootEnvPath, 'utf8'));
const privateKey = env.PRIVATE_KEY;
if (!privateKey || !isHex(privateKey)) {
  throw new Error('Missing or invalid PRIVATE_KEY in repo .env');
}

const argv = process.argv.slice(2);
const runE2E = argv.includes('--e2e');
const skipDeploy = argv.includes('--skip-deploy');
const skipTee = argv.includes('--skip-tee');
const verifyRefresh = argv.includes('--verify-refresh');

function readArgValue(name, defaultValue) {
  const prefix = `--${name}=`;
  const found = argv.find((a) => typeof a === 'string' && a.startsWith(prefix));
  if (!found) return defaultValue;
  return found.slice(prefix.length);
}

function readArgInt(name, defaultValue) {
  const raw = readArgValue(name, null);
  if (raw == null) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.max(0, Math.floor(n));
}

function readArgNumber(name, defaultValue) {
  const raw = readArgValue(name, null);
  if (raw == null) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultValue;
  return n;
}

const e2eBuyCount = readArgInt('e2e-buy-count', 1);
const e2eSellCount = readArgInt('e2e-sell-count', 1);
const e2eBuyAmount = readArgValue('e2e-buy-amount', '10');
const e2eSellAmount = readArgValue('e2e-sell-amount', '10');
const e2eLimitPrice = readArgValue('e2e-limit-price', '1');
const e2eSlippageMin = readArgNumber('e2e-slippage-min', 0.1);
const e2eSlippageMax = readArgNumber('e2e-slippage-max', 1);
const e2eScenario = readArgValue('e2e-scenario', '');

const rpcUrl =
  env.ARBITRUM_SEPOLIA_RPC_URL ||
  env.VITE_ALCHEMY_ARBITRUM_SEPOLIA_RPC_URL ||
  env.VITE_RPC_URL ||
  env.VITE_PUBLIC_RPC_URL;
if (!rpcUrl) {
  throw new Error('Missing ARBITRUM_SEPOLIA_RPC_URL (or VITE_ALCHEMY_ARBITRUM_SEPOLIA_RPC_URL) in .env');
}
const account = privateKeyToAccount(privateKey);
const iexecWorkerpool =
  env.IEXEC_WORKERPOOL_ADDRESS ||
  env.VITE_IEXEC_WORKERPOOL_ADDRESS ||
  '0xB967057a21dc6A66A29721d96b8Aa7454B7c383F';
const iexecWorkerpoolMaxPrice =
  Number(env.IEXEC_WORKERPOOL_MAX_PRICE_NRLC || env.VITE_IEXEC_WORKERPOOL_MAX_PRICE_NRLC || '1000000000');

const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
const walletClient = createWalletClient({ chain: arbitrumSepolia, transport: http(rpcUrl), account });

function getForgeBin() {
  const candidates = [
    env.FORGE_BIN,
    process.env.FORGE_BIN,
    process.env.HOME ? path.join(process.env.HOME, '.foundry', 'bin', 'forge') : null,
    'forge',
  ].filter(Boolean);

  for (const c of candidates) {
    if (c === 'forge') return c;
    if (typeof c === 'string' && fs.existsSync(c)) return c;
  }

  return 'forge';
}

function readLatestDeployBroadcast() {
  const hookProjectDir = path.resolve(__dirname, '../../shadowpool-hook');
  const broadcastPath = path.resolve(
    hookProjectDir,
    `broadcast/DeployShadowPool.s.sol/${arbitrumSepolia.id}/run-latest.json`
  );
  if (!fs.existsSync(broadcastPath)) return null;
  return JSON.parse(fs.readFileSync(broadcastPath, 'utf8'));
}

function runDeployScript() {
  const forgeBin = getForgeBin();
  const pk = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  const hookProjectDir = path.resolve(__dirname, '../../shadowpool-hook');

  const childEnv = {
    ...process.env,
    ...env,
  };
  if (runE2E) {
    childEnv.TEE_SIGNER_ADDRESS = account.address;
  }
  if (runE2E && !childEnv.ROUND_DURATION_SECONDS) {
    childEnv.ROUND_DURATION_SECONDS = '3600';
  }
  if (runE2E && !childEnv.ROUND_INTAKE_WINDOW_SECONDS) {
    childEnv.ROUND_INTAKE_WINDOW_SECONDS = childEnv.ROUND_DURATION_SECONDS || '3600';
  }

  const res = spawnSync(
    forgeBin,
    [
      'script',
      'script/DeployShadowPool.s.sol:DeployShadowPool',
      '--rpc-url',
      rpcUrl,
      '--broadcast',
      '--private-key',
      pk,
    ],
    {
      cwd: hookProjectDir,
      env: childEnv,
      stdio: 'inherit',
    }
  );

  if (res.status !== 0) {
    throw new Error(`forge script failed (exit ${res.status})`);
  }

  const broadcast = readLatestDeployBroadcast();
  if (!broadcast) throw new Error('Missing broadcast output for DeployShadowPool');
  return { broadcast, childEnv };
}

function extractEnvFromForgeBroadcast({ broadcast, childEnv }) {
  const out = {};

  const txs = (broadcast && typeof broadcast === 'object' && Array.isArray(broadcast.transactions)
    ? broadcast.transactions
    : []);
  const lastByName = (name) => {
    for (let i = txs.length - 1; i >= 0; i -= 1) {
      const t = txs[i];
      if (t && typeof t === 'object' && t.contractName === name && typeof t.contractAddress === 'string') return t;
    }
    return null;
  };

  const intentRegistry = lastByName('IntentRegistry');
  const rootRegistry = lastByName('ShadowPoolRootRegistry');
  const hook = lastByName('ShadowPoolHook');
  const swapRouter = lastByName('PoolSwapTest');

  const mockErc20s = txs.filter((t) => t && typeof t === 'object' && t.contractName === 'MockERC20');
  const tokenA = mockErc20s.find((t) => Array.isArray(t.arguments) && t.arguments[0] === 'TokenA');
  const tokenB = mockErc20s.find((t) => Array.isArray(t.arguments) && t.arguments[0] === 'TokenB');

  if (intentRegistry?.contractAddress) out.VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS = intentRegistry.contractAddress;
  if (rootRegistry?.contractAddress) out.VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS = rootRegistry.contractAddress;
  if (hook?.contractAddress) out.VITE_SHADOWPOOL_HOOK_ADDRESS = hook.contractAddress;
  if (swapRouter?.contractAddress) out.VITE_POOL_SWAP_TEST_ADDRESS = swapRouter.contractAddress;
  if (tokenA?.contractAddress) out.VITE_TOKEN_A_ADDRESS = tokenA.contractAddress;
  if (tokenB?.contractAddress) out.VITE_TOKEN_B_ADDRESS = tokenB.contractAddress;

  out.VITE_POOL_FEE = childEnv.POOL_FEE || childEnv.VITE_POOL_FEE || '0';
  out.VITE_POOL_TICK_SPACING = childEnv.POOL_TICK_SPACING || childEnv.VITE_POOL_TICK_SPACING || '60';

  return out;
}

const deployed = (() => {
  if (skipDeploy) {
    const broadcast = readLatestDeployBroadcast();
    if (!broadcast) return {};
    const extracted = extractEnvFromForgeBroadcast({ broadcast, childEnv: { ...process.env, ...env } });
    const pruned = {};
    for (const [k, v] of Object.entries(extracted)) {
      if (!k.startsWith('VITE_')) continue;
      if (env[k]) continue;
      pruned[k] = v;
    }
    return pruned;
  }
  return extractEnvFromForgeBroadcast(runDeployScript());
})();
const tokenA = deployed.VITE_TOKEN_A_ADDRESS ?? env.VITE_TOKEN_A_ADDRESS ?? env.TOKEN_A_ADDRESS ?? null;
const tokenB = deployed.VITE_TOKEN_B_ADDRESS ?? env.VITE_TOKEN_B_ADDRESS ?? env.TOKEN_B_ADDRESS ?? null;
if (!tokenA || !tokenB || !isAddress(tokenA) || !isAddress(tokenB)) {
  throw new Error('Missing token addresses (expected from DeployShadowPool output or .env VITE_TOKEN_{A,B}_ADDRESS)');
}

const intentRegistryAddress =
  deployed.VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS ?? env.VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS ?? null;
const rootRegistryAddress =
  deployed.VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS ?? env.VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS ?? null;
const hookAddress = deployed.VITE_SHADOWPOOL_HOOK_ADDRESS ?? env.VITE_SHADOWPOOL_HOOK_ADDRESS ?? null;
const swapRouterAddress = deployed.VITE_POOL_SWAP_TEST_ADDRESS ?? env.VITE_POOL_SWAP_TEST_ADDRESS ?? null;
const poolFeeRaw = deployed.VITE_POOL_FEE ?? env.VITE_POOL_FEE ?? null;
const tickSpacingRaw = deployed.VITE_POOL_TICK_SPACING ?? env.VITE_POOL_TICK_SPACING ?? null;

const traderKeys = [env.TEST_PRIVATE_KEY1, env.TEST_PRIVATE_KEY2].filter((x) => typeof x === 'string' && isHex(x));
if (runE2E && traderKeys.length < 2) {
  throw new Error('Missing TEST_PRIVATE_KEY1/TEST_PRIVATE_KEY2 in repo .env');
}
const traderAddresses = traderKeys.map((k) => privateKeyToAccount(k).address);

const erc20Abi = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
];

const transferAmount = 1_000n * 10n ** 18n;
const mintReceipts = [];
for (const token of [tokenA, tokenB]) {
  for (const to of traderAddresses) {
    const hash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'mint',
      args: [to, transferAmount],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    mintReceipts.push({
      token,
      to,
      txHash: hash,
      gasUsed: receipt.gasUsed?.toString?.() ?? null,
    });
  }
}

console.log('Deployed ShadowPool on Arbitrum Sepolia:');
for (const [k, v] of Object.entries(deployed)) {
  if (k.startsWith('VITE_')) console.log(`${k}=${v}`);
}

const iappDeploymentsPath = path.resolve(
  __dirname,
  '../../shadowpool-iapp/hello-world/cache/arbitrum-sepolia-testnet/deployments.json'
);
let iExecAppAddress =
  process.env.VITE_IEXEC_APP_ADDRESS ??
  env.VITE_IEXEC_APP_ADDRESS ??
  env.VITE_IEXEC_APP ??
  env.VITE_IEXEC_APP_WHITELIST ??
  null;
if (fs.existsSync(iappDeploymentsPath)) {
  try {
    const deployments = JSON.parse(fs.readFileSync(iappDeploymentsPath, 'utf8'));
    const sorted = Array.isArray(deployments)
      ? deployments
          .filter((d) => d && typeof d === 'object')
          .slice()
          .sort((a, b) => {
            const ta = Date.parse(String(a.date ?? '')) || 0;
            const tb = Date.parse(String(b.date ?? '')) || 0;
            return tb - ta;
          })
      : [];
    const best = sorted[0] ?? null;
    const app = best && typeof best.app === 'string' ? best.app : null;
    if (app) {
      console.log(`VITE_IEXEC_APP_ADDRESS=${app}`);
      iExecAppAddress = iExecAppAddress ?? app;
    }
  } catch {}
}

function createEip1193Provider({ privateKeyHex, rpcUrl: rpc }) {
  const acc = privateKeyToAccount(privateKeyHex);
  const transport = http(rpc);
  const publicClientLocal = createPublicClient({ chain: arbitrumSepolia, transport });
  const walletClientLocal = createWalletClient({ chain: arbitrumSepolia, transport, account: acc });

  return {
    request: async ({ method, params }) => {
      const p = Array.isArray(params) ? params : params ? [params] : [];
      if (method === 'eth_chainId') return `0x${arbitrumSepolia.id.toString(16)}`;
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [acc.address];
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;

      if (method === 'personal_sign') {
        const [a, b] = p;
        const rawCandidate = typeof a === 'string' ? a : typeof b === 'string' ? b : '';
        if (rawCandidate.startsWith('0x')) {
          return walletClientLocal.signMessage({ message: { raw: rawCandidate } });
        }
        return walletClientLocal.signMessage({ message: rawCandidate });
      }

      if (method === 'eth_sign') {
        const [, message] = p;
        if (typeof message !== 'string') throw new Error('Invalid eth_sign params');
        return walletClientLocal.signMessage({ message: { raw: message } });
      }

      if (method === 'eth_signTypedData_v4') {
        const [, typed] = p;
        const typedData = typeof typed === 'string' ? JSON.parse(typed) : typed;
        const domain = typedData?.domain ?? {};
        const primaryType = typedData?.primaryType;
        const types = typedData?.types ?? {};
        const message = typedData?.message ?? {};
        return walletClientLocal.signTypedData({ domain, types, primaryType, message });
      }

      if (method === 'eth_sendTransaction') {
        const [tx] = p;
        if (!tx || typeof tx !== 'object') throw new Error('Invalid eth_sendTransaction params');
        const from = String(tx.from ?? '').toLowerCase();
        if (from && from !== acc.address.toLowerCase()) throw new Error('eth_sendTransaction from mismatch');
        const hash = await walletClientLocal.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
          gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : undefined,
          maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined,
          nonce: tx.nonce ? BigInt(tx.nonce) : undefined,
        });
        return hash;
      }

      if (method === 'eth_getTransactionReceipt') {
        const [hash] = p;
        if (typeof hash !== 'string') throw new Error('Invalid eth_getTransactionReceipt params');
        return publicClientLocal.request({
          method: 'eth_getTransactionReceipt',
          params: [hash],
        });
      }

      if (method === 'eth_call') {
        const [tx, tag] = p;
        return publicClientLocal.request({
          method: 'eth_call',
          params: [tx, tag ?? 'latest'],
        });
      }

      return publicClientLocal.request({ method, params });
    },
    __shadowpool: {
      account: acc,
      publicClient: publicClientLocal,
      walletClient: walletClientLocal,
    },
  };
}

async function runShadowPoolE2E() {
  const timings = [];
  const totalStartMs = Date.now();
  const formatError = (err) => {
    if (!err) return null;
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  };
  const recordTiming = (label, startMs, ok, err) => {
    const elapsedMs = Date.now() - startMs;
    const entry = { label, ms: elapsedMs, ok };
    const errText = ok ? null : formatError(err);
    if (!ok && errText) entry.error = errText;
    timings.push(entry);
    console.log(`[timing] ${label} ${ok ? 'ok' : 'fail'} ${elapsedMs}ms${errText ? ` err=${errText}` : ''}`);
  };
  const timed = async (label, fn) => {
    const started = Date.now();
    try {
      const res = await fn();
      recordTiming(label, started, true, null);
      return res;
    } catch (err) {
      recordTiming(label, started, false, err);
      throw err;
    }
  };
  const logTimingSummary = (err) => {
    const summary = {
      totalMs: Date.now() - totalStartMs,
      ok: !err,
      error: err ? formatError(err) : null,
      steps: timings,
    };
    console.log('E2E timing summary:');
    console.log(JSON.stringify(summary, null, 2));
  };

  const run = async () => {
  if (!intentRegistryAddress || !rootRegistryAddress || !hookAddress || !swapRouterAddress) {
    throw new Error(
      'Missing ShadowPool addresses (need VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS, VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS, VITE_SHADOWPOOL_HOOK_ADDRESS, VITE_POOL_SWAP_TEST_ADDRESS)'
    );
  }
  if (!iExecAppAddress || !isAddress(iExecAppAddress)) throw new Error('Missing iExec app address (VITE_IEXEC_APP_ADDRESS)');

  const adminProvider = createEip1193Provider({ privateKeyHex: privateKey, rpcUrl });
  const admin = adminProvider.__shadowpool.account.address;

  const intentRegistryAbi = parseAbi([
    'function currentRoundId() external view returns (bytes32)',
    'function isWithinIntakeWindow(uint256 timestamp) external view returns (bool)',
    'function registerIntent(bytes32 roundId, address protectedData, bytes32 commitment) external returns (uint256)',
    'error InvalidProtectedData()',
    'error InvalidCommitment()',
    'error IntentAlreadyRegistered()',
    'error InvalidTrader()',
    'error ArrayLengthMismatch()',
    'error InvalidRoundId()',
    'error IntakeWindowClosed()',
    'error InvalidRoundConfig()',
  ]);

  const nowBlock = await timed('getBlock', () => publicClient.getBlock());
  const inIntake = await timed('checkIntakeWindow', () =>
    publicClient.readContract({
      address: intentRegistryAddress,
      abi: intentRegistryAbi,
      functionName: 'isWithinIntakeWindow',
      args: [BigInt(nowBlock.timestamp)],
    })
  );
  if (!inIntake) {
    throw new Error('Current round intake window is closed. Redeploy with larger intake window or retry during intake.');
  }

  const roundId = await timed('currentRoundId', () =>
    publicClient.readContract({
      address: intentRegistryAddress,
      abi: intentRegistryAbi,
      functionName: 'currentRoundId',
    })
  );

  const tokenPair = {
    base: { symbol: 'TKA', name: 'TokenA', address: tokenA, decimals: 18 },
    quote: { symbol: 'TKB', name: 'TokenB', address: tokenB, decimals: 18 },
  };

  const expirySeconds = Number(nowBlock.timestamp) + 3600;
  const expiry = new Date(expirySeconds * 1000);
  const makeIntent = ({
    side,
    amount,
    notes,
    limitPrice,
    slippageMin,
    slippageMax,
    expiry: expiryOverride,
    tokenPair: tokenPairOverride,
  }) => ({
    side,
    tokenPair: tokenPairOverride ?? tokenPair,
    amount,
    limitPrice: limitPrice ?? e2eLimitPrice,
    expiry: expiryOverride ?? expiry,
    slippageMin: slippageMin ?? e2eSlippageMin,
    slippageMax: slippageMax ?? e2eSlippageMax,
    notes,
  });

  const otherTokenPair = {
    base: { symbol: 'OTKA', name: 'OtherTokenA', address: '0x1000000000000000000000000000000000000001', decimals: 18 },
    quote: { symbol: 'OTKB', name: 'OtherTokenB', address: '0x2000000000000000000000000000000000000002', decimals: 18 },
  };

  const traders = (() => {
    if (e2eScenario === 'price-levels') {
      return [
        {
          key: traderKeys[0],
          intent: makeIntent({ side: 'buy', amount: '30', limitPrice: '2', notes: 'price-levels-buy' }),
        },
        ...['0.5', '1', '1.5'].map((p, i) => ({
          key: traderKeys[1],
          intent: makeIntent({ side: 'sell', amount: '10', limitPrice: p, notes: `price-levels-sell-${i + 1}` }),
        })),
      ];
    }
    if (e2eScenario === 'same-price-ties') {
      return [
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '15', limitPrice: '2', notes: 'ties-buy' }) },
        { key: traderKeys[1], intent: makeIntent({ side: 'sell', amount: '5', limitPrice: '1', notes: 'ties-sell-1' }) },
        { key: traderKeys[1], intent: makeIntent({ side: 'sell', amount: '10', limitPrice: '1', notes: 'ties-sell-2' }) },
      ];
    }
    if (e2eScenario === 'one-to-many') {
      return [
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '25', limitPrice: '2', notes: 'one-to-many-buy' }) },
        { key: traderKeys[1], intent: makeIntent({ side: 'sell', amount: '10', limitPrice: '1', notes: 'one-to-many-sell-1' }) },
        { key: traderKeys[1], intent: makeIntent({ side: 'sell', amount: '15', limitPrice: '1', notes: 'one-to-many-sell-2' }) },
      ];
    }
    if (e2eScenario === 'many-to-one') {
      return [
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '5', limitPrice: '2', notes: 'many-to-one-buy-1' }) },
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '10', limitPrice: '2', notes: 'many-to-one-buy-2' }) },
        { key: traderKeys[1], intent: makeIntent({ side: 'sell', amount: '20', limitPrice: '1', notes: 'many-to-one-sell' }) },
      ];
    }
    if (e2eScenario === 'dust-rounding') {
      return [
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '10', limitPrice: '2', notes: 'dust-buy' }) },
        { key: traderKeys[1], intent: makeIntent({ side: 'sell', amount: '10', limitPrice: '0.333333333333333333', notes: 'dust-sell' }) },
      ];
    }
    if (e2eScenario === 'invalid-amounts') {
      return [
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '10', limitPrice: '2', notes: 'valid-buy' }) },
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '0', limitPrice: '2', notes: 'invalid-buy-0' }) },
        { key: traderKeys[1], intent: makeIntent({ side: 'sell', amount: '-1', limitPrice: '1', notes: 'invalid-sell-neg' }) },
        { key: traderKeys[1], intent: makeIntent({ side: 'sell', amount: '10', limitPrice: '1', notes: 'valid-sell' }) },
      ];
    }
    if (e2eScenario === 'cross-pair-isolation') {
      return [
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '10', limitPrice: '2', notes: 'pairA-buy' }) },
        { key: traderKeys[1], intent: makeIntent({ side: 'sell', amount: '10', limitPrice: '1', notes: 'pairA-sell' }) },
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '10', limitPrice: '2', notes: 'pairB-buy-only', tokenPair: otherTokenPair }) },
      ];
    }
    if (e2eScenario === 'decimals-mismatch') {
      const mismatchedPair = {
        base: { ...tokenPair.base, decimals: 6 },
        quote: { ...tokenPair.quote, decimals: 18 },
      };
      return [
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '1000000000000', limitPrice: '2', notes: 'decimals-buy', tokenPair: mismatchedPair }) },
        { key: traderKeys[1], intent: makeIntent({ side: 'sell', amount: '1000000000000', limitPrice: '1', notes: 'decimals-sell', tokenPair: mismatchedPair }) },
      ];
    }
    if (e2eScenario === 'slippage-extremes') {
      return [
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '10', limitPrice: '2', notes: 'slip-buy-100', slippageMin: 2, slippageMax: 100 }) },
        { key: traderKeys[1], intent: makeIntent({ side: 'sell', amount: '10', limitPrice: '1', notes: 'slip-sell-0', slippageMin: 1, slippageMax: 0 }) },
      ];
    }
    if (e2eScenario === 'expiry-boundary') {
      const expired = new Date(Number(nowBlock.timestamp) * 1000);
      const valid = new Date((Number(nowBlock.timestamp) + 3600) * 1000);
      return [
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '10', limitPrice: '2', notes: 'expiry-valid-buy', expiry: valid }) },
        { key: traderKeys[0], intent: makeIntent({ side: 'buy', amount: '10', limitPrice: '2', notes: 'expiry-expired-buy', expiry: expired }) },
        { key: traderKeys[1], intent: makeIntent({ side: 'sell', amount: '10', limitPrice: '1', notes: 'expiry-valid-sell', expiry: valid }) },
      ];
    }
    return [
      ...Array.from({ length: e2eBuyCount }, (_, i) => ({
        key: traderKeys[0],
        intent: makeIntent({ side: 'buy', amount: e2eBuyAmount, notes: `e2e-buy-${i + 1}` }),
      })),
      ...Array.from({ length: e2eSellCount }, (_, i) => ({
        key: traderKeys[1],
        intent: makeIntent({ side: 'sell', amount: e2eSellAmount, notes: `e2e-sell-${i + 1}` }),
      })),
    ];
  })();

  const protectedIntents = [];
  for (const t of traders) {
    const provider = createEip1193Provider({ privateKeyHex: t.key, rpcUrl });
    const dp = new IExecDataProtector(provider, { allowExperimentalNetworks: true }).core;
    const traderAddr = provider.__shadowpool.account.address;
    const salt = keccak256(encodePacked(['bytes32', 'address', 'uint256'], [roundId, traderAddr, BigInt(Date.now())]));

    console.log(`Protecting intent for trader=${traderAddr} side=${t.intent.side}`);
    const protectedData = await timed(`protectData:${traderAddr}`, () =>
      withTimeout(
        'protectData',
        withRetries('protectData', () =>
          dp.protectData({
            name: 'iExec ShadowPool Intent',
            data: {
              version: '1',
              trader: traderAddr,
              side: t.intent.side,
              baseToken: t.intent.tokenPair.base.address,
              quoteToken: t.intent.tokenPair.quote.address,
              amountBase: t.intent.amount,
              limitPrice: t.intent.limitPrice,
              expiry: Math.floor(t.intent.expiry.getTime() / 1000),
              salt,
              tokenPair: t.intent.tokenPair,
              slippageMin: t.intent.slippageMin,
              slippageMax: t.intent.slippageMax,
              notes: t.intent.notes,
            },
          })
        ),
        180_000
      )
    );
    console.log(`Protected data address=${protectedData.address}`);

    console.log(`Granting bulk access to app=${iExecAppAddress} requester=${admin}`);
    const granted = await timed(`grantAccess:${traderAddr}`, () =>
      withTimeout(
        'grantAccess',
        withRetries('grantAccess', () =>
          dp.grantAccess({
            protectedData: protectedData.address,
            authorizedApp: iExecAppAddress,
            authorizedUser: admin,
            allowBulk: true,
            pricePerAccess: 0,
          })
        ),
        180_000
      )
    );
    console.log(`Granted access datasetorder.dataset=${granted?.dataset ?? protectedData.address}`);

    const amountBaseWeiForCommitment = (() => {
      try {
        const v = parseUnits(t.intent.amount, 18);
        return v > 0n ? v : 0n;
      } catch {
        return 0n;
      }
    })();
    const limitPriceWadForCommitment = (() => {
      try {
        const v = parseUnits(t.intent.limitPrice, 18);
        return v > 0n ? v : 0n;
      } catch {
        return 0n;
      }
    })();
    const commitment = keccak256(
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
          t.intent.side === 'buy' ? 0 : 1,
          traderAddr,
          t.intent.tokenPair.base.address,
          t.intent.tokenPair.quote.address,
          amountBaseWeiForCommitment,
          limitPriceWadForCommitment,
          BigInt(Math.floor(t.intent.expiry.getTime() / 1000)),
          salt,
        ]
      )
    );

    const { submitTxHash, submitReceipt } = await timed(`registerIntent:${traderAddr}`, async () => {
      const submitTxHash = await provider.__shadowpool.walletClient.writeContract({
        address: intentRegistryAddress,
        abi: intentRegistryAbi,
        functionName: 'registerIntent',
        args: [roundId, protectedData.address, commitment],
      });
      const submitReceipt = await provider.__shadowpool.publicClient.waitForTransactionReceipt({ hash: submitTxHash });
      return { submitTxHash, submitReceipt };
    });
    console.log(
      `Submitted intent tx=${submitTxHash} gasUsed=${submitReceipt.gasUsed?.toString?.() ?? 'unknown'}`
    );

    protectedIntents.push({
      trader: traderAddr,
      protectedDataAddress: protectedData.address,
      commitment,
      grantOrder: granted,
      submitTxHash,
      submitGasUsed: submitReceipt.gasUsed?.toString?.() ?? null,
    });
  }

  if (verifyRefresh) {
    await timed('verifyRefresh', async () => {
      const verifyAbi = parseAbi([
        'function getIntentCount(bytes32 roundId) external view returns (uint256)',
        'function isIntentRegistered(bytes32 roundId, address protectedData) external view returns (bool)',
      ]);
      const count = await publicClient.readContract({
        address: intentRegistryAddress,
        abi: verifyAbi,
        functionName: 'getIntentCount',
        args: [roundId],
      });
      console.log(`IntentRegistry roundId=${roundId}`);
      console.log(`IntentRegistry getIntentCount=${count.toString()}`);
      for (const ref of protectedIntents) {
        const registered = await publicClient.readContract({
          address: intentRegistryAddress,
          abi: verifyAbi,
          functionName: 'isIntentRegistered',
          args: [roundId, ref.protectedDataAddress],
        });
        console.log(`IntentRegistry isIntentRegistered(${ref.protectedDataAddress})=${Boolean(registered)}`);
      }
      const publicClientRefresh = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
      const countAfterRefresh = await publicClientRefresh.readContract({
        address: intentRegistryAddress,
        abi: verifyAbi,
        functionName: 'getIntentCount',
        args: [roundId],
      });
      console.log(`IntentRegistry getIntentCount(after refresh)=${countAfterRefresh.toString()}`);
      for (const ref of protectedIntents) {
        const registered = await publicClientRefresh.readContract({
          address: intentRegistryAddress,
          abi: verifyAbi,
          functionName: 'isIntentRegistered',
          args: [roundId, ref.protectedDataAddress],
        });
        console.log(`IntentRegistry isIntentRegistered(after refresh)(${ref.protectedDataAddress})=${Boolean(registered)}`);
      }
    });
  }

  if (skipTee) {
    console.log('Skipping TEE processing (--skip-tee)');
    return;
  }

  const bulkAccesses = protectedIntents.map((x) => x.grantOrder).filter(Boolean);
  if (bulkAccesses.length === 0) throw new Error('Missing bulkAccesses (grantAccess did not return orders)');

  const commitmentsByProtectedData = {};
  for (const p of protectedIntents) {
    commitmentsByProtectedData[p.protectedDataAddress.toLowerCase()] = p.commitment;
  }

  const protectedDataByTrader = {};
  for (const p of protectedIntents) {
    const k = String(p.trader).toLowerCase();
    const existing = protectedDataByTrader[k];
    if (Array.isArray(existing)) {
      existing.push(p.protectedDataAddress);
    } else if (typeof existing === 'string' && existing) {
      protectedDataByTrader[k] = [existing, p.protectedDataAddress];
    } else {
      protectedDataByTrader[k] = [p.protectedDataAddress];
    }
  }

  const adminDp = new IExecDataProtector(adminProvider, { allowExperimentalNetworks: true }).core;
  console.log(`Ensuring apporder exists for app=${iExecAppAddress}`);
  await timed('ensureFreeAppOrderPublished', () => ensureFreeAppOrderPublished({ ethProvider: adminProvider, app: iExecAppAddress }));
  console.log('Preparing bulk request');
  const { bulkRequest } = await timed('prepareBulkRequest', () =>
    adminDp.prepareBulkRequest({
      bulkAccesses,
      app: iExecAppAddress,
      workerpool: iexecWorkerpool,
      workerpoolMaxPrice: iexecWorkerpoolMaxPrice,
      args: JSON.stringify({ roundId, commitmentsByProtectedData, protectedDataByTrader }),
      encryptResult: false,
      maxProtectedDataPerTask: 100,
    })
  );

  console.log(
    JSON.stringify(
      {
        bulkRequest: {
          app: bulkRequest?.app ?? null,
          dataset: bulkRequest?.dataset ?? null,
          requester: bulkRequest?.requester ?? null,
          tag: bulkRequest?.tag ?? null,
          volume: bulkRequest?.volume ?? null,
          appmaxprice: bulkRequest?.appmaxprice ?? null,
          datasetmaxprice: bulkRequest?.datasetmaxprice ?? null,
          workerpoolmaxprice: bulkRequest?.workerpoolmaxprice ?? null,
        },
        workerpool: iexecWorkerpool,
      },
      null,
      2
    )
  );

  await timed('ensureRequesterStake', () =>
    ensureRequesterStake({
      ethProvider: adminProvider,
      minStakeNrlc:
        (asNrlcBigInt(bulkRequest?.appmaxprice) +
          asNrlcBigInt(bulkRequest?.datasetmaxprice) +
          asNrlcBigInt(bulkRequest?.workerpoolmaxprice)) *
        (asNrlcBigInt(bulkRequest?.volume) || 1n),
    })
  );

  console.log('Processing bulk request (TEE)');
  const iexecDeals = [];
  const iexecTasks = [];
  let matchDurationMs = 0;
  const { tasks } = await timed('processBulkRequest', async () => {
    const t0 = Date.now();
    const res = await withTimeout(
      'processBulkRequest',
      withRetries(
        'processBulkRequest',
        async () => {
          const res = await adminDp.processBulkRequest({
            bulkRequest,
            workerpool: iexecWorkerpool,
            waitForResult: true,
            path: 'result.json',
            onStatusUpdate: (update) => {
              const title = update?.title ?? 'UNKNOWN';
              const isDone = Boolean(update?.isDone);
              const payload = update?.payload ?? null;

              if (title === 'REQUEST_TO_PROCESS_BULK_DATA' && isDone && payload?.txHash && payload?.dealId) {
                iexecDeals.push({ dealId: payload.dealId, txHash: payload.txHash, matchVolume: payload.matchVolume ?? null });
              }
              if (title === 'CREATE_BULK_TASKS' && isDone && Array.isArray(payload?.tasks)) {
                for (const t of payload.tasks) {
                  if (t?.taskId) iexecTasks.push({ taskId: t.taskId, dealId: t.dealId ?? null, bulkIndex: t.bulkIndex ?? null });
                }
              }

              const compactPayload =
                payload && typeof payload === 'object'
                  ? Object.fromEntries(
                      Object.entries(payload).filter(([k]) =>
                        ['txHash', 'dealId', 'taskId', 'status', 'success', 'remainingVolume', 'matchVolume'].includes(k)
                      )
                    )
                  : payload;
              console.log(`[processBulkRequest] ${title} ${isDone ? 'done' : '...'} ${compactPayload ? JSON.stringify(compactPayload) : ''}`);
            },
          });
          const maybeTasks = Array.isArray(res?.tasks) ? res.tasks : [];
          const hasAnyResult = maybeTasks.some((t) => t?.result instanceof ArrayBuffer);
          if (!hasAnyResult) throw new Error('processBulkRequest: missing task results');
          return res;
        },
        { retries: 6, baseDelayMs: 2500 }
      ),
      3_600_000
    );
    matchDurationMs = Date.now() - t0;
    return res;
  });
  console.log(`TEE matching completed in ${matchDurationMs}ms tasks=${tasks.length}`);

  const decoder = new TextDecoder();
  const results = [];
  for (const t of tasks) {
    const result = t.result;
    if (!(result instanceof ArrayBuffer)) continue;
    const text = decoder.decode(new Uint8Array(result));
    results.push(JSON.parse(text));
  }

  const merged = results.find((x) => x && typeof x === 'object' && Array.isArray(x.matches)) ?? null;
  if (!merged) throw new Error('No iExec task returned matches');

  const merkleRoot = merged.merkleRoot;
  const matchesRaw = merged.matches ?? [];

  if (!merkleRoot || typeof merkleRoot !== 'string') throw new Error('Missing merkleRoot in iExec result');
  if (!Array.isArray(matchesRaw) || matchesRaw.length === 0) {
    console.log(
      JSON.stringify(
        {
          iexecResultSummary: {
            intentsCount: merged?.intentsCount ?? null,
            eligibleIntentsCount: merged?.eligibleIntentsCount ?? null,
            roundId: merged?.roundId ?? null,
            roundIdBytes32: merged?.roundIdBytes32 ?? null,
          },
          debugInputs: Array.isArray(merged?.debugInputs) ? merged.debugInputs.slice(0, 16) : null,
          debugParsed: Array.isArray(merged?.debugParsed) ? merged.debugParsed.slice(0, 16) : null,
        },
        null,
        2
      )
    );
    throw new Error('No matches produced');
  }

  const matches = matchesRaw.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const matchIdHash =
      typeof m.matchIdHash === 'string' && isHex(m.matchIdHash) && m.matchIdHash.length === 66
        ? m.matchIdHash
        : typeof m.matchId === 'string'
          ? keccak256(toBytes(m.matchId))
          : null;
    return { ...m, matchIdHash };
  });

  const roundExpiry =
    typeof merged.roundExpiry === 'number'
      ? merged.roundExpiry
      : Math.min(...matches.map((m) => Number(m?.expiry ?? Number.NaN)));
  if (!Number.isFinite(roundExpiry)) throw new Error('Missing roundExpiry in iExec result');

  const rootRegistryAbi = parseAbi([
    'function closeRound(bytes32 roundId) external',
    'function postRoot(bytes32 roundId, bytes32 root, uint256 validUntil) external',
  ]);

  const { closeHash, closeReceipt } = await timed('closeRound', async () => {
    const { request: closeReq } = await adminProvider.__shadowpool.publicClient.simulateContract({
      address: rootRegistryAddress,
      abi: rootRegistryAbi,
      functionName: 'closeRound',
      args: [roundId],
      account: adminProvider.__shadowpool.account,
    });
    const closeHash = await adminProvider.__shadowpool.walletClient.writeContract(closeReq);
    const closeReceipt = await adminProvider.__shadowpool.publicClient.waitForTransactionReceipt({ hash: closeHash });
    return { closeHash, closeReceipt };
  });

  const validUntil = BigInt(roundExpiry);
  const { postHash, postReceipt } = await timed('postRoot', async () => {
    const { request: postReq } = await adminProvider.__shadowpool.publicClient.simulateContract({
      address: rootRegistryAddress,
      abi: rootRegistryAbi,
      functionName: 'postRoot',
      args: [roundId, merkleRoot, validUntil],
      account: adminProvider.__shadowpool.account,
    });
    const postHash = await adminProvider.__shadowpool.walletClient.writeContract(postReq);
    const postReceipt = await adminProvider.__shadowpool.publicClient.waitForTransactionReceipt({ hash: postHash });
    return { postHash, postReceipt };
  });

  function requireTruthy(ok, message) {
    if (!ok) throw new Error(message);
  }

  function findMatch(matchIdPrefix) {
    return matches.find((m) => m && typeof m === 'object' && typeof m.matchId === 'string' && m.matchId.startsWith(matchIdPrefix)) ?? null;
  }

  function requireAmountEquals(matchIdPrefix, field, expected) {
    const m = findMatch(matchIdPrefix);
    requireTruthy(m, `Missing match ${matchIdPrefix}`);
    const raw = m?.[field];
    requireTruthy(typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint', `Missing ${field} in ${matchIdPrefix}`);
    const got = BigInt(raw);
    requireTruthy(got === expected, `Unexpected ${field} for ${matchIdPrefix}: got=${got.toString()} expected=${expected.toString()}`);
  }

  function requireAmountSetEquals(prefixA, prefixB, field, expectedA, expectedB) {
    const a = findMatch(prefixA);
    const b = findMatch(prefixB);
    requireTruthy(a && b, `Missing matches ${prefixA} or ${prefixB}`);
    const va = BigInt(a[field]);
    const vb = BigInt(b[field]);
    const ok =
      (va === expectedA && vb === expectedB) ||
      (va === expectedB && vb === expectedA);
    requireTruthy(
      ok,
      `Unexpected ${field} set: ${prefixA}=${va.toString()} ${prefixB}=${vb.toString()} expected={${expectedA.toString()},${expectedB.toString()}}`
    );
    return { va, vb };
  }

  if (e2eScenario === 'price-levels') {
    requireAmountEquals('fill:0:buy:', 'amountIn', parseUnits('5', 18));
    requireAmountEquals('fill:1:buy:', 'amountIn', parseUnits('10', 18));
    requireAmountEquals('fill:2:buy:', 'amountIn', parseUnits('15', 18));
  } else if (e2eScenario === 'same-price-ties') {
    const { va, vb } = requireAmountSetEquals('fill:0:sell:', 'fill:1:sell:', 'amountIn', parseUnits('5', 18), parseUnits('10', 18));
    console.log(`same-price-ties: fill0Sell=${va.toString()} fill1Sell=${vb.toString()}`);
  } else if (e2eScenario === 'one-to-many') {
    requireAmountSetEquals('fill:0:sell:', 'fill:1:sell:', 'amountIn', parseUnits('10', 18), parseUnits('15', 18));
  } else if (e2eScenario === 'many-to-one') {
    requireAmountSetEquals('fill:0:sell:', 'fill:1:sell:', 'amountIn', parseUnits('5', 18), parseUnits('10', 18));
  } else if (e2eScenario === 'dust-rounding') {
    requireAmountEquals('fill:0:buy:', 'amountIn', 3333333333333333330n);
  } else if (e2eScenario === 'invalid-amounts') {
    requireTruthy(matches.length === 2, `Expected 2 matches (1 fill) but got ${matches.length}`);
  } else if (e2eScenario === 'cross-pair-isolation') {
    for (const m of matches) {
      if (!m || typeof m !== 'object') continue;
      const tokenIn = typeof m.tokenIn === 'string' ? m.tokenIn.toLowerCase() : '';
      const tokenOut = typeof m.tokenOut === 'string' ? m.tokenOut.toLowerCase() : '';
      requireTruthy(
        [tokenA.toLowerCase(), tokenB.toLowerCase()].includes(tokenIn) && [tokenA.toLowerCase(), tokenB.toLowerCase()].includes(tokenOut),
        `Unexpected token pair in match tokenIn=${tokenIn} tokenOut=${tokenOut}`
      );
    }
  } else if (e2eScenario === 'decimals-mismatch') {
    requireAmountEquals('fill:0:sell:', 'amountIn', 1_000_000_000_000_000_000n);
  } else if (e2eScenario === 'slippage-extremes') {
    requireAmountEquals('fill:0:buy:', 'minAmountOut', 0n);
  } else if (e2eScenario === 'expiry-boundary') {
    requireTruthy(matches.length === 2, `Expected 2 matches (1 fill) but got ${matches.length}`);
  }

  const hookPayloadParams = [
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
  ];

  const fee = poolFeeRaw ? Number(poolFeeRaw) : 0;
  const tickSpacing = tickSpacingRaw ? Number(tickSpacingRaw) : 60;
  const MIN_PRICE_LIMIT = 4295128740n;
  const MAX_PRICE_LIMIT = 1461446703485210103287273052203988822378723970341n;

  const swapAbi = parseAbi([
    'function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,(bool takeClaims,bool settleUsingBurn) settings, bytes hookData) payable returns (int256 delta)',
    'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
  ]);
  const erc20FullAbi = parseAbi([
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 value) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
  ]);

  const hookMatchUsedAbi = parseAbi(['function matchUsed(bytes32 roundId, bytes32 matchIdHash) external view returns (bool)']);
  const matchesWithUsed = await Promise.all(
    matches.map(async (m) => {
      if (!m || typeof m !== 'object') return { match: m, used: null };
      const trader = typeof m.trader === 'string' ? m.trader : null;
      const matchIdHash = typeof m.matchIdHash === 'string' && isHex(m.matchIdHash) && m.matchIdHash.length === 66 ? m.matchIdHash : null;
      if (!trader || !matchIdHash) return { match: m, used: null };
      const used = await adminProvider.__shadowpool.publicClient.readContract({
        address: hookAddress,
        abi: hookMatchUsedAbi,
        functionName: 'matchUsed',
        args: [roundId, matchIdHash],
      });
      return { match: m, used: Boolean(used) };
    })
  );

  const matchToExecute =
    matchesWithUsed.find((x) => x?.match && x.used === false)?.match ??
    matches.find((m) => m && typeof m === 'object' && typeof m.trader === 'string') ??
    matches[0];

  const selectedMatchIdHash =
    matchToExecute && typeof matchToExecute === 'object' && typeof matchToExecute.matchIdHash === 'string'
      ? matchToExecute.matchIdHash
      : null;
  const selectedUsed =
    selectedMatchIdHash && isHex(selectedMatchIdHash)
      ? matchesWithUsed.find((x) => x?.match && x.match.matchIdHash === selectedMatchIdHash)?.used ?? null
      : null;
  if (selectedUsed === true) {
    throw new Error('All available matches for this round appear already used; deploy a new round or wait for next round');
  }

  const traderKey = matchToExecute.trader.toLowerCase() === traderAddresses[0]?.toLowerCase() ? traderKeys[0] : traderKeys[1];
  const execProvider = createEip1193Provider({ privateKeyHex: traderKey, rpcUrl });

  const traderAddr = execProvider.__shadowpool.account.address;
  const tokenIn = matchToExecute.tokenIn;
  const tokenOut = matchToExecute.tokenOut;
  const amountIn = BigInt(matchToExecute.amountIn);
  const minAmountOut = BigInt(matchToExecute.minAmountOut);

  const addrA = tokenIn.toLowerCase();
  const addrB = tokenOut.toLowerCase();
  const currency0 = addrA < addrB ? tokenIn : tokenOut;
  const currency1 = addrA < addrB ? tokenOut : tokenIn;
  const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();

  const currentAllowance = await execProvider.__shadowpool.publicClient.readContract({
    address: tokenIn,
    abi: erc20FullAbi,
    functionName: 'allowance',
    args: [traderAddr, swapRouterAddress],
  });
  if (BigInt(currentAllowance) < amountIn) {
    const { request: approveReq } = await execProvider.__shadowpool.publicClient.simulateContract({
      address: tokenIn,
      abi: erc20FullAbi,
      functionName: 'approve',
      args: [swapRouterAddress, amountIn],
      account: execProvider.__shadowpool.account,
    });
    const approveHash = await execProvider.__shadowpool.walletClient.writeContract(approveReq);
    await execProvider.__shadowpool.publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  const balanceBefore = await execProvider.__shadowpool.publicClient.readContract({
    address: tokenOut,
    abi: erc20FullAbi,
    functionName: 'balanceOf',
    args: [traderAddr],
  });

  const hookOwnerAbi = parseAbi([
    'function allowedCaller(address caller) external view returns (bool)',
    'function setAllowedCaller(address caller, bool allowed) external',
  ]);
  const routerAllowed = await adminProvider.__shadowpool.publicClient.readContract({
    address: hookAddress,
    abi: hookOwnerAbi,
    functionName: 'allowedCaller',
    args: [swapRouterAddress],
  });
  if (!routerAllowed) {
    const { request: allowReq } = await adminProvider.__shadowpool.publicClient.simulateContract({
      address: hookAddress,
      abi: hookOwnerAbi,
      functionName: 'setAllowedCaller',
      args: [swapRouterAddress, true],
      account: adminProvider.__shadowpool.account,
    });
    const allowHash = await adminProvider.__shadowpool.walletClient.writeContract(allowReq);
    await adminProvider.__shadowpool.publicClient.waitForTransactionReceipt({ hash: allowHash });
  }

  const leafToSign =
    typeof matchToExecute.leaf === 'string' && isHex(matchToExecute.leaf) && matchToExecute.leaf.length === 66
      ? matchToExecute.leaf
      : null;
  if (!leafToSign) throw new Error('Missing leaf in match');

  const signatureToUse =
    typeof matchToExecute.signature === 'string' && isHex(matchToExecute.signature)
      ? matchToExecute.signature
      : await adminProvider.__shadowpool.walletClient.signMessage({ message: { raw: leafToSign } });

  const encodedHookData = encodeAbiParameters(
    [{ type: 'tuple', components: hookPayloadParams }],
    [
      [
        roundId,
        matchToExecute.matchIdHash,
        matchToExecute.trader,
        matchToExecute.counterparty,
        matchToExecute.tokenIn,
        matchToExecute.tokenOut,
        BigInt(matchToExecute.amountIn),
        BigInt(matchToExecute.minAmountOut),
        BigInt(matchToExecute.expiry),
        matchToExecute.merkleProof,
        signatureToUse,
      ],
    ]
  );

  const { swapHash, swapReceipt } = await timed('executeSwap', async () => {
    let swapReq;
    try {
      ({ request: swapReq } = await execProvider.__shadowpool.publicClient.simulateContract({
        address: swapRouterAddress,
        abi: swapAbi,
        functionName: 'swap',
        args: [
          { currency0, currency1, fee, tickSpacing, hooks: hookAddress },
          { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT },
          { takeClaims: false, settleUsingBurn: false },
          encodedHookData,
        ],
        account: execProvider.__shadowpool.account,
      }));
    } catch (err) {
      const candidates = [
        asHexData(err?.data),
        asHexData(err?.raw),
        asHexData(err?.cause?.data),
        asHexData(err?.cause?.raw),
        asHexData(err?.cause?.cause?.data),
        asHexData(err?.cause?.cause?.raw),
        asHexData(err?.cause?.cause?.cause?.data),
        asHexData(err?.cause?.cause?.cause?.raw),
        asHexData(err?.cause?.cause?.cause?.cause?.data),
        asHexData(err?.cause?.cause?.cause?.cause?.raw),
      ];
      const data = candidates.find((x) => typeof x === 'string' && x.startsWith('0x')) ?? null;
      console.log(
        JSON.stringify(
          {
            swapSimRevert: {
              selector: typeof data === 'string' && data.length >= 10 ? data.slice(0, 10) : null,
              errKeys: err && typeof err === 'object' ? Object.getOwnPropertyNames(err) : null,
              causeKeys:
                err?.cause && typeof err.cause === 'object' ? Object.getOwnPropertyNames(err.cause) : null,
              causeCauseKeys:
                err?.cause?.cause && typeof err.cause.cause === 'object'
                  ? Object.getOwnPropertyNames(err.cause.cause)
                  : null,
            },
          },
          null,
          2
        )
      );
      if (typeof data === 'string' && data.startsWith('0x')) {
        const wrappedAbi = parseAbi(['error WrappedError(address target, bytes4 selector, bytes reason, bytes details)']);
        const hookErrorsAbi = parseAbi([
          'error RootNotSet()',
          'error RootExpired()',
          'error InvalidProof()',
          'error LeafAlreadyUsed()',
          'error MatchAlreadyUsed()',
          'error InvalidHookData()',
          'error InvalidSignature()',
          'error MatchExpired()',
          'error UnauthorizedCaller()',
          'error InvalidSwapParams()',
          'error InvalidTeeSigner()',
          'error MinAmountOutNotMet()',
        ]);
        try {
          const wrapped = decodeErrorResult({ abi: wrappedAbi, data });
          const reason = wrapped?.args?.reason;
          let inner = null;
          if (typeof reason === 'string' && reason.startsWith('0x') && reason.length >= 10) {
            try {
              inner = decodeErrorResult({ abi: hookErrorsAbi, data: reason });
            } catch {}
          }
          console.log(
            JSON.stringify(
              {
                wrappedError: {
                  target: wrapped?.args?.target ?? null,
                  selector: wrapped?.args?.selector ?? null,
                  reasonSelector: typeof reason === 'string' ? reason.slice(0, 10) : null,
                  details: wrapped?.args?.details ?? null,
                  innerError: inner
                    ? {
                        name: inner.errorName ?? null,
                        args: inner.args ?? null,
                      }
                    : null,
                },
              },
              null,
              2
            )
          );
        } catch {}
      }
      throw err;
    }
    let swapHash;
    try {
      swapHash = await execProvider.__shadowpool.walletClient.writeContract(swapReq);
    } catch (err) {
      const candidates = [
        asHexData(err?.data),
        asHexData(err?.raw),
        asHexData(err?.cause?.data),
        asHexData(err?.cause?.raw),
        asHexData(err?.cause?.cause?.data),
        asHexData(err?.cause?.cause?.raw),
        asHexData(err?.cause?.cause?.cause?.data),
        asHexData(err?.cause?.cause?.cause?.raw),
        asHexData(err?.cause?.cause?.cause?.cause?.data),
        asHexData(err?.cause?.cause?.cause?.cause?.raw),
      ];
      const data = candidates.find((x) => typeof x === 'string' && x.startsWith('0x')) ?? null;
      console.log(
        JSON.stringify(
          {
            swapWriteRevert: {
              selector: typeof data === 'string' && data.length >= 10 ? data.slice(0, 10) : null,
              errKeys: err && typeof err === 'object' ? Object.getOwnPropertyNames(err) : null,
              causeKeys: err?.cause && typeof err.cause === 'object' ? Object.getOwnPropertyNames(err.cause) : null,
              causeCauseKeys:
                err?.cause?.cause && typeof err.cause.cause === 'object'
                  ? Object.getOwnPropertyNames(err.cause.cause)
                  : null,
            },
          },
          null,
          2
        )
      );
      if (typeof data === 'string' && data.startsWith('0x')) {
        const wrappedAbi = parseAbi(['error WrappedError(address target, bytes4 selector, bytes reason, bytes details)']);
        const hookErrorsAbi = parseAbi([
          'error RootNotSet()',
          'error RootExpired()',
          'error InvalidProof()',
          'error LeafAlreadyUsed()',
          'error MatchAlreadyUsed()',
          'error InvalidHookData()',
          'error InvalidSignature()',
          'error MatchExpired()',
          'error UnauthorizedCaller()',
          'error InvalidSwapParams()',
          'error InvalidTeeSigner()',
          'error MinAmountOutNotMet()',
        ]);
        try {
          const wrapped = decodeErrorResult({ abi: wrappedAbi, data });
          const reason = wrapped?.args?.reason;
          let inner = null;
          if (typeof reason === 'string' && reason.startsWith('0x') && reason.length >= 10) {
            try {
              inner = decodeErrorResult({ abi: hookErrorsAbi, data: reason });
            } catch {}
          }
          console.log(
            JSON.stringify(
              {
                wrappedError: {
                  target: wrapped?.args?.target ?? null,
                  selector: wrapped?.args?.selector ?? null,
                  reasonSelector: typeof reason === 'string' ? reason.slice(0, 10) : null,
                  details: wrapped?.args?.details ?? null,
                  innerError: inner
                    ? {
                        name: inner.errorName ?? null,
                        args: inner.args ?? null,
                      }
                    : null,
                },
              },
              null,
              2
            )
          );
        } catch {}
      }
      throw err;
    }
    const swapReceipt = await execProvider.__shadowpool.publicClient.waitForTransactionReceipt({ hash: swapHash });
    return { swapHash, swapReceipt };
  });

  const balanceAfter = await execProvider.__shadowpool.publicClient.readContract({
    address: tokenOut,
    abi: erc20FullAbi,
    functionName: 'balanceOf',
    args: [traderAddr],
  });

  const amountOut = BigInt(balanceAfter) - BigInt(balanceBefore);
  const minOutBps = 0n;
  const effectiveMinAmountOut = (minAmountOut * minOutBps) / 10_000n;
  if (amountOut < effectiveMinAmountOut) throw new Error('Swap output below minAmountOut');

  console.log('E2E summary:');
  console.log(JSON.stringify(
    {
      roundId,
      contracts: {
        intentRegistryAddress,
        rootRegistryAddress,
        hookAddress,
        swapRouterAddress,
        tokenA,
        tokenB,
      },
      mint: mintReceipts,
      iExec: { app: iExecAppAddress, matchDurationMs },
      iexecDeals,
      iexecTasks,
      intents: protectedIntents.map((x) => ({
        trader: x.trader,
        protectedDataAddress: x.protectedDataAddress,
        submitTxHash: x.submitTxHash,
        submitGasUsed: x.submitGasUsed,
      })),
      matchStats: {
        intentsCount: typeof merged?.intentsCount === 'number' ? merged.intentsCount : null,
        eligibleIntentsCount: typeof merged?.eligibleIntentsCount === 'number' ? merged.eligibleIntentsCount : null,
        matchesCount: matches.length,
      },
      root: {
        merkleRoot,
        closeTxHash: closeHash,
        closeGasUsed: closeReceipt.gasUsed?.toString?.() ?? null,
        postTxHash: postHash,
        postGasUsed: postReceipt.gasUsed?.toString?.() ?? null,
      },
      execution: {
        trader: traderAddr,
        swapTxHash: swapHash,
        swapGasUsed: swapReceipt.gasUsed?.toString?.() ?? null,
        amountOut: amountOut.toString(),
      },
    },
    null,
    2
  ));
  };

  let runError = null;
  try {
    return await run();
  } catch (err) {
    runError = err;
    throw err;
  } finally {
    logTimingSummary(runError);
  }
}

if (runE2E) {
  await runShadowPoolE2E();
}

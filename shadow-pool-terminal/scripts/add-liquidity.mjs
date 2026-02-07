import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  formatUnits,
  http,
  isHex,
  getAddress,
  keccak256,
  parseAbi,
  toBytes,
  toHex,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

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

function loadEnv() {
  const envPath = path.resolve(repoRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  const parsed = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (!process.env[k] && v) process.env[k] = v;
  }
}

function readArgValue(argv, name, fallback) {
  const prefix = `--${name}=`;
  const found = argv.find((a) => typeof a === 'string' && a.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

function readArgInt(argv, name, fallback) {
  const raw = readArgValue(argv, name, null);
  if (raw == null) return fallback;
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.trunc(num);
}

function readArgBigInt(argv, name, fallback) {
  const raw = readArgValue(argv, name, null);
  if (raw == null || !raw.trim()) return fallback;
  try {
    return BigInt(raw);
  } catch {
    return fallback;
  }
}

function readLatestDeployBroadcast() {
  const broadcastPath = path.resolve(
    repoRoot,
    'shadowpool-hook',
    'broadcast',
    'DeployShadowPool.s.sol',
    String(arbitrumSepolia.id),
    'run-latest.json'
  );
  if (!fs.existsSync(broadcastPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(broadcastPath, 'utf8'));
  } catch {
    return null;
  }
}

function lastByName(txs, name) {
  const matches = txs.filter((t) => t && typeof t === 'object' && t.contractName === name);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

function resolveAddress({ envKey, broadcastTx, label }) {
  const raw = process.env[envKey];
  if (raw && isHex(raw)) return raw;
  if (broadcastTx?.contractAddress) return broadcastTx.contractAddress;
  throw new Error(`Missing ${label} (${envKey})`);
}

loadEnv();

const argv = process.argv.slice(2);
const tickLower = readArgInt(argv, 'tick-lower', -120);
const tickUpper = readArgInt(argv, 'tick-upper', 120);
const explicitLiquidity = readArgBigInt(argv, 'liquidity', null);
const maxLiquidity = readArgBigInt(argv, 'max-liquidity', 10n ** 24n);

const rpcUrl =
  process.env.ARBITRUM_SEPOLIA_RPC_URL ||
  process.env.VITE_ALCHEMY_ARBITRUM_SEPOLIA_RPC_URL ||
  process.env.VITE_RPC_URL ||
  process.env.VITE_PUBLIC_RPC_URL;
if (!rpcUrl) {
  throw new Error('Missing ARBITRUM_SEPOLIA_RPC_URL (or VITE_ALCHEMY_ARBITRUM_SEPOLIA_RPC_URL) in .env');
}

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey || !isHex(privateKey)) {
  throw new Error('Missing or invalid PRIVATE_KEY in repo root .env');
}

const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
const walletClient = createWalletClient({ chain: arbitrumSepolia, transport: http(rpcUrl), account });

const broadcast = readLatestDeployBroadcast();
const txs = broadcast?.transactions ?? [];

const modifyRouterTx = lastByName(txs, 'PoolModifyLiquidityTest');
const swapRouterTx = lastByName(txs, 'PoolSwapTest');
const hookTx = lastByName(txs, 'ShadowPoolHook');
const tokenA = txs.find((t) => t?.contractName === 'MockERC20' && t?.arguments?.[0] === 'TokenA');
const tokenB = txs.find((t) => t?.contractName === 'MockERC20' && t?.arguments?.[0] === 'TokenB');

const modifyLiquidityRouter = resolveAddress({
  envKey: 'VITE_POOL_MODIFY_LIQUIDITY_ADDRESS',
  broadcastTx: modifyRouterTx,
  label: 'PoolModifyLiquidityTest address',
});
const swapRouter = resolveAddress({
  envKey: 'VITE_POOL_SWAP_TEST_ADDRESS',
  broadcastTx: swapRouterTx,
  label: 'PoolSwapTest address',
});
const hookAddress = resolveAddress({
  envKey: 'VITE_SHADOWPOOL_HOOK_ADDRESS',
  broadcastTx: hookTx,
  label: 'ShadowPoolHook address',
});
const tokenAAddress = resolveAddress({
  envKey: 'VITE_TOKEN_A_ADDRESS',
  broadcastTx: tokenA,
  label: 'TokenA address',
});
const tokenBAddress = resolveAddress({
  envKey: 'VITE_TOKEN_B_ADDRESS',
  broadcastTx: tokenB,
  label: 'TokenB address',
});

const feeRaw = process.env.VITE_POOL_FEE ?? '0';
const tickSpacingRaw = process.env.VITE_POOL_TICK_SPACING ?? '60';
const fee = Number(feeRaw);
const tickSpacing = Number(tickSpacingRaw);
if (!Number.isFinite(fee) || !Number.isFinite(tickSpacing)) {
  throw new Error(`Invalid fee/tickSpacing: fee=${feeRaw} tickSpacing=${tickSpacingRaw}`);
}

if (tickLower >= tickUpper) {
  throw new Error(`tick-lower must be < tick-upper (got ${tickLower}, ${tickUpper})`);
}
if (tickLower % tickSpacing !== 0 || tickUpper % tickSpacing !== 0) {
  throw new Error(`Ticks must align to tickSpacing=${tickSpacing}. Use multiples of ${tickSpacing}.`);
}

const addrA = BigInt(tokenAAddress.toLowerCase());
const addrB = BigInt(tokenBAddress.toLowerCase());
let currency0 = addrA < addrB ? tokenAAddress : tokenBAddress;
let currency1 = addrA < addrB ? tokenBAddress : tokenAAddress;

const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

const modifyAbi = parseAbi([
  'function manager() view returns (address)',
  'function modifyLiquidity((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt) params, bytes hookData) payable returns (int256 delta)',
  'function extsload(bytes32 slot) view returns (bytes32)',
]);

console.log('[add-liquidity] RPC:', rpcUrl);
console.log('[add-liquidity] Deployer:', account.address);
console.log('[add-liquidity] ModifyLiquidity router:', modifyLiquidityRouter);
console.log('[add-liquidity] Swap router:', swapRouter);
console.log('[add-liquidity] Hook:', hookAddress);
console.log('[add-liquidity] TokenA:', tokenAAddress);
console.log('[add-liquidity] TokenB:', tokenBAddress);
console.log('[add-liquidity] fee:', fee, 'tickSpacing:', tickSpacing);

const [modifyCode, swapCode] = await Promise.all([
  publicClient.getBytecode({ address: modifyLiquidityRouter }),
  publicClient.getBytecode({ address: swapRouter }),
]);
if (!modifyCode || modifyCode === '0x') {
  throw new Error(`ModifyLiquidity router has no code at ${modifyLiquidityRouter}`);
}
if (!swapCode || swapCode === '0x') {
  throw new Error(`Swap router has no code at ${swapRouter}`);
}

const [decimalsA, decimalsB, balA, balB] = await Promise.all([
  publicClient.readContract({ address: tokenAAddress, abi: erc20Abi, functionName: 'decimals' }),
  publicClient.readContract({ address: tokenBAddress, abi: erc20Abi, functionName: 'decimals' }),
  publicClient.readContract({ address: tokenAAddress, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
  publicClient.readContract({ address: tokenBAddress, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
]);
console.log(
  '[add-liquidity] balances:',
  `TKA=${formatUnits(balA, Number(decimalsA))}`,
  `TKB=${formatUnits(balB, Number(decimalsB))}`
);

const [allowA, allowB] = await Promise.all([
  publicClient.readContract({
    address: tokenAAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, modifyLiquidityRouter],
  }),
  publicClient.readContract({
    address: tokenBAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, modifyLiquidityRouter],
  }),
]);

const maxApproval = (1n << 256n) - 1n;
async function sendWrite(request) {
  return walletClient.writeContract(request);
}

if (allowA < balA) {
  const { request } = await publicClient.simulateContract({
    address: tokenAAddress,
    abi: erc20Abi,
    functionName: 'approve',
    args: [modifyLiquidityRouter, maxApproval],
    account,
  });
  const hash = await sendWrite(request);
  await publicClient.waitForTransactionReceipt({ hash });
}
if (allowB < balB) {
  const { request } = await publicClient.simulateContract({
    address: tokenBAddress,
    abi: erc20Abi,
    functionName: 'approve',
    args: [modifyLiquidityRouter, maxApproval],
    account,
  });
  const hash = await sendWrite(request);
  await publicClient.waitForTransactionReceipt({ hash });
}

const manager = await publicClient.readContract({
  address: modifyLiquidityRouter,
  abi: modifyAbi,
  functionName: 'manager',
});
console.log('[add-liquidity] PoolManager:', manager);

const managerFromSwap = await publicClient.readContract({
  address: swapRouter,
  abi: modifyAbi,
  functionName: 'manager',
});
if (managerFromSwap.toLowerCase() !== manager.toLowerCase()) {
  console.warn('[add-liquidity] warning: swapRouter.manager != modifyRouter.manager', {
    modify: manager,
    swap: managerFromSwap,
  });
}
const managerCode = await publicClient.getBytecode({ address: manager });
if (!managerCode || managerCode === '0x') {
  throw new Error(`PoolManager has no code at ${manager}`);
}

function buildPoolId({ c0, c1, hook }) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [c0, c1, fee, tickSpacing, hook]
    )
  );
}

let poolId = buildPoolId({ c0: currency0, c1: currency1, hook: hookAddress });

const POOLS_SLOT = toHex(6n, { size: 32 });

function poolStateSlot(id) {
  return keccak256(encodePacked(['bytes32', 'bytes32'], [id, POOLS_SLOT]));
}

async function readSlot0(id) {
  const slot = poolStateSlot(id);
  const data = await publicClient.readContract({
    address: manager,
    abi: modifyAbi,
    functionName: 'extsload',
    args: [slot],
  });

  const word = BigInt(data);
  const sqrtPriceX96 = word & ((1n << 160n) - 1n);
  const tickU24 = (word >> 160n) & ((1n << 24n) - 1n);
  const tick = tickU24 >= (1n << 23n) ? Number(tickU24 - (1n << 24n)) : Number(tickU24);
  const protocolFee = Number((word >> 184n) & ((1n << 24n) - 1n));
  const lpFee = Number((word >> 208n) & ((1n << 24n) - 1n));

  return { sqrtPriceX96, tick, protocolFee, lpFee };
}

console.log('[add-liquidity] PoolKey:', {
  currency0,
  currency1,
  fee,
  tickSpacing,
  hooks: hookAddress,
  poolId,
});

async function simulate(liquidityDelta) {
  return publicClient.simulateContract({
    address: modifyLiquidityRouter,
    abi: modifyAbi,
    functionName: 'modifyLiquidity',
    args: [
      { currency0, currency1, fee, tickSpacing, hooks: hookAddress },
      { tickLower, tickUpper, liquidityDelta, salt: '0x0000000000000000000000000000000000000000000000000000000000000000' },
      '0x',
    ],
    account,
  });
}

try {
  await simulate(1n);
} catch (err) {
  const message =
    err?.shortMessage ||
    err?.message ||
    'modifyLiquidity simulation failed (unknown error).';
  console.error('[add-liquidity] modifyLiquidity simulate error:', message);
  if (String(message).includes('0x486aa307')) {
    const sqrtPriceX96 = BigInt(
      process.env.POOL_SQRT_PRICE_X96 ||
        process.env.VITE_POOL_SQRT_PRICE_X96 ||
        '79228162514264337593543950336'
    );
    console.log('[add-liquidity] attempting initialize with sqrtPriceX96', sqrtPriceX96.toString());
    const initAbi = parseAbi([
      'function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint160 sqrtPriceX96) returns (int24)',
    ]);
    try {
      const { request } = await publicClient.simulateContract({
        address: manager,
        abi: initAbi,
        functionName: 'initialize',
        args: [{ currency0, currency1, fee, tickSpacing, hooks: hookAddress }, sqrtPriceX96],
        account,
      });
      const txHash = await sendWrite(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      console.log('[add-liquidity] initialize tx:', txHash);
      console.log('[add-liquidity] initialize status:', receipt.status);
      console.log('[add-liquidity] initialize receipt logs:', receipt.logs?.length ?? 0);
      try {
        const tx = await publicClient.getTransaction({ hash: txHash });
        const dataLen = tx.input ? tx.input.length : 0;
        console.log('[add-liquidity] initialize tx to:', tx.to, 'data bytes:', Math.max(0, (dataLen - 2) / 2));
      } catch (txErr) {
        console.warn('[add-liquidity] could not fetch initialize tx details:', txErr?.shortMessage || txErr?.message || txErr);
      }
      if (receipt.status !== 'success') {
        throw new Error('initialize reverted onchain (receipt.status != success)');
      }

      const initTopic = keccak256(
        toBytes('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')
      );
      let initLogs = receipt.logs.filter(
        (log) =>
          log.address?.toLowerCase() === manager.toLowerCase() &&
          Array.isArray(log.topics) &&
          log.topics[0]?.toLowerCase() === initTopic.toLowerCase()
      );
      if (!initLogs.length) {
        // fallback: query logs for the block to verify the Initialize event
        const block = receipt.blockNumber;
        const queried = await publicClient.getLogs({
          address: manager,
          fromBlock: block,
          toBlock: block,
          topics: [initTopic],
        });
        if (queried.length) initLogs = queried;
      }
      if (initLogs.length) {
        const log = initLogs[0];
        const [feeLog, tickSpacingLog, hooksLog, sqrtLog, tickLog] = decodeAbiParameters(
          [
            { type: 'uint24' },
            { type: 'int24' },
            { type: 'address' },
            { type: 'uint160' },
            { type: 'int24' },
          ],
          log.data
        );
        const id = log.topics[1];
        const c0 = getAddress(`0x${log.topics[2].slice(26)}`);
        const c1 = getAddress(`0x${log.topics[3].slice(26)}`);
        console.log('[add-liquidity] Initialize event:', {
          id,
          currency0: c0,
          currency1: c1,
          fee: feeLog.toString(),
          tickSpacing: tickSpacingLog.toString(),
          hooks: hooksLog,
          sqrtPriceX96: sqrtLog.toString(),
          tick: tickLog.toString(),
        });
        if (c0.toLowerCase() !== currency0.toLowerCase() || c1.toLowerCase() !== currency1.toLowerCase()) {
          currency0 = c0;
          currency1 = c1;
          poolId = buildPoolId({ c0: currency0, c1: currency1, hook: hookAddress });
          console.warn('[add-liquidity] PoolKey updated to match Initialize event.');
        }
      } else {
        console.warn('[add-liquidity] Initialize event not found in receipt logs.');
      }

      const slot0 = await readSlot0(poolId);
      console.log('[add-liquidity] slot0:', {
        sqrtPriceX96: slot0.sqrtPriceX96.toString(),
        tick: slot0.tick,
        protocolFee: slot0.protocolFee,
        lpFee: slot0.lpFee,
      });
      if (slot0.sqrtPriceX96 === 0n) {
        throw new Error('initialize persisted sqrtPriceX96=0; pool still uninitialized for this key.');
      }
    } catch (initErr) {
      const initMessage = initErr?.shortMessage || initErr?.message || 'initialize failed';
      console.error('[add-liquidity] initialize error:', initMessage);
      throw new Error('Pool not initialized for this key (initialize failed).');
    }
    // retry simulation after init
    try {
      await simulate(1n);
    } catch (retryErr) {
      const retryMessage = retryErr?.shortMessage || retryErr?.message || 'retry simulate failed';
      console.error('[add-liquidity] retry simulate error:', retryMessage);
      throw new Error('Pool not initialized for this key (modifyLiquidity simulation failed).');
    }
    console.log('[add-liquidity] pool initialized successfully (via auto-init)');
  } else {
    throw new Error('Pool not initialized for this key (modifyLiquidity simulation failed).');
  }
}

let bestLiquidity = explicitLiquidity;
if (bestLiquidity == null) {
  let high = maxLiquidity;
  while (high > 0n) {
    const ok = await simulate(high);
    if (ok) {
      bestLiquidity = high;
      break;
    }
    high /= 2n;
  }
  if (bestLiquidity == null || bestLiquidity <= 0n) {
    throw new Error('Unable to find a liquidity amount that fits your balances.');
  }
  let low = 0n;
  let highBound = bestLiquidity;
  for (let i = 0; i < 32; i += 1) {
    const mid = (low + highBound + 1n) / 2n;
    const ok = await simulate(mid);
    if (ok) {
      low = mid;
    } else {
      highBound = mid - 1n;
    }
  }
  bestLiquidity = low;
}

console.log('[add-liquidity] Using liquidityDelta:', bestLiquidity.toString());

const { request } = await publicClient.simulateContract({
  address: modifyLiquidityRouter,
  abi: modifyAbi,
  functionName: 'modifyLiquidity',
  args: [
    { currency0, currency1, fee, tickSpacing, hooks: hookAddress },
    { tickLower, tickUpper, liquidityDelta: bestLiquidity, salt: '0x0000000000000000000000000000000000000000000000000000000000000000' },
    '0x',
  ],
  account,
});
const txHash = await sendWrite(request);
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
console.log('[add-liquidity] tx:', txHash);
console.log('[add-liquidity] status:', receipt.status);

import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  isHex,
  keccak256,
  parseAbi,
  parseUnits,
  toBytes,
  toHex,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const hookProjectRoot = path.resolve(repoRoot, 'shadowpool-hook');
const artifactsRoot = path.resolve(hookProjectRoot, 'out');

const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const FLAG_MASK = (1n << 14n) - 1n;
const HOOK_FLAGS = (1n << 7n) | (1n << 6n); // BEFORE_SWAP + AFTER_SWAP
const MAX_LOOP = 160_444n;

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

function updateEnvFile(envPath, updates) {
  const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = raw.split('\n');
  const seen = new Set();
  const next = lines.map((line) => {
    const idx = line.indexOf('=');
    if (idx === -1) return line;
    const key = line.slice(0, idx).trim();
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, next.join('\n').replace(/\n{3,}/g, '\n\n'));
}

function loadArtifact(relativePath) {
  const fullPath = path.resolve(artifactsRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing artifact: ${fullPath}`);
  }
  const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const bytecode = json?.bytecode?.object ?? json?.bytecode;
  if (!bytecode || !isHex(bytecode)) {
    throw new Error(`Invalid bytecode in ${fullPath}`);
  }
  return { abi: json.abi, bytecode };
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

async function sendSigned(walletClient, publicClient, account, request) {
  const prepared = await walletClient.prepareTransactionRequest({ ...request, account });
  const signed = await account.signTransaction(prepared);
  return publicClient.sendRawTransaction({ serializedTransaction: signed });
}

async function sendAndWait({ walletClient, publicClient, account, request, label }) {
  const hash = await sendSigned(walletClient, publicClient, account, request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${label}: tx failed (${hash})`);
  }
  console.log(`[redeploy] ${label} tx: ${hash}`);
  return receipt;
}

async function writeAndWait({ walletClient, publicClient, request, label }) {
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${label}: tx failed (${hash})`);
  }
  console.log(`[redeploy] ${label} tx: ${hash}`);
  return receipt;
}

async function deployContract({ walletClient, publicClient, account, abi, bytecode, args, label }) {
  const data = encodeDeployData({ abi, bytecode, args });
  const hash = await sendSigned(walletClient, publicClient, account, { data });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error(`${label}: deployment failed (no contractAddress)`);
  }
  console.log(`[redeploy] ${label}:`, receipt.contractAddress);
  const code = await publicClient.getBytecode({ address: receipt.contractAddress });
  if (!code || code === '0x') {
    throw new Error(`${label}: no bytecode at deployed address`);
  }
  return receipt.contractAddress;
}

function computeCreate2Address({ deployer, saltHex, initCodeHash }) {
  const packed = concatHex(['0xff', deployer, saltHex, initCodeHash]);
  const hash = keccak256(packed);
  return getAddress(`0x${hash.slice(-40)}`);
}

async function findHookSalt({ publicClient, initCodeHash }) {
  for (let salt = 0n; salt < MAX_LOOP; salt += 1n) {
    const saltHex = toHex(salt, { size: 32 });
    const addr = computeCreate2Address({
      deployer: CREATE2_DEPLOYER,
      saltHex,
      initCodeHash,
    });
    if ((BigInt(addr) & FLAG_MASK) !== HOOK_FLAGS) continue;
    const code = await publicClient.getBytecode({ address: addr });
    if (!code || code === '0x') {
      return { hookAddress: addr, saltHex };
    }
  }
  throw new Error('HookMiner: could not find salt');
}

const envPath = path.resolve(repoRoot, '.env');
if (!fs.existsSync(envPath)) {
  throw new Error(`Missing .env at ${envPath}`);
}

const env = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
const rpcUrl = env.RPC_URL || env.VITE_RPC_URL || env.ARBITRUM_SEPOLIA_RPC_URL;
if (!rpcUrl) throw new Error('Missing RPC_URL (or VITE_RPC_URL) in repo .env');

const privateKey = env.PRIVATE_KEY;
if (!privateKey || !isHex(privateKey)) {
  throw new Error('Missing or invalid PRIVATE_KEY in repo .env');
}

const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
const walletClient = createWalletClient({ chain: arbitrumSepolia, transport: http(rpcUrl), account });

const tickLower = readArgInt(process.argv.slice(2), 'tick-lower', -120);
const tickUpper = readArgInt(process.argv.slice(2), 'tick-upper', 120);
const skipAddLiquidity = process.argv.includes('--skip-add-liquidity');

const fee = Number(env.VITE_POOL_FEE || env.POOL_FEE || '0');
const tickSpacing = Number(env.VITE_POOL_TICK_SPACING || env.POOL_TICK_SPACING || '60');
const sqrtPriceX96 = BigInt(
  env.POOL_SQRT_PRICE_X96 || env.VITE_POOL_SQRT_PRICE_X96 || '79228162514264337593543950336'
);

const namespace = env.ROUND_NAMESPACE_BYTES32 || keccak256(toBytes('shadowpool'));
const durationSeconds = BigInt(env.ROUND_DURATION_SECONDS || '3600');
const intakeWindowSeconds = BigInt(env.ROUND_INTAKE_WINDOW_SECONDS || durationSeconds.toString());

const teeSigner = env.TEE_SIGNER_ADDRESS || env.VITE_ADMIN_ADDRESS || account.address;

console.log('[redeploy] RPC:', rpcUrl);
console.log('[redeploy] Deployer:', account.address);
console.log('[redeploy] fee:', fee, 'tickSpacing:', tickSpacing);

const poolManagerArtifact = loadArtifact('PoolManager.sol/PoolManager.json');
const swapTestArtifact = loadArtifact('PoolSwapTest.sol/PoolSwapTest.json');
const modifyTestArtifact = loadArtifact('PoolModifyLiquidityTest.sol/PoolModifyLiquidityTest.json');
const rootRegistryArtifact = loadArtifact('ShadowPoolRootRegistry.sol/ShadowPoolRootRegistry.json');
const intentRegistryArtifact = loadArtifact('IntentRegistry.sol/IntentRegistry.json');
const hookArtifact = loadArtifact('ShadowPoolHook.sol/ShadowPoolHook.json');
const mockErc20Artifact = loadArtifact('MockERC20.sol/MockERC20.json');

const manager = await deployContract({
  walletClient,
  publicClient,
  account,
  abi: poolManagerArtifact.abi,
  bytecode: poolManagerArtifact.bytecode,
  args: [account.address],
  label: 'PoolManager',
});

const swapRouter = await deployContract({
  walletClient,
  publicClient,
  account,
  abi: swapTestArtifact.abi,
  bytecode: swapTestArtifact.bytecode,
  args: [manager],
  label: 'PoolSwapTest',
});

const modifyLiquidityRouter = await deployContract({
  walletClient,
  publicClient,
  account,
  abi: modifyTestArtifact.abi,
  bytecode: modifyTestArtifact.bytecode,
  args: [manager],
  label: 'PoolModifyLiquidityTest',
});

const rootRegistry = await deployContract({
  walletClient,
  publicClient,
  account,
  abi: rootRegistryArtifact.abi,
  bytecode: rootRegistryArtifact.bytecode,
  args: [account.address],
  label: 'ShadowPoolRootRegistry',
});

const intentRegistry = await deployContract({
  walletClient,
  publicClient,
  account,
  abi: intentRegistryArtifact.abi,
  bytecode: intentRegistryArtifact.bytecode,
  args: [account.address, namespace, durationSeconds, intakeWindowSeconds],
  label: 'IntentRegistry',
});

const hookConstructorArgs = encodeAbiParameters(
  [
    { type: 'address' },
    { type: 'address' },
    { type: 'address' },
    { type: 'address' },
  ],
  [manager, rootRegistry, account.address, teeSigner]
);
const hookInitCode = concatHex([hookArtifact.bytecode, hookConstructorArgs]);
const hookInitCodeHash = keccak256(hookInitCode);
const { hookAddress, saltHex } = await findHookSalt({ publicClient, initCodeHash: hookInitCodeHash });
console.log('[redeploy] Hook mined:', hookAddress, 'salt', saltHex);

const deployData = concatHex([saltHex, hookInitCode]);
const hookTx = await sendSigned(walletClient, publicClient, account, { to: CREATE2_DEPLOYER, data: deployData });
await publicClient.waitForTransactionReceipt({ hash: hookTx });

const hookCode = await publicClient.getBytecode({ address: hookAddress });
if (!hookCode || hookCode === '0x') {
  throw new Error('Hook deployment failed (no bytecode at mined address)');
}
console.log('[redeploy] ShadowPoolHook:', hookAddress);

const hookAbi = parseAbi([
  'function setAllowedCaller(address caller, bool allowed)',
]);
await writeAndWait({
  walletClient,
  publicClient,
  label: 'setAllowedCaller',
  request: (
    await publicClient.simulateContract({
      address: hookAddress,
      abi: hookAbi,
      functionName: 'setAllowedCaller',
      args: [swapRouter, true],
      account,
    })
  ).request,
});

const tokenA = await deployContract({
  walletClient,
  publicClient,
  account,
  abi: mockErc20Artifact.abi,
  bytecode: mockErc20Artifact.bytecode,
  args: ['TokenA', 'TKA', 18],
  label: 'TokenA',
});

const tokenB = await deployContract({
  walletClient,
  publicClient,
  account,
  abi: mockErc20Artifact.abi,
  bytecode: mockErc20Artifact.bytecode,
  args: ['TokenB', 'TKB', 18],
  label: 'TokenB',
});

const mintAbi = parseAbi(['function mint(address to, uint256 value)']);
const mintAmount = parseUnits('10000000', 18);
const mintDataA = encodeFunctionData({
  abi: mintAbi,
  functionName: 'mint',
  args: [account.address, mintAmount],
});
const mintDataB = encodeFunctionData({
  abi: mintAbi,
  functionName: 'mint',
  args: [account.address, mintAmount],
});

const mintARequest = { to: tokenA, data: mintDataA, value: 0n };
const mintBRequest = { to: tokenB, data: mintDataB, value: 0n };

const mintAReceipt = await sendAndWait({
  walletClient,
  publicClient,
  account,
  label: 'mint TokenA',
  request: mintARequest,
});
const mintBReceipt = await sendAndWait({
  walletClient,
  publicClient,
  account,
  label: 'mint TokenB',
  request: mintBRequest,
});
if (mintAReceipt.contractAddress) {
  throw new Error(`mint TokenA: unexpected contract creation at ${mintAReceipt.contractAddress}`);
}
if (mintBReceipt.contractAddress) {
  throw new Error(`mint TokenB: unexpected contract creation at ${mintBReceipt.contractAddress}`);
}

const mintedALogs = parseTransferLogs(mintAReceipt, tokenA);
const mintedBLogs = parseTransferLogs(mintBReceipt, tokenB);
console.log('[redeploy] TokenA mint logs:', mintedALogs.length);
console.log('[redeploy] TokenB mint logs:', mintedBLogs.length);

const tokenAAddr = BigInt(tokenA.toLowerCase());
const tokenBAddr = BigInt(tokenB.toLowerCase());
const currency0 = tokenAAddr < tokenBAddr ? tokenA : tokenB;
const currency1 = tokenAAddr < tokenBAddr ? tokenB : tokenA;

const erc20ReadAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);
async function waitForBalance(address, label) {
  for (let i = 0; i < 20; i += 1) {
    const bal = await publicClient.readContract({
      address,
      abi: erc20ReadAbi,
      functionName: 'balanceOf',
      args: [account.address],
    });
    if (bal > 0n) return bal;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label}: balance still zero after mint`);
}

function parseTransferLogs(receipt, tokenAddress) {
  const topic = keccak256(toBytes('Transfer(address,address,uint256)'));
  return receipt.logs.filter(
    (log) =>
      log.address?.toLowerCase() === tokenAddress.toLowerCase() &&
      Array.isArray(log.topics) &&
      log.topics[0]?.toLowerCase() === topic.toLowerCase()
  );
}

const [balA, balB] = await Promise.all([waitForBalance(tokenA, 'TokenA'), waitForBalance(tokenB, 'TokenB')]);
console.log('[redeploy] Minted balances:', balA.toString(), balB.toString());

const managerAbi = parseAbi([
  'function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint160 sqrtPriceX96)',
  'function extsload(bytes32) view returns (bytes32)',
]);
await writeAndWait({
  walletClient,
  publicClient,
  label: 'initialize pool',
  request: (
    await publicClient.simulateContract({
      address: manager,
      abi: managerAbi,
      functionName: 'initialize',
      args: [{ currency0, currency1, fee, tickSpacing, hooks: hookAddress }, sqrtPriceX96],
      account,
    })
  ).request,
});

const poolId = keccak256(
  encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'uint24' },
      { type: 'int24' },
      { type: 'address' },
    ],
    [currency0, currency1, fee, tickSpacing, hookAddress]
  )
);
const POOLS_SLOT = toHex(6n, { size: 32 });
const poolStateSlot = keccak256(encodePacked(['bytes32', 'bytes32'], [poolId, POOLS_SLOT]));
const poolState = await publicClient.readContract({
  address: manager,
  abi: managerAbi,
  functionName: 'extsload',
  args: [poolStateSlot],
});
const poolStateWord = BigInt(poolState);
const sqrtPriceX96Check = poolStateWord & ((1n << 160n) - 1n);
const tickU24 = (poolStateWord >> 160n) & ((1n << 24n) - 1n);
const tickCheck = tickU24 >= (1n << 23n) ? Number(tickU24 - (1n << 24n)) : Number(tickU24);
const protocolFeeCheck = Number((poolStateWord >> 184n) & ((1n << 24n) - 1n));
const lpFeeCheck = Number((poolStateWord >> 208n) & ((1n << 24n) - 1n));
if (sqrtPriceX96Check === 0n) {
  console.warn('[redeploy] warning: pool slot0.sqrtPriceX96 is still 0 (pool not initialized?)');
} else {
  console.log('[redeploy] pool slot0:', {
    sqrtPriceX96: sqrtPriceX96Check.toString(),
    tick: tickCheck,
    protocolFee: protocolFeeCheck,
    lpFee: lpFeeCheck,
  });
}

const approvalsAbi = parseAbi(['function approve(address spender, uint256 value) returns (bool)']);
const maxApproval = (1n << 256n) - 1n;
await writeAndWait({
  walletClient,
  publicClient,
  label: 'approve TokenA',
  request: (
    await publicClient.simulateContract({
      address: tokenA,
      abi: approvalsAbi,
      functionName: 'approve',
      args: [modifyLiquidityRouter, maxApproval],
      account,
    })
  ).request,
});
await writeAndWait({
  walletClient,
  publicClient,
  label: 'approve TokenB',
  request: (
    await publicClient.simulateContract({
      address: tokenB,
      abi: approvalsAbi,
      functionName: 'approve',
      args: [modifyLiquidityRouter, maxApproval],
      account,
    })
  ).request,
});

const envUpdates = {
  VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS: intentRegistry,
  VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS: rootRegistry,
  VITE_SHADOWPOOL_HOOK_ADDRESS: hookAddress,
  VITE_POOL_SWAP_TEST_ADDRESS: swapRouter,
  VITE_POOL_MODIFY_LIQUIDITY_ADDRESS: modifyLiquidityRouter,
  VITE_TOKEN_A_ADDRESS: tokenA,
  VITE_TOKEN_B_ADDRESS: tokenB,
  VITE_POOL_FEE: String(fee),
  VITE_POOL_TICK_SPACING: String(tickSpacing),
};

updateEnvFile(envPath, envUpdates);

console.log('[redeploy] .env updated with new pool addresses');
console.log('[redeploy] Done. Restart dev server + relayer to pick up new addresses.');

if (!skipAddLiquidity) {
  console.log(`[redeploy] Adding liquidity: ticks ${tickLower}..${tickUpper}`);
  const result = spawnSync(
    process.execPath,
    [path.resolve(__dirname, 'add-liquidity.mjs'), `--tick-lower=${tickLower}`, `--tick-upper=${tickUpper}`],
    { stdio: 'inherit', env: { ...process.env, ...envUpdates } }
  );
  if (result.status !== 0) {
    console.warn('[redeploy] add-liquidity failed. You can rerun it manually.');
  }
}

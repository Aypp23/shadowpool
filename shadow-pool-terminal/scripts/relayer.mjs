import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { IExecDataProtector } from "@iexec/dataprotector";
import { IExec } from "iexec";
import { Wallet, JsonRpcProvider, verifyMessage, getBytes } from "ethers";
import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  http,
  keccak256,
  parseAbi,
  toBytes,
  recoverMessageAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ZERO_HASH = "0x" + "0".repeat(64);
const ZERO_ADDRESS = "0x" + "0".repeat(40);
const FALLBACK_IEXEC_WORKERPOOL =
  "0xB967057a21dc6A66A29721d96b8Aa7454B7c383F";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!key) continue;
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const envCandidates = [
  path.join(process.cwd(), ".env"),
  path.join(scriptDir, ".env"),
  path.join(scriptDir, "..", ".env"),
  path.join(scriptDir, "..", "..", ".env"),
];
for (const candidate of envCandidates) loadEnvFile(candidate);

const argv = process.argv.slice(2);
const shouldCheckTeeSigner = argv.includes("--check-tee-signer");

function getEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

function requireEnv(key, ...fallbackKeys) {
  const value = getEnv(key, ...fallbackKeys);
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[relayer ${ts}]`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(label, promise, ms) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label}: timed out after ${ms}ms`)),
        ms
      );
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function timed(label, fn) {
  const start = Date.now();
  log(`${label}...`);
  try {
    const result = await fn();
    log(`${label} ok ${Date.now() - start}ms`);
    return result;
  } catch (err) {
    log(
      `${label} failed ${Date.now() - start}ms: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    throw err;
  }
}

async function withRetries(label, fn, { retries = 4, baseDelayMs = 1200 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        log(`${label}: retrying in ${delay}ms`);
        await sleep(delay);
      }
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function isRelayerSignature(match) {
  if (!match || typeof match !== "object") return false;
  if (typeof match.signature !== "string" || typeof match.leaf !== "string") return false;
  try {
    const recovered = verifyMessage(getBytes(match.leaf), match.signature);
    return (
      typeof recovered === "string" &&
      recovered.toLowerCase() === account.address.toLowerCase()
    );
  } catch {
    return false;
  }
}

async function ensureRelayerSignature(match) {
  if (!match || typeof match !== "object") return false;
  if (typeof match.leaf !== "string" || !match.leaf.startsWith("0x")) return false;
  if (isRelayerSignature(match)) return false;
  match.signature = await ethersSigner.signMessage(getBytes(match.leaf));
  return true;
}

async function signMatchesFileIfNeeded(roundId) {
  const filePath = path.resolve(relayerMatchesDir, `${roundId}.json`);
  if (!fs.existsSync(filePath)) return false;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object") return false;
  const matches = Array.isArray(payload.matches) ? payload.matches : [];
  if (matches.length === 0) return false;

  let changed = false;
  for (const match of matches) {
    if (!match || typeof match !== "object") continue;
    try {
      const updated = await ensureRelayerSignature(match);
      if (updated) changed = true;
    } catch {}
  }

  if (!changed) return false;
  try {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return true;
  } catch {
    return false;
  }
}

const RPC_URL = requireEnv("RPC_URL", "RELAYER_RPC_URL", "VITE_RPC_URL");
const PRIVATE_KEY = requireEnv("PRIVATE_KEY", "RELAYER_PRIVATE_KEY");
const intentRegistry = requireEnv("VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS");
const rootRegistry = requireEnv("VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS");
const hookAddress = getEnv("VITE_SHADOWPOOL_HOOK_ADDRESS", "VITE_SHADOWPOOL_HOOK");
const iexecApp = requireEnv(
  "VITE_IEXEC_APP_ADDRESS",
  "VITE_IEXEC_APP",
  "VITE_IEXEC_APP_WHITELIST",
  "IEXEC_APP_ADDRESS"
);
const iexecWorkerpool =
  getEnv("VITE_IEXEC_WORKERPOOL_ADDRESS", "IEXEC_WORKERPOOL_ADDRESS") ||
  FALLBACK_IEXEC_WORKERPOOL;
const iexecWorkerpoolMaxPrice = Number(
  getEnv("VITE_IEXEC_WORKERPOOL_MAX_PRICE_NRLC", "IEXEC_WORKERPOOL_MAX_PRICE_NRLC") ||
    "1000000000"
);
const relayerMatchesDir =
  getEnv("RELAYER_MATCHES_DIR") ||
  path.resolve(scriptDir, "..", "data", "relayer");

const pollIntervalSeconds = Math.max(
  5,
  Number(getEnv("RELAYER_POLL_INTERVAL_SECONDS", "POLL_INTERVAL_SECONDS") || 60)
);
const postEndMatchingSeconds = Math.max(
  0,
  Number(
    getEnv(
      "RELAYER_POST_END_MATCHING_SECONDS",
      "VITE_POST_END_MATCHING_SECONDS",
      "VITE_MATCHING_GRACE_SECONDS"
    ) || 3600
  )
);
const rootValiditySeconds = Math.max(
  60,
  Number(
    getEnv(
      "RELAYER_ROOT_VALIDITY_SECONDS",
      "VITE_ROOT_VALIDITY_SECONDS",
      "VITE_ROOT_TTL_SECONDS"
    ) || 21600
  )
);
const relayerLookbackRounds = Math.max(
  1,
  Number(getEnv("RELAYER_LOOKBACK_ROUNDS") || 2)
);

const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ transport: http(RPC_URL) });
const walletClient = createWalletClient({ transport: http(RPC_URL), account });

const ethersProvider = new JsonRpcProvider(RPC_URL);
const ethersSigner = new Wallet(PRIVATE_KEY, ethersProvider);
const dataProtector = new IExecDataProtector(ethersSigner, {
  allowExperimentalNetworks: true,
});
const core = dataProtector.core;
const iexec = new IExec({ ethProvider: ethersSigner }, { allowExperimentalNetworks: true });

async function checkTeeSigner() {
  if (!hookAddress) {
    log("teeSigner check failed: missing VITE_SHADOWPOOL_HOOK_ADDRESS");
    process.exit(1);
  }
  const abi = parseAbi(["function teeSigner() view returns (address)"]);
  const teeSigner = await publicClient.readContract({
    address: hookAddress,
    abi,
    functionName: "teeSigner",
  });
  log(`hook teeSigner: ${teeSigner}`);
  log(`relayer address: ${account.address}`);
  const matches =
    typeof teeSigner === "string" &&
    teeSigner.toLowerCase() === account.address.toLowerCase();
  if (!matches) {
    log("teeSigner mismatch: relayer key will produce invalid signatures");
    process.exit(1);
  }
  log("teeSigner matches relayer");
  process.exit(0);
}

function asNrlcBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (value && typeof value === "object" && typeof value.toString === "function") {
    const s = value.toString();
    if (typeof s === "string" && /^\d+$/.test(s)) return BigInt(s);
  }
  return 0n;
}

async function ensureFreeAppOrderPublished({ app }) {
  const minTag = ["tee", "scone"];
  const maxTag = ["tee", "scone"];
  const appLower = String(app).toLowerCase();

  const hasFreeOrder = await withRetries(
    "fetchAppOrderbook",
    async () => {
      const book = await iexec.orderbook.fetchAppOrderbook({ app: appLower, minTag, maxTag });
      const orders = Array.isArray(book?.orders) ? book.orders : [];
      return orders.some((o) => {
        const order = o?.order;
        if (!order || typeof order !== "object") return false;
        if (String(order.app).toLowerCase() !== appLower) return false;
        const price = Number(order.appprice ?? Number.NaN);
        return Number.isFinite(price) && price <= 0;
      });
    },
    { retries: 6, baseDelayMs: 1200 }
  );

  if (hasFreeOrder) return;
  log(`No free apporder found, publishing one for app=${appLower}`);

  await withRetries(
    "publishApporder",
    async () => {
      const tpl = await iexec.order.createApporder({
        app: appLower,
        appprice: 0,
        volume: 1000000,
        tag: minTag,
      });
      const signed = await iexec.order.signApporder(tpl);
      await iexec.order.publishApporder(signed, { preflightCheck: false });
    },
    { retries: 4, baseDelayMs: 1500 }
  );
}

async function ensureRequesterStake({ minStakeNrlc }) {
  const minStake = asNrlcBigInt(minStakeNrlc);
  if (minStake <= 0n) return;

  const requesterAddress = await withRetries(
    "getRequesterAddress",
    () => iexec.wallet.getAddress(),
    { retries: 2, baseDelayMs: 800 }
  );
  const before = await withRetries(
    "checkAccountBalance",
    () => iexec.account.checkBalance(requesterAddress),
    { retries: 2, baseDelayMs: 800 }
  );
  const stakeBefore = asNrlcBigInt(before?.stake);
  if (stakeBefore >= minStake) return;

  const buffer = 100_000_000n;
  const toDeposit = minStake - stakeBefore + buffer;
  log(`Depositing to iExec account stake nRLC=${toDeposit.toString()}`);
  await withRetries(
    "accountDeposit",
    () => iexec.account.deposit(toDeposit.toString()),
    { retries: 2, baseDelayMs: 1200 }
  );

  const after = await withRetries(
    "checkAccountBalance",
    () => iexec.account.checkBalance(requesterAddress),
    { retries: 2, baseDelayMs: 800 }
  );
  const stakeAfter = asNrlcBigInt(after?.stake);
  log(`Requester stake after deposit nRLC=${stakeAfter.toString()}`);
}

const intentRegistryAbi = [
  {
    type: "function",
    name: "namespace",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "durationSeconds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "intakeWindowSeconds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getIntentCount",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getIntentAt",
    stateMutability: "view",
    inputs: [
      { name: "roundId", type: "bytes32" },
      { name: "index", type: "uint256" },
    ],
    outputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "trader", type: "address" },
          { name: "protectedData", type: "address" },
          { name: "commitment", type: "bytes32" },
          { name: "intentId", type: "bytes32" },
          { name: "timestamp", type: "uint64" },
        ],
      },
    ],
  },
];

const rootRegistryAbi = parseAbi([
  "function getRoundInfo(bytes32 roundId) view returns (bytes32 root, uint256 validUntil, address matcher, bool rootLocked, bool roundClosed, bool rootActive)",
  "function closeRound(bytes32 roundId) external",
  "function postRoot(bytes32 roundId, bytes32 root, uint256 validUntil) external",
]);

function computeRoundStartSeconds(timestampSeconds, durationSeconds) {
  if (durationSeconds <= 0n) return 0n;
  return (timestampSeconds / durationSeconds) * durationSeconds;
}

function computeRoundId(namespace, roundStartSeconds) {
  return keccak256(
    encodePacked(["bytes32", "uint256"], [namespace, roundStartSeconds])
  );
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function writeRelayerMatchesFile(roundId, payload) {
  try {
    if (!relayerMatchesDir) return;
    ensureDir(relayerMatchesDir);
    const filePath = path.join(relayerMatchesDir, `${roundId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    log(`wrote matches file ${filePath}`);
  } catch (err) {
    log(
      "failed to write matches file:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

async function getRoundConfig() {
  const [namespace, durationSeconds, intakeWindowSeconds] = await Promise.all([
    publicClient.readContract({
      address: intentRegistry,
      abi: intentRegistryAbi,
      functionName: "namespace",
    }),
    publicClient.readContract({
      address: intentRegistry,
      abi: intentRegistryAbi,
      functionName: "durationSeconds",
    }),
    publicClient.readContract({
      address: intentRegistry,
      abi: intentRegistryAbi,
      functionName: "intakeWindowSeconds",
    }),
  ]);

  return {
    namespace,
    durationSeconds: BigInt(durationSeconds),
    intakeWindowSeconds: BigInt(intakeWindowSeconds),
  };
}

async function getRoundInfo(roundId) {
  const info = await publicClient.readContract({
    address: rootRegistry,
    abi: rootRegistryAbi,
    functionName: "getRoundInfo",
    args: [roundId],
  });

  const [root, validUntil, matcher, rootLocked, roundClosed, rootActive] =
    info;
  return {
    root,
    validUntil: BigInt(validUntil),
    matcher,
    rootLocked,
    roundClosed,
    rootActive,
  };
}

async function getRoundIntents(roundId) {
  const count = await publicClient.readContract({
    address: intentRegistry,
    abi: intentRegistryAbi,
    functionName: "getIntentCount",
    args: [roundId],
  });
  const total = Number(count);
  const refs = [];
  for (let i = 0; i < total; i += 1) {
    const ref = await publicClient.readContract({
      address: intentRegistry,
      abi: intentRegistryAbi,
      functionName: "getIntentAt",
      args: [roundId, BigInt(i)],
    });
    refs.push(ref);
  }
  return { total, refs };
}

async function runMatching(
  roundId,
  protectedDataAddresses,
  commitmentsByProtectedData,
  protectedDataByTrader
) {
  const accessResults = await Promise.all(
    protectedDataAddresses.map(async (addr) => {
      try {
        return await core.getGrantedAccess({
          protectedData: addr,
          authorizedApp: iexecApp,
          authorizedUser: account.address,
          bulkOnly: true,
          pageSize: 1000,
        });
      } catch (err) {
        return {
          grantedAccess: [],
          __error:
            err instanceof Error ? err.message : String(err),
          __protectedData: addr,
        };
      }
    })
  );

  const bulkAccesses = accessResults.flatMap((res) =>
    Array.isArray(res?.grantedAccess) ? res.grantedAccess : []
  );

  if (bulkAccesses.length === 0) {
    const accessErrors = accessResults
      .filter((res) => res && res.__error)
      .map((res) => ({
        reason: "granted_access_error",
        protectedData: res.__protectedData ?? null,
        message: res.__error,
      }));
    return {
      matchCount: 0,
      merkleRoot: null,
      roundExpiry: null,
      debugSummary: null,
      debugErrors: [
        {
          reason: "no_bulk_access",
          wanted: protectedDataAddresses.length,
          granted: bulkAccesses.length,
        },
        ...accessErrors,
      ],
    };
  }

  await timed(
    `ensureFreeAppOrderPublished(app=${iexecApp})`,
    () =>
      withTimeout(
        "ensureFreeAppOrderPublished",
        ensureFreeAppOrderPublished({ app: iexecApp }),
        60_000
      )
  );

  const { bulkRequest } = await timed(
    "prepareBulkRequest",
    () =>
      withTimeout(
        "prepareBulkRequest",
        core.prepareBulkRequest({
          bulkAccesses,
          app: iexecApp,
          workerpool: iexecWorkerpool,
          workerpoolMaxPrice: iexecWorkerpoolMaxPrice,
          args: JSON.stringify({
            roundId,
            commitmentsByProtectedData: commitmentsByProtectedData ?? null,
            protectedDataByTrader: protectedDataByTrader ?? null,
          }),
          encryptResult: false,
          maxProtectedDataPerTask: 100,
        }),
        60_000
      )
  );

  await timed("ensureRequesterStake", () =>
    withTimeout(
      "ensureRequesterStake",
      ensureRequesterStake({
        minStakeNrlc:
          (asNrlcBigInt(bulkRequest?.appmaxprice) +
            asNrlcBigInt(bulkRequest?.datasetmaxprice) +
            asNrlcBigInt(bulkRequest?.workerpoolmaxprice)) *
          (asNrlcBigInt(bulkRequest?.volume) || 1n),
      }),
      120_000
    )
  );

  const statusUpdates = [];
  const { tasks } = await timed("processBulkRequest", () =>
    withTimeout(
      "processBulkRequest",
      core.processBulkRequest({
        bulkRequest,
        waitForResult: true,
        path: "result.json",
        onStatusUpdate: (update) => {
          if (!update || typeof update !== "object") return;
          const title = update.title ?? "UNKNOWN";
          const isDone = Boolean(update.isDone);
          if (isDone) statusUpdates.push(title);
          if (title && isDone) log(`[processBulkRequest] ${title} done`);
        },
      }),
      10 * 60_000
    )
  );

  const decoder = new TextDecoder();
  let merkleRoot = null;
  let roundExpiry = null;
  let matchCount = 0;
  const matches = [];
  let debugSummary = null;
  const debugErrors = [];
  const taskStats = {
    total: Array.isArray(tasks) ? tasks.length : 0,
    withResult: 0,
    statuses: [],
    statusUpdates,
  };

  if (!Array.isArray(tasks) || tasks.length === 0) {
    debugErrors.push({ reason: "no_tasks" });
  }

  for (const task of tasks ?? []) {
    const result = task?.result;
    if (!(result instanceof ArrayBuffer)) {
      debugErrors.push({ reason: 'missing_result', taskId: task?.taskId ?? null });
      continue;
    }
    taskStats.withResult += 1;
    if (task?.status) taskStats.statuses.push(task.status);
    if (task?.statusName) taskStats.statuses.push(task.statusName);
    if (task?.statusText) taskStats.statuses.push(task.statusText);
    const text = decoder.decode(new Uint8Array(result));
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      debugErrors.push({ reason: 'parse_failed', length: text.length });
      continue;
    }
    if (!json || typeof json !== "object") continue;
    if (!debugSummary) {
      const summary = {
        roundId: typeof json.roundId === "string" ? json.roundId : null,
        roundIdBytes32: typeof json.roundIdBytes32 === "string" ? json.roundIdBytes32 : null,
        intentsCount: typeof json.intentsCount === "number" ? json.intentsCount : null,
        eligibleIntentsCount:
          typeof json.eligibleIntentsCount === "number" ? json.eligibleIntentsCount : null,
        teeSigner: typeof json.teeSigner === "string" ? json.teeSigner : null,
        intents: [],
      };

      const intentsByProtectedData =
        json.intentsByProtectedData && typeof json.intentsByProtectedData === "object"
          ? json.intentsByProtectedData
          : null;
      if (intentsByProtectedData) {
        for (const [protectedData, info] of Object.entries(intentsByProtectedData)) {
          if (!info || typeof info !== "object") continue;
          summary.intents.push({
            protectedData,
            trader: typeof info.trader === "string" ? info.trader : null,
            side: typeof info.side === "string" ? info.side : null,
            baseToken: typeof info.baseToken === "string" ? info.baseToken : null,
            quoteToken: typeof info.quoteToken === "string" ? info.quoteToken : null,
            baseDecimals: Number.isFinite(info.baseDecimals) ? info.baseDecimals : null,
            quoteDecimals: Number.isFinite(info.quoteDecimals) ? info.quoteDecimals : null,
            expiry: Number.isFinite(info.expiry) ? info.expiry : null,
            eligible: typeof info.eligible === "boolean" ? info.eligible : null,
            commitmentValid:
              typeof info.commitmentValid === "boolean" ? info.commitmentValid : null,
          });
        }
      }
      debugSummary = summary;
    }
    if (typeof json.merkleRoot === "string") merkleRoot = json.merkleRoot;
    if (typeof json.roundExpiry === "number") roundExpiry = json.roundExpiry;
    if (Array.isArray(json.matches)) {
      matchCount += json.matches.length;
      for (const m of json.matches) {
        if (!m || typeof m !== "object") continue;
        const mo = m;
        const matchId =
          typeof mo.matchId === "string" ? mo.matchId : null;
        const matchIdHash =
          typeof mo.matchIdHash === "string"
            ? mo.matchIdHash
            : matchId
              ? keccak256(toBytes(matchId))
              : null;
        matches.push({ ...mo, matchId, matchIdHash });
      }
    }
  }

  if (merkleRoot && matches.length > 0) {
    const teeSigner = debugSummary?.teeSigner;
    const relayerAddress = ethersSigner?.address?.toLowerCase?.() ?? null;
    if (teeSigner && relayerAddress && teeSigner.toLowerCase() !== relayerAddress) {
      log(
        `warning: teeSigner ${teeSigner} does not match relayer ${ethersSigner.address}; signatures may be invalid`
      );
    }
    for (const match of matches) {
      if (!match || typeof match !== "object") continue;
      try {
        await ensureRelayerSignature(match);
      } catch (err) {
        debugErrors.push({
          reason: "sign_failed",
          matchId: typeof match.matchId === "string" ? match.matchId : null,
        });
      }
    }
    writeRelayerMatchesFile(roundId, {
      roundId,
      merkleRoot,
      roundExpiry,
      matches,
      generatedAt: new Date().toISOString(),
    });
  }

  return { matchCount, merkleRoot, roundExpiry, debugSummary, debugErrors, taskStats, matches };
}

async function closeAndPostRoot(roundId, merkleRoot, validUntil) {
  const { request: closeRequest } = await publicClient.simulateContract({
    address: rootRegistry,
    abi: rootRegistryAbi,
    functionName: "closeRound",
    args: [roundId],
    account,
  });
  const closeHash = await walletClient.writeContract(closeRequest);
  await publicClient.waitForTransactionReceipt({ hash: closeHash });

  const { request: postRequest } = await publicClient.simulateContract({
    address: rootRegistry,
    abi: rootRegistryAbi,
    functionName: "postRoot",
    args: [roundId, merkleRoot, BigInt(validUntil)],
    account,
  });
  const postHash = await walletClient.writeContract(postRequest);
  await publicClient.waitForTransactionReceipt({ hash: postHash });

  return { closeHash, postHash };
}

const seenRounds = new Set();
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const { namespace, durationSeconds, intakeWindowSeconds } =
      await getRoundConfig();
    const block = await publicClient.getBlock();
    const nowSeconds = BigInt(block.timestamp);
    const currentStart = computeRoundStartSeconds(
      nowSeconds,
      durationSeconds
    );

    const candidates = [];
    for (let i = 0; i < relayerLookbackRounds; i += 1) {
      const roundStartSeconds =
        currentStart - BigInt(i) * durationSeconds;
      const roundId = computeRoundId(namespace, roundStartSeconds);
      candidates.push({ roundId, roundStartSeconds });
    }

    for (const candidate of candidates) {
      const roundStartSeconds = candidate.roundStartSeconds;
      const roundId = candidate.roundId;
      const roundEndSeconds = roundStartSeconds + durationSeconds;
      const inRound = nowSeconds < roundEndSeconds;
      const inIntake =
        inRound && nowSeconds - roundStartSeconds < intakeWindowSeconds;
      const inMatchingWindow = inRound
        ? !inIntake
        : nowSeconds < roundEndSeconds + BigInt(postEndMatchingSeconds);
      const phase = inIntake
        ? "intake"
        : inMatchingWindow
          ? "matching"
          : "completed";

      const roundInfo = await getRoundInfo(roundId);
      const rootShort =
        typeof roundInfo.root === "string" && roundInfo.root !== ZERO_HASH
          ? `${roundInfo.root.slice(0, 10)}...`
          : "0x00...";

      log(
        `round=${roundId.slice(0, 10)}... phase=${phase} root=${rootShort} closed=${roundInfo.roundClosed}`
      );
      const signedExisting = await signMatchesFileIfNeeded(roundId);
      if (signedExisting) {
        log(`updated missing signatures for round ${roundId.slice(0, 10)}...`);
      }

      const rootExists = roundInfo.root && roundInfo.root !== ZERO_HASH;
      const rootExpired =
        rootExists &&
        roundInfo.validUntil &&
        roundInfo.validUntil > 0n &&
        roundInfo.validUntil <= nowSeconds;
      if (rootExpired && !roundInfo.rootLocked) {
        if (roundInfo.matcher && roundInfo.matcher !== ZERO_ADDRESS) {
          if (roundInfo.matcher.toLowerCase() !== account.address.toLowerCase()) {
            log(
              `skip: matcher already set to ${roundInfo.matcher}, not this relayer`
            );
            continue;
          }
        }
        const extendUntil = Number(nowSeconds) + rootValiditySeconds;
        log(`extending root validity to ${extendUntil}`);
        const { postHash } = await closeAndPostRoot(
          roundId,
          roundInfo.root,
          extendUntil
        );
        log(`root extended tx=${postHash}`);
        seenRounds.add(roundId);
        continue;
      }

      if (phase !== "matching") continue;
      if (rootExists) {
        seenRounds.add(roundId);
        continue;
      }
      if (roundInfo.matcher && roundInfo.matcher !== ZERO_ADDRESS) {
        if (roundInfo.matcher.toLowerCase() !== account.address.toLowerCase()) {
          log(
            `skip: matcher already set to ${roundInfo.matcher}, not this relayer`
          );
          continue;
        }
      }
      if (seenRounds.has(roundId)) continue;

      const { total, refs } = await getRoundIntents(roundId);
      if (total === 0) {
        log("no intents for round, skipping");
        seenRounds.add(roundId);
        continue;
      }

      const protectedDataSet = new Set();
      const commitments = {};
      const protectedDataByTrader = {};
      for (const ref of refs) {
        if (!ref || typeof ref !== "object") continue;
        const trader = ref.trader ?? ref[0];
        const protectedData = ref.protectedData ?? ref[1];
        const commitment = ref.commitment ?? ref[2];
        if (typeof protectedData === "string" && protectedData.length > 0) {
          protectedDataSet.add(protectedData.toLowerCase());
          if (typeof commitment === "string" && commitment.length > 0) {
            commitments[protectedData.toLowerCase()] = commitment;
          }
          if (typeof trader === "string" && trader.length > 0) {
            const key = trader.toLowerCase();
            const existing = protectedDataByTrader[key];
            if (Array.isArray(existing)) {
              if (!existing.includes(protectedData)) existing.push(protectedData);
            } else if (typeof existing === "string") {
              if (existing !== protectedData) {
                protectedDataByTrader[key] = [existing, protectedData];
              }
            } else {
              protectedDataByTrader[key] = [protectedData];
            }
          }
        }
      }
      const protectedDataAddresses = Array.from(protectedDataSet);
      if (protectedDataAddresses.length === 0) {
        log("no protected data addresses found, skipping");
        continue;
      }

      log(
        `running TEE matching with ${protectedDataAddresses.length} protected data`
      );
      const result = await runMatching(
        roundId,
        protectedDataAddresses,
        Object.keys(commitments).length ? commitments : null,
        Object.keys(protectedDataByTrader).length ? protectedDataByTrader : null
      );

      if (!result.merkleRoot) {
        log(`TEE returned no merkle root (matches=${result.matchCount})`);
        if (result.debugSummary) {
          log(`TEE debug summary: ${JSON.stringify(result.debugSummary)}`);
        }
        if (result.debugErrors && result.debugErrors.length > 0) {
          log(`TEE debug errors: ${JSON.stringify(result.debugErrors)}`);
        }
        if (result.taskStats) {
          log(`TEE task stats: ${JSON.stringify(result.taskStats)}`);
        }
        continue;
      }

      let validUntil =
        typeof result.roundExpiry === "number" && result.roundExpiry > 0
          ? result.roundExpiry
          : Number(roundEndSeconds);
      const minValidUntil = Number(nowSeconds) + rootValiditySeconds;
      if (validUntil <= minValidUntil) {
        validUntil = minValidUntil;
      }

      log(`posting merkle root (matches=${result.matchCount})`);
      const { postHash } = await closeAndPostRoot(
        roundId,
        result.merkleRoot,
        validUntil
      );
      log(`root posted tx=${postHash}`);
      seenRounds.add(roundId);
    }
  } catch (err) {
    log("error:", err instanceof Error ? err.message : String(err));
  } finally {
    running = false;
  }
}

log(`RPC: ${RPC_URL}`);
log(`Relayer: ${account.address}`);
log(`IntentRegistry: ${intentRegistry}`);
log(`RootRegistry: ${rootRegistry}`);
log(`iExec App: ${iexecApp}`);
log(`Polling every ${pollIntervalSeconds}s`);
log(`Post-end matching window: ${postEndMatchingSeconds}s`);
log(`Root validity seconds: ${rootValiditySeconds}s`);

if (shouldCheckTeeSigner) {
  await checkTeeSigner();
}

await tick();

// --- HTTP Server for serving matches ---
const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const privateAuthTtlSeconds = Math.max(
  60,
  Number(getEnv("PRIVATE_MATCHES_TTL_SECONDS", "VITE_PRIVATE_MATCHES_TTL_SECONDS") || 60 * 60 * 24 * 7)
);

function normalizeLower(value) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function isValidAddress(addr) {
  return typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function isFreshTimestamp(timestamp, ttlSeconds) {
  if (!Number.isFinite(timestamp)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - timestamp) <= ttlSeconds;
}

async function verifyPrivateAuth({ address, signature, timestamp, ttl }) {
  const addr = Array.isArray(address) ? address[0] : address;
  if (!isValidAddress(addr)) return false;
  const sig = Array.isArray(signature) ? signature[0] : signature;
  if (typeof sig !== "string" || !sig.startsWith("0x")) return false;
  if (!isFreshTimestamp(timestamp, ttl)) return false;
  const message = `shadowpool:matches:${addr}:${timestamp}`;
  try {
    const recovered = await recoverMessageAddress({ message, signature: sig });
    return normalizeLower(recovered) === normalizeLower(addr);
  } catch {
    return false;
  }
}

function sanitizeMatchesPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const matches = Array.isArray(payload.matches) ? payload.matches : [];
  return {
    roundId: typeof payload.roundId === "string" ? payload.roundId : undefined,
    merkleRoot: typeof payload.merkleRoot === "string" ? payload.merkleRoot : undefined,
    roundExpiry: typeof payload.roundExpiry === "number" ? payload.roundExpiry : undefined,
    generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : undefined,
    matchesCount: matches.length,
    matches: [],
  };
}

app.get("/api/rounds/:roundId/matches*", async (req, res) => {
  const { roundId } = req.params;
  const isPrivate = req.path.includes("/private");

  if (!/^0x[a-fA-F0-9]{64}$/.test(roundId)) {
    return res.status(400).json({ error: "Invalid roundId" });
  }

  const filePath = path.resolve(relayerMatchesDir, `${roundId}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Matches not found" });
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return res.status(500).json({ error: "Invalid matches payload" });
  }

  if (isPrivate) {
    const address = req.headers["x-shadowpool-address"];
    const signature = req.headers["x-shadowpool-signature"];
    const timestampHeader = req.headers["x-shadowpool-timestamp"];
    const timestamp = Number(Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader);

    const ok = await verifyPrivateAuth({ address, signature, timestamp, ttl: privateAuthTtlSeconds });
    if (!ok) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const matches = Array.isArray(payload.matches) ? payload.matches : [];
    const addrLower = normalizeLower(Array.isArray(address) ? address[0] : address);
    const filtered = matches.filter(
      (m) =>
        m &&
        typeof m === "object" &&
        normalizeLower(m.trader) === addrLower
    );

    return res.json({
      roundId: payload.roundId ?? roundId,
      merkleRoot: payload.merkleRoot,
      roundExpiry: payload.roundExpiry,
      generatedAt: payload.generatedAt,
      matchesCount: filtered.length,
      matches: filtered,
    });
  }

  const sanitized = sanitizeMatchesPayload(payload);
  if (!sanitized) {
    return res.status(500).json({ error: "Invalid matches payload" });
  }
  res.json(sanitized);
});

// Fallback for direct file access if needed (optional)
app.get("/relayer/:roundId.json", (req, res) => {
  const { roundId } = req.params;
  const filePath = path.resolve(relayerMatchesDir, `${roundId}.json`);
  if (fs.existsSync(filePath)) {
     // NOTE: We should probably sanitize this too if we want to be strict,
     // but the legacy fallback might expect full content. 
     // For safety, let's reuse the public sanitation logic or just not expose it 
     // if it's not needed. The code I wrote earlier used it as fallback.
     // But strictly speaking, public users shouldn't see private matches.
     // So let's sanitize it.
     try {
        const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const sanitized = sanitizeMatchesPayload(payload);
        res.json(sanitized);
     } catch {
        res.status(500).json({ error: "Error reading file" });
     }
  } else {
    res.status(404).json({ error: "Not found" });
  }
});

app.listen(port, () => {
  log(`HTTP server listening on port ${port}`);
});

setInterval(tick, pollIntervalSeconds * 1000);

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IExecDataProtector } from "@iexec/dataprotector";
import { IExec } from "iexec";
import { Wallet, JsonRpcProvider } from "ethers";
import {
  createPublicClient,
  encodePacked,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

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

const argv = process.argv.slice(2);
const roundIdArg = argv.find((a) => a.startsWith("--round-id="))?.split("=")[1] ?? null;
const lookbackArg = argv.find((a) => a.startsWith("--lookback="))?.split("=")[1] ?? null;
const shouldMatch = argv.includes("--match");
const ensureIexec = argv.includes("--ensure-iexec");

const lookbackRounds = Math.max(1, Number(lookbackArg ?? 2));

const RPC_URL = requireEnv("RPC_URL", "RELAYER_RPC_URL", "VITE_RPC_URL");
const PRIVATE_KEY = requireEnv("PRIVATE_KEY", "RELAYER_PRIVATE_KEY");
const intentRegistry = requireEnv("VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS");
const iexecApp = requireEnv(
  "VITE_IEXEC_APP_ADDRESS",
  "VITE_IEXEC_APP",
  "VITE_IEXEC_APP_WHITELIST",
  "IEXEC_APP_ADDRESS"
);
const iexecWorkerpool =
  getEnv("VITE_IEXEC_WORKERPOOL_ADDRESS", "IEXEC_WORKERPOOL_ADDRESS") ||
  "0xB967057a21dc6A66A29721d96b8Aa7454B7c383F";
const iexecWorkerpoolMaxPrice = Number(
  getEnv("VITE_IEXEC_WORKERPOOL_MAX_PRICE_NRLC", "IEXEC_WORKERPOOL_MAX_PRICE_NRLC") ||
    "1000000000"
);
const relayerMatchesDir =
  getEnv("RELAYER_MATCHES_DIR") ||
  path.resolve(scriptDir, "..", "data", "relayer");

const relayerAccount = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ transport: http(RPC_URL) });
const ethersProvider = new JsonRpcProvider(RPC_URL);
const ethersSigner = new Wallet(PRIVATE_KEY, ethersProvider);
const dataProtector = new IExecDataProtector(ethersSigner, {
  allowExperimentalNetworks: true,
});
const core = dataProtector.core;
const iexec = new IExec({ ethProvider: ethersSigner }, { allowExperimentalNetworks: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(label, fn, { retries = 4, baseDelayMs = 1200 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        console.log(`[relayer-debug] ${label}: retrying in ${delay}ms`);
        await sleep(delay);
      }
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function asNrlcBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (value && typeof value === "object" && typeof value.toString === "function") {
    const s = value.toString();
    if (typeof s === "string" && /^\d+$/.test(s)) return BigInt(s);
  }
  return 0n;
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
    console.log(`[relayer-debug] wrote matches file ${filePath}`);
  } catch (err) {
    console.log(
      "[relayer-debug] failed to write matches file:",
      err instanceof Error ? err.message : String(err)
    );
  }
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
  console.log(`[relayer-debug] No free apporder found, publishing one for app=${appLower}`);

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
  console.log(`[relayer-debug] Depositing to iExec account stake nRLC=${toDeposit.toString()}`);
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
  console.log(`[relayer-debug] Requester stake after deposit nRLC=${stakeAfter.toString()}`);
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

function computeRoundStartSeconds(timestampSeconds, durationSeconds) {
  if (durationSeconds <= 0n) return 0n;
  return (timestampSeconds / durationSeconds) * durationSeconds;
}

function computeRoundId(namespace, roundStartSeconds) {
  return keccak256(
    encodePacked(["bytes32", "uint256"], [namespace, roundStartSeconds])
  );
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

function toIntent(ref) {
  if (!ref || typeof ref !== "object") return null;
  const trader = ref.trader ?? ref[0];
  const protectedData = ref.protectedData ?? ref[1];
  const commitment = ref.commitment ?? ref[2];
  const intentId = ref.intentId ?? ref[3];
  const timestamp = ref.timestamp ?? ref[4];
  if (typeof protectedData !== "string" || !protectedData) return null;
  return {
    trader: typeof trader === "string" ? trader : null,
    protectedData,
    commitment: typeof commitment === "string" ? commitment : null,
    intentId: typeof intentId === "string" ? intentId : null,
    timestamp: typeof timestamp === "bigint" ? Number(timestamp) : Number(timestamp ?? NaN),
  };
}

function summarizeGrants(grants) {
  const seen = new Set();
  const summary = [];
  for (const g of grants ?? []) {
    const app = g?.apprestrict ?? null;
    const requester = g?.requesterrestrict ?? null;
    const key = `${app ?? "?"}:${requester ?? "?"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    summary.push({ app, requester });
    if (summary.length >= 6) break;
  }
  return summary;
}

async function runMatching(roundId, intents) {
  const protectedDataSet = new Set();
  const commitments = {};
  const protectedDataByTrader = {};
  for (const intent of intents) {
    if (!intent) continue;
    const protectedData = intent.protectedData;
    if (typeof protectedData === "string" && protectedData.length > 0) {
      protectedDataSet.add(protectedData.toLowerCase());
      if (typeof intent.commitment === "string" && intent.commitment.length > 0) {
        commitments[protectedData.toLowerCase()] = intent.commitment;
      }
      if (typeof intent.trader === "string" && intent.trader.length > 0) {
        const key = intent.trader.toLowerCase();
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
    console.log("[relayer-debug] No protected data addresses found.");
    return;
  }

  const accessResults = await Promise.all(
    protectedDataAddresses.map(async (addr) => {
      try {
        return await core.getGrantedAccess({
          protectedData: addr,
          authorizedApp: iexecApp,
          authorizedUser: relayerAccount.address,
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
        protectedData: res.__protectedData ?? null,
        message: res.__error,
      }));
    console.log(
      `[relayer-debug] no_bulk_access wanted=${protectedDataAddresses.length} granted=${bulkAccesses.length}`
    );
    if (accessErrors.length) {
      console.log(`[relayer-debug] accessErrors=${JSON.stringify(accessErrors)}`);
    }
    return;
  }

  if (ensureIexec) {
    await ensureFreeAppOrderPublished({ app: iexecApp });
  }

  const { bulkRequest } = await core.prepareBulkRequest({
    bulkAccesses,
    app: iexecApp,
    workerpool: iexecWorkerpool,
    workerpoolMaxPrice: iexecWorkerpoolMaxPrice,
    args: JSON.stringify({
      roundId,
      commitmentsByProtectedData: Object.keys(commitments).length ? commitments : null,
      protectedDataByTrader: Object.keys(protectedDataByTrader).length ? protectedDataByTrader : null,
    }),
    encryptResult: false,
    maxProtectedDataPerTask: 100,
  });

  console.log(
    `[relayer-debug] bulkRequest app=${bulkRequest?.app ?? "?"} requester=${bulkRequest?.requester ?? "?"} volume=${bulkRequest?.volume ?? "?"}`
  );

  if (ensureIexec) {
    await ensureRequesterStake({
      minStakeNrlc:
        (asNrlcBigInt(bulkRequest?.appmaxprice) +
          asNrlcBigInt(bulkRequest?.datasetmaxprice) +
          asNrlcBigInt(bulkRequest?.workerpoolmaxprice)) *
        (asNrlcBigInt(bulkRequest?.volume) || 1n),
    });
  }

  const statusUpdates = [];
  const started = Date.now();
  const { tasks } = await core.processBulkRequest({
    bulkRequest,
    waitForResult: true,
    path: "result.json",
    onStatusUpdate: (update) => {
      if (!update || typeof update !== "object") return;
      const title = update.title ?? "UNKNOWN";
      const isDone = Boolean(update.isDone);
      if (isDone) statusUpdates.push(title);
      const payload = update?.payload ?? null;
      const compactPayload =
        payload && typeof payload === "object"
          ? Object.fromEntries(
              Object.entries(payload).filter(([k]) =>
                ["txHash", "dealId", "taskId", "status", "success", "remainingVolume", "matchVolume"].includes(k)
              )
            )
          : payload;
      console.log(`[relayer-debug] ${title} ${isDone ? "done" : "..."} ${compactPayload ? JSON.stringify(compactPayload) : ""}`);
    },
  });
  const elapsedMs = Date.now() - started;

  const decoder = new TextDecoder();
  let merkleRoot = null;
  let roundExpiry = null;
  let matchCount = 0;
  let debugSummary = null;
  const debugErrors = [];
  const rawMatches = [];
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
      debugErrors.push({ reason: "missing_result", taskId: task?.taskId ?? null });
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
      debugErrors.push({ reason: "parse_failed", length: text.length });
      continue;
    }
    if (!json || typeof json !== "object") continue;
    if (!debugSummary) {
      debugSummary = {
        roundId: typeof json.roundId === "string" ? json.roundId : null,
        roundIdBytes32: typeof json.roundIdBytes32 === "string" ? json.roundIdBytes32 : null,
        intentsCount: typeof json.intentsCount === "number" ? json.intentsCount : null,
        eligibleIntentsCount:
          typeof json.eligibleIntentsCount === "number" ? json.eligibleIntentsCount : null,
        teeSigner: typeof json.teeSigner === "string" ? json.teeSigner : null,
      };
    }
    if (typeof json.merkleRoot === "string") merkleRoot = json.merkleRoot;
    if (typeof json.roundExpiry === "number") roundExpiry = json.roundExpiry;
    if (Array.isArray(json.matches)) {
      matchCount += json.matches.length;
      for (const m of json.matches) {
        if (m && typeof m === "object") rawMatches.push(m);
      }
    }
  }

  console.log(`[relayer-debug] processBulkRequest completed in ${elapsedMs}ms`);
  console.log(`[relayer-debug] merkleRoot=${merkleRoot ?? "null"} matches=${matchCount} roundExpiry=${roundExpiry ?? "null"}`);
  if (debugSummary) console.log(`[relayer-debug] debugSummary=${JSON.stringify(debugSummary)}`);
  if (debugErrors.length) console.log(`[relayer-debug] debugErrors=${JSON.stringify(debugErrors)}`);
  if (taskStats.total > 0) console.log(`[relayer-debug] taskStats=${JSON.stringify(taskStats)}`);

  if (merkleRoot && matchCount > 0 && Array.isArray(tasks)) {
    writeRelayerMatchesFile(roundId, {
      roundId,
      merkleRoot,
      roundExpiry,
      matches: rawMatches,
      generatedAt: new Date().toISOString(),
    });
  }
}

async function checkAccessForIntent(intent) {
  const protectedData = intent.protectedData;
  const relayerAddr = relayerAccount.address.toLowerCase();
  const appAddr = iexecApp.toLowerCase();

  const bulkForRelayer = await core.getGrantedAccess({
    protectedData,
    authorizedApp: iexecApp,
    authorizedUser: relayerAccount.address,
    bulkOnly: true,
  });
  const bulkCount = Number(bulkForRelayer?.count ?? 0);
  if (bulkCount > 0) {
    return { ok: true, reason: "bulk_access_ok", bulkCount, debug: null };
  }

  const bulkAny = await core.getGrantedAccess({
    protectedData,
    bulkOnly: true,
  });
  const bulkAnyCount = Number(bulkAny?.count ?? 0);

  const anyAccess = await core.getGrantedAccess({
    protectedData,
    bulkOnly: false,
  });
  const anyCount = Number(anyAccess?.count ?? 0);

  if (bulkAnyCount > 0) {
    const summary = summarizeGrants(bulkAny?.grantedAccess ?? []);
    const hasCorrectAppUser = (bulkAny?.grantedAccess ?? []).some(
      (g) =>
        typeof g?.dataset === "string" &&
        g.dataset.toLowerCase() === protectedData.toLowerCase() &&
        String(g?.apprestrict ?? "").toLowerCase() === appAddr &&
        String(g?.requesterrestrict ?? "").toLowerCase() === relayerAddr
    );
    return {
      ok: false,
      reason: hasCorrectAppUser ? "bulk_access_filtered" : "bulk_access_wrong_app_or_user",
      bulkCount,
      debug: { bulkAnyCount, summary },
    };
  }

  if (anyCount > 0) {
    return {
      ok: false,
      reason: "non_bulk_only",
      bulkCount,
      debug: { anyCount, summary: summarizeGrants(anyAccess?.grantedAccess ?? []) },
    };
  }

  return {
    ok: false,
    reason: "no_access",
    bulkCount,
    debug: null,
  };
}

async function run() {
  console.log("[relayer-debug] RPC:", RPC_URL);
  console.log("[relayer-debug] Relayer:", relayerAccount.address);
  console.log("[relayer-debug] IntentRegistry:", intentRegistry);
  console.log("[relayer-debug] iExec App:", iexecApp);

  const rounds = [];
  if (roundIdArg) {
    rounds.push(roundIdArg);
  } else {
    const { namespace, durationSeconds } = await getRoundConfig();
    const block = await publicClient.getBlock();
    const nowSeconds = BigInt(block.timestamp);
    const currentStart = computeRoundStartSeconds(nowSeconds, durationSeconds);
    for (let i = 0; i < lookbackRounds; i += 1) {
      const start = currentStart - BigInt(i) * durationSeconds;
      rounds.push(computeRoundId(namespace, start));
    }
  }

  for (const roundId of rounds) {
    console.log("\n[relayer-debug] Round:", roundId);
    const { total, refs } = await getRoundIntents(roundId);
    console.log(`[relayer-debug] Intents: ${total}`);
    if (total === 0) continue;

    const intents = refs.map(toIntent).filter(Boolean);
    for (const intent of intents) {
      const res = await checkAccessForIntent(intent);
      const shortPd = `${intent.protectedData.slice(0, 10)}...`;
      const shortTrader = intent.trader ? `${intent.trader.slice(0, 8)}...` : "unknown";
      console.log(
        `[relayer-debug] ${shortTrader} ${shortPd} -> ${res.ok ? "OK" : "MISSING"} (${res.reason})`
      );
      if (!res.ok && res.debug) {
        console.log(`[relayer-debug]   debug: ${JSON.stringify(res.debug)}`);
      }
    }

    if (shouldMatch) {
      console.log("[relayer-debug] Running matching...");
      await runMatching(roundId, intents);
    }
  }
}

await run();

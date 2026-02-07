import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "node:fs";
import { componentTagger } from "lovable-tagger";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { recoverMessageAddress } from "viem";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const defaults = getShadowPoolDefaultsFromLatestDeploy();
  const define: Record<string, string> = {};
  if (defaults) {
    for (const [k, v] of Object.entries(defaults)) {
      if (!process.env[k] && v) process.env[k] = v;
      if (process.env[k]) define[`import.meta.env.${k}`] = JSON.stringify(process.env[k]);
    }
  }

  return {
    envDir: path.resolve(__dirname, ".."),
    define,
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
    },
    plugins: [
      nodePolyfills({ protocolImports: true }),
      react(),
      mode === "development" && relayerMatchesDevMiddleware(),
      mode === "development" && componentTagger(),
    ].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});

function relayerMatchesDevMiddleware(): Plugin {
  const matchesDir =
    process.env.RELAYER_MATCHES_DIR || path.resolve(__dirname, "data", "relayer");
  const privateAuthTtlSeconds = Math.max(
    60,
    Number(
      process.env.PRIVATE_MATCHES_TTL_SECONDS ??
        process.env.VITE_PRIVATE_MATCHES_TTL_SECONDS ??
        60 * 60 * 24 * 7
    )
  );

  return {
    name: "shadowpool-relayer-matches",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const url = new URL(req.url, "http://localhost");
        if (!url.pathname.startsWith("/api/rounds/")) return next();
        const parts = url.pathname.split("/").filter(Boolean);
        const isPrivate = parts.length === 5 && parts[3] === "matches" && parts[4] === "private";
        if (parts.length !== 4 && !isPrivate) return next();
        const roundId = parts[2];
        if (!/^0x[a-fA-F0-9]{64}$/.test(roundId)) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "Invalid roundId" }));
          return;
        }
        const filePath = path.resolve(matchesDir, `${roundId}.json`);
        if (!fs.existsSync(filePath)) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "Matches not found" }));
          return;
        }
        const raw = fs.readFileSync(filePath, "utf8");
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "Invalid matches payload" }));
          return;
        }

        if (isPrivate) {
          const address = req.headers["x-shadowpool-address"];
          const signature = req.headers["x-shadowpool-signature"];
          const timestampHeader = req.headers["x-shadowpool-timestamp"];
          const timestamp = Number(Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader);
          verifyPrivateAuth({ address, signature, timestamp, ttl: privateAuthTtlSeconds })
            .then((ok) => {
              if (!ok) {
                res.statusCode = 401;
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ error: "Unauthorized" }));
                return;
              }
              const data = payload as Record<string, unknown>;
              const matches = Array.isArray(data.matches) ? data.matches : [];
              const addrLower = normalizeLower(Array.isArray(address) ? address[0] : address);
              const filtered = matches.filter(
                (m) =>
                  m &&
                  typeof m === "object" &&
                  normalizeLower((m as Record<string, unknown>).trader) === addrLower
              );
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.setHeader("Cache-Control", "no-store");
              res.end(
                JSON.stringify({
                  roundId: data.roundId ?? roundId,
                  merkleRoot: data.merkleRoot,
                  roundExpiry: data.roundExpiry,
                  generatedAt: data.generatedAt,
                  matchesCount: filtered.length,
                  matches: filtered,
                })
              );
            })
            .catch(() => {
              res.statusCode = 401;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ error: "Unauthorized" }));
            });
          return;
        }

        const sanitized = sanitizeMatchesPayload(payload);
        if (!sanitized) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "Invalid matches payload" }));
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(sanitized));
      });
    },
  };
}

function sanitizeMatchesPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const matchesCount = matches.length;

  return {
    roundId: typeof data.roundId === "string" ? data.roundId : undefined,
    merkleRoot: typeof data.merkleRoot === "string" ? data.merkleRoot : undefined,
    roundExpiry: typeof data.roundExpiry === "number" ? data.roundExpiry : undefined,
    generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : undefined,
    matchesCount,
    matches: [],
  };
}

function normalizeLower(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function isValidAddress(addr: unknown) {
  return typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function isFreshTimestamp(timestamp: number, ttlSeconds: number) {
  if (!Number.isFinite(timestamp)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - timestamp) <= ttlSeconds;
}

async function verifyPrivateAuth({
  address,
  signature,
  timestamp,
  ttl,
}: {
  address: unknown;
  signature: unknown;
  timestamp: number;
  ttl: number;
}) {
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

function getShadowPoolDefaultsFromLatestDeploy(): Record<string, string> | null {
  const chainId = 421614;
  const broadcastPath = path.resolve(
    __dirname,
    `../shadowpool-hook/broadcast/DeployShadowPool.s.sol/${chainId}/run-latest.json`
  );
  if (!fs.existsSync(broadcastPath)) return null;

  let broadcast: unknown;
  try {
    broadcast = JSON.parse(fs.readFileSync(broadcastPath, "utf8"));
  } catch {
    return null;
  }

  if (!broadcast || typeof broadcast !== "object") return null;
  const txs = (broadcast as { transactions?: unknown }).transactions;
  if (!Array.isArray(txs)) return null;

  const lastByName = (name: string) => {
    const matches = txs.filter((t) => t && typeof t === "object" && (t as { contractName?: unknown }).contractName === name);
    return (matches[matches.length - 1] ?? null) as
      | { contractAddress?: string; arguments?: unknown[] }
      | null;
  };

  const mockErc20s = txs.filter((t) => t && typeof t === "object" && (t as { contractName?: unknown }).contractName === "MockERC20") as Array<{
    contractAddress?: string;
    arguments?: unknown[];
  }>;
  const tokenA = mockErc20s.find((t) => Array.isArray(t.arguments) && t.arguments[0] === "TokenA");
  const tokenB = mockErc20s.find((t) => Array.isArray(t.arguments) && t.arguments[0] === "TokenB");

  const intentRegistry = lastByName("IntentRegistry");
  const rootRegistry = lastByName("ShadowPoolRootRegistry");
  const hook = lastByName("ShadowPoolHook");
  const swapRouter = lastByName("PoolSwapTest");

  const out: Record<string, string> = {};
  if (tokenA?.contractAddress) out.VITE_TOKEN_A_ADDRESS = tokenA.contractAddress;
  if (tokenB?.contractAddress) out.VITE_TOKEN_B_ADDRESS = tokenB.contractAddress;
  if (intentRegistry?.contractAddress) out.VITE_SHADOWPOOL_INTENT_REGISTRY_ADDRESS = intentRegistry.contractAddress;
  if (rootRegistry?.contractAddress) out.VITE_SHADOWPOOL_ROOT_REGISTRY_ADDRESS = rootRegistry.contractAddress;
  if (hook?.contractAddress) out.VITE_SHADOWPOOL_HOOK_ADDRESS = hook.contractAddress;
  if (swapRouter?.contractAddress) out.VITE_POOL_SWAP_TEST_ADDRESS = swapRouter.contractAddress;
  return Object.keys(out).length > 0 ? out : null;
}

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { recoverMessageAddress } from "viem";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(rootDir, "dist");
const matchesDir =
  process.env.RELAYER_MATCHES_DIR || path.resolve(rootDir, "data", "relayer");
const port = Number(process.env.PORT || 8080);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

const PRIVATE_AUTH_TTL_SECONDS = Math.max(
  60,
  Number(
    process.env.PRIVATE_MATCHES_TTL_SECONDS ??
      process.env.VITE_PRIVATE_MATCHES_TTL_SECONDS ??
      60 * 60 * 24 * 7
  )
);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function isValidRoundId(roundId) {
  return typeof roundId === "string" && /^0x[a-fA-F0-9]{64}$/.test(roundId);
}

function isValidAddress(addr) {
  return typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function parseJsonSafe(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function sanitizeMatchesPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const data = payload;
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const matchesCount = matches.length;

  const out = {
    roundId: typeof data.roundId === "string" ? data.roundId : undefined,
    merkleRoot: typeof data.merkleRoot === "string" ? data.merkleRoot : undefined,
    roundExpiry: typeof data.roundExpiry === "number" ? data.roundExpiry : undefined,
    generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : undefined,
    matchesCount,
    matches: [],
  };

  return out;
}

function normalizeLower(value) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function isFreshTimestamp(ts) {
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= PRIVATE_AUTH_TTL_SECONDS;
}

async function verifyPrivateAuth({ roundId, address, signature, timestamp }) {
  if (!isValidRoundId(roundId)) return false;
  const addr = Array.isArray(address) ? address[0] : address;
  if (!isValidAddress(addr)) return false;
  const sig = Array.isArray(signature) ? signature[0] : signature;
  if (typeof sig !== "string" || !sig.startsWith("0x")) return false;
  if (!Number.isFinite(timestamp) || !isFreshTimestamp(timestamp)) return false;

  const message = `shadowpool:matches:${addr}:${timestamp}`;
  try {
    const recovered = await recoverMessageAddress({ message, signature: sig });
    return normalizeLower(recovered) === normalizeLower(addr);
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname.startsWith("/api/rounds/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const roundId = parts[2];
    const tail = parts[3];
    const tail2 = parts[4];
    const isPrivate = tail === "matches" && tail2 === "private";
    if (tail !== "matches" && !isPrivate) {
      return send(res, 404, "Not found");
    }
    if (!isValidRoundId(roundId)) {
      return sendJson(res, 400, { error: "Invalid roundId" });
    }
    const filePath = path.resolve(matchesDir, `${roundId}.json`);
    const data = readFileSafe(filePath);
    if (!data) {
      return sendJson(res, 404, { error: "Matches not found" });
    }
    const payload = parseJsonSafe(data);
    if (!payload) {
      return sendJson(res, 500, { error: "Invalid matches payload" });
    }
    if (isPrivate) {
      const address = req.headers["x-shadowpool-address"];
      const signature = req.headers["x-shadowpool-signature"];
      const timestampHeader = req.headers["x-shadowpool-timestamp"];
      const timestamp = Number(Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader);
      const ok = await verifyPrivateAuth({
        roundId,
        address: Array.isArray(address) ? address[0] : address,
        signature: Array.isArray(signature) ? signature[0] : signature,
        timestamp,
      });
      if (!ok) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }
      const raw = payload;
      const matches = Array.isArray(raw.matches) ? raw.matches : [];
      const addrLower = normalizeLower(Array.isArray(address) ? address[0] : address);
      const filtered = matches.filter(
        (m) =>
          m &&
          typeof m === "object" &&
          normalizeLower(m.trader) === addrLower
      );
      return sendJson(res, 200, {
        roundId: raw.roundId ?? roundId,
        merkleRoot: raw.merkleRoot,
        roundExpiry: raw.roundExpiry,
        generatedAt: raw.generatedAt,
        matchesCount: filtered.length,
        matches: filtered,
      });
    }

    const sanitized = sanitizeMatchesPayload(payload);
    if (!sanitized) {
      return sendJson(res, 500, { error: "Invalid matches payload" });
    }
    return sendJson(res, 200, sanitized);
  }

  if (!fs.existsSync(distDir)) {
    return send(
      res,
      500,
      "Missing dist/ folder. Run `npm run build` before starting the server."
    );
  }

  let filePath = path.join(distDir, url.pathname);
  if (url.pathname.endsWith("/")) filePath = path.join(filePath, "index.html");
  const ext = path.extname(filePath);

  let data = readFileSafe(filePath);
  if (!data) {
    // SPA fallback
    const indexPath = path.join(distDir, "index.html");
    data = readFileSafe(indexPath);
    if (!data) {
      return send(res, 500, "Missing dist/index.html");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(data);
  }

  res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
  return res.end(data);
});

server.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  console.log(`[server] matches dir: ${matchesDir}`);
  console.log(`[server] dist dir: ${distDir}`);
});

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { encodeAbiParameters, isAddress, isHex, keccak256, parseUnits, toBytes } from 'viem';

const WAD = 10n ** 18n;

function getIexecIn() {
  return process.env.IEXEC_IN || '/iexec_in';
}

function getIexecOut() {
  return process.env.IEXEC_OUT || '/iexec_out';
}

function nowSeconds() {
  const override = process.env.NOW_SECONDS;
  if (override && /^\d+$/.test(override)) return Number(override);
  return Math.floor(Date.now() / 1000);
}

function toBytes32FromRoundId(roundId) {
  if (typeof roundId !== 'string') return null;
  if (isHex(roundId) && roundId.length === 66) return roundId;
  return keccak256(toBytes(roundId));
}

function normalizeDataObject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if ('data' in raw && raw.data && typeof raw.data === 'object') return raw.data;
  return raw;
}

function parseArgsRoundId() {
  const argString = process.env.IEXEC_ARGS || process.argv.slice(2).join(' ');
  if (!argString) return { roundId: null, roundIdBytes32: null };

  try {
    const parsed = JSON.parse(argString);
    const roundId = typeof parsed?.roundId === 'string' ? parsed.roundId : null;
    return { roundId, roundIdBytes32: toBytes32FromRoundId(roundId) };
  } catch {
    const fromKey =
      argString.match(/roundId\s*[:=]\s*"(0x[0-9a-fA-F]{64})"/)?.[1] ??
      argString.match(/roundId\s*[:=]\s*(0x[0-9a-fA-F]{64})/)?.[1] ??
      null;
    const fromAny = argString.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? null;
    const roundId = fromKey ?? fromAny ?? argString.trim();
    return { roundId, roundIdBytes32: toBytes32FromRoundId(roundId) };
  }
}

async function listJsonFilesRecursively(rootDir) {
  const results = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  return results.sort((a, b) => a.localeCompare(b));
}

function readU16LE(buf, offset) {
  return buf.readUInt16LE(offset);
}

function readU32LE(buf, offset) {
  return buf.readUInt32LE(offset);
}

function findZipEocdOffset(buf) {
  const sig = 0x06054b50;
  const maxBack = Math.min(buf.length, 65_557);
  for (let i = buf.length - 22; i >= buf.length - maxBack; i -= 1) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return null;
}

function extractZipEntriesFromLocalHeaders(buf) {
  const out = [];
  let offset = 0;
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;

    const compressionMethod = readU16LE(buf, offset + 8);
    const compressedSize = readU32LE(buf, offset + 18);
    const uncompressedSize = readU32LE(buf, offset + 22);
    const fileNameLen = readU16LE(buf, offset + 26);
    const extraLen = readU16LE(buf, offset + 28);

    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLen;
    const dataOffset = nameEnd + extraLen;
    const dataEnd = dataOffset + compressedSize;
    if (nameEnd > buf.length) break;
    if (dataEnd > buf.length) break;

    let fileName = null;
    try {
      fileName = buf.subarray(nameStart, nameEnd).toString('utf8');
    } catch {
      fileName = null;
    }

    const compressed = buf.subarray(dataOffset, dataEnd);
    try {
      if (compressionMethod === 0) out.push({ name: fileName, data: Buffer.from(compressed), size: uncompressedSize });
      else if (compressionMethod === 8) {
        try {
          out.push({ name: fileName, data: Buffer.from(inflateRawSync(compressed)), size: uncompressedSize });
        } catch {
          out.push({ name: fileName, data: Buffer.from(inflateSync(compressed)), size: uncompressedSize });
        }
      }
    } catch {}

    if (compressedSize === 0) break;
    offset = dataEnd;
  }
  return out;
}

function extractZipEntries(buf) {
  if (buf.length < 22) return [];
  if (buf.readUInt32LE(0) !== 0x04034b50) return [];

  const eocdOffset = findZipEocdOffset(buf);
  if (eocdOffset == null) return extractZipEntriesFromLocalHeaders(buf);

  const totalEntries = readU16LE(buf, eocdOffset + 10);
  const cdOffset = readU32LE(buf, eocdOffset + 16);
  if (cdOffset + 46 > buf.length) return [];

  const out = [];
  let offset = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (offset + 46 > buf.length) break;
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;

    const compressionMethod = readU16LE(buf, offset + 10);
    const compressedSize = readU32LE(buf, offset + 20);
    const uncompressedSize = readU32LE(buf, offset + 24);
    const fileNameLen = readU16LE(buf, offset + 28);
    const extraLen = readU16LE(buf, offset + 30);
    const commentLen = readU16LE(buf, offset + 32);
    const localHeaderOffset = readU32LE(buf, offset + 42);

    const fileName = (() => {
      const start = offset + 46;
      const end = start + fileNameLen;
      if (end > buf.length) return null;
      try {
        return buf.subarray(start, end).toString('utf8');
      } catch {
        return null;
      }
    })();

    const nextCd = offset + 46 + fileNameLen + extraLen + commentLen;
    offset = nextCd;

    if (localHeaderOffset + 30 > buf.length) continue;
    if (buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) continue;

    const localNameLen = readU16LE(buf, localHeaderOffset + 26);
    const localExtraLen = readU16LE(buf, localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;
    if (dataOffset + compressedSize > buf.length) continue;

    const compressed = buf.subarray(dataOffset, dataOffset + compressedSize);
    try {
      if (compressionMethod === 0) out.push({ name: fileName, data: Buffer.from(compressed), size: uncompressedSize });
      else if (compressionMethod === 8) {
        try {
          out.push({ name: fileName, data: Buffer.from(inflateRawSync(compressed)), size: uncompressedSize });
        } catch {
          out.push({ name: fileName, data: Buffer.from(inflateSync(compressed)), size: uncompressedSize });
        }
      }
    } catch {}
  }
  return out;
}

function tryParseJsonFromBuffer(buf) {
  if (!buf || buf.length === 0) return null;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return tryParseJsonFromBuffer(buf.subarray(3));
  }
  const trimmedStart = (() => {
    for (let i = 0; i < buf.length; i += 1) {
      const c = buf[i];
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) return c;
    }
    return null;
  })();

  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return tryParseJsonFromBuffer(Buffer.from(gunzipSync(buf)));
    } catch {
      return null;
    }
  }

  if (buf.length >= 2 && buf[0] === 0x78 && (buf[1] === 0x01 || buf[1] === 0x9c || buf[1] === 0xda)) {
    try {
      return tryParseJsonFromBuffer(Buffer.from(inflateSync(buf)));
    } catch {
      return null;
    }
  }

  if (trimmedStart === 0x7b || trimmedStart === 0x5b) {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return null;
    }
  }

  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    const entries = extractZipEntries(buf);
    const sorted = entries.slice().sort((a, b) => {
      const an = typeof a?.name === 'string' ? a.name.toLowerCase() : '';
      const bn = typeof b?.name === 'string' ? b.name.toLowerCase() : '';
      const aScore = an.endsWith('.json') ? 0 : an.endsWith('.txt') ? 1 : 2;
      const bScore = bn.endsWith('.json') ? 0 : bn.endsWith('.txt') ? 1 : 2;
      if (aScore !== bScore) return aScore - bScore;
      return an.localeCompare(bn);
    });
    for (const entry of sorted) {
      const inner = tryParseJsonFromBuffer(entry.data);
      if (inner) return inner;
    }
    return objectFromPathEntries(sorted);
  }

  return null;
}

function inspectZip(buf) {
  try {
    const entries = extractZipEntries(buf);
    return entries.slice(0, 32).map((e) => {
      const data = e?.data instanceof Buffer ? e.data : Buffer.alloc(0);
      return {
        name: typeof e?.name === 'string' ? e.name : null,
        size: data.length,
        magicHex: data.subarray(0, Math.min(8, data.length)).toString('hex'),
      };
    });
  } catch {
    return null;
  }
}

function decodeArchiveScalar(buf) {
  if (!buf || buf.length === 0) return null;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return decodeArchiveScalar(buf.subarray(3));
  }
  if (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (len === buf.length - 4) return buf.subarray(4).toString('utf8');
  }
  if (buf.length === 8) {
    const n = buf.readDoubleLE(0);
    return Number.isFinite(n) ? n : null;
  }
  if (buf.length === 1) {
    if (buf[0] === 0) return false;
    if (buf[0] === 1) return true;
  }
  const asUtf8 = buf.toString('utf8');
  const trimmed = asUtf8.trim();
  if (!trimmed) return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && String(asNum) === trimmed) return asNum;
  return asUtf8;
}

function objectFromPathEntries(entries) {
  const root = {};
  for (const e of entries) {
    const name = typeof e?.name === 'string' ? e.name : null;
    const data = e?.data instanceof Buffer ? e.data : null;
    if (!name || !data || data.length === 0) continue;
    if (name.endsWith('/')) continue;
    const parts = name.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const p = parts[i];
      const existing = cursor[p];
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) cursor[p] = {};
      cursor = cursor[p];
    }
    const leaf = parts[parts.length - 1];
    cursor[leaf] = decodeArchiveScalar(data);
  }
  return Object.keys(root).length > 0 ? root : null;
}

function parseIntent(raw, index, now) {
  const obj = normalizeDataObject(raw);
  if (!obj) return null;

  const side = typeof obj.side === 'string' ? obj.side : null;
  if (side !== 'buy' && side !== 'sell') return null;

  const trader = typeof obj.trader === 'string' ? obj.trader : null;
  const baseToken = typeof obj.baseToken === 'string' ? obj.baseToken : null;
  const quoteToken = typeof obj.quoteToken === 'string' ? obj.quoteToken : null;
  if (!trader || !baseToken || !quoteToken) return null;
  if (!isAddress(trader) || !isAddress(baseToken) || !isAddress(quoteToken)) return null;

  const expiry = typeof obj.expiry === 'number' ? obj.expiry : Number(obj.expiry);
  if (!Number.isFinite(expiry)) return null;

  const amountBaseStr = typeof obj.amountBase === 'string' ? obj.amountBase : String(obj.amountBase);
  const limitPriceStr = typeof obj.limitPrice === 'string' ? obj.limitPrice : String(obj.limitPrice);
  const slippageMinPct = typeof obj.slippageMin === 'number' ? obj.slippageMin : Number(obj.slippageMin);
  const slippageMaxPct = typeof obj.slippageMax === 'number' ? obj.slippageMax : Number(obj.slippageMax);

  const tokenPair = obj.tokenPair && typeof obj.tokenPair === 'object' ? obj.tokenPair : null;
  const baseDecimals = Number(tokenPair?.base?.decimals ?? 18);
  const quoteDecimals = Number(tokenPair?.quote?.decimals ?? 18);

  if (!Number.isFinite(baseDecimals) || baseDecimals < 0 || baseDecimals > 255) return null;
  if (!Number.isFinite(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 255) return null;

  let amountBaseWei;
  let priceWad;
  try {
    amountBaseWei = parseUnits(amountBaseStr, baseDecimals);
    priceWad = parseUnits(limitPriceStr, 18);
  } catch {
    return null;
  }

  if (amountBaseWei <= 0n || priceWad <= 0n) return null;

  const eligible = expiry > now;
  const slippageMinBps = Number.isFinite(slippageMinPct) && slippageMinPct > 0 ? Math.round(slippageMinPct * 100) : 0;
  const slippageMaxBps = Number.isFinite(slippageMaxPct) && slippageMaxPct > 0 ? Math.round(slippageMaxPct * 100) : 0;
  const safeSlippageMinBps = Math.min(Math.max(slippageMinBps, 0), 10_000);
  const safeSlippageMaxBps = Math.min(Math.max(slippageMaxBps, 0), 10_000);

  return {
    index,
    side,
    trader,
    baseToken,
    quoteToken,
    baseDecimals,
    quoteDecimals,
    amountBaseWeiRemaining: amountBaseWei,
    priceWad,
    expiry,
    eligible,
    slippageMinBps: safeSlippageMinBps,
    slippageMaxBps: safeSlippageMaxBps,
  };
}

function mulDivDown(a, b, denom) {
  if (denom === 0n) throw new Error('division by zero');
  return (a * b) / denom;
}

function applySlippageDown(amountWei, slippageBps) {
  const bps = typeof slippageBps === 'number' && Number.isFinite(slippageBps) ? slippageBps : 0;
  const clamped = Math.min(Math.max(bps, 0), 10_000);
  const numerator = BigInt(10_000 - clamped);
  return (amountWei * numerator) / 10_000n;
}

function quoteAmountWeiFromBaseWei({ baseWei, priceWad, baseDecimals, quoteDecimals }) {
  const scaleQuote = 10n ** BigInt(quoteDecimals);
  const scaleBase = 10n ** BigInt(baseDecimals);
  return mulDivDown(baseWei * priceWad * scaleQuote, 1n, scaleBase * WAD);
}

function bytesCompare(aHex, bHex) {
  const a = Buffer.from(aHex.slice(2), 'hex');
  const b = Buffer.from(bHex.slice(2), 'hex');
  return Buffer.compare(a, b);
}

function hashPairSorted(left, right) {
  const [a, b] = bytesCompare(left, right) <= 0 ? [left, right] : [right, left];
  return keccak256(`0x${a.slice(2)}${b.slice(2)}`);
}

function buildMerkle(leaves) {
  if (leaves.length === 0) {
    return {
      root: '0x0000000000000000000000000000000000000000000000000000000000000000',
      proofs: [],
    };
  }

  const layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i];
      const right = prev[i + 1] ?? prev[i];
      next.push(hashPairSorted(left, right));
    }
    layers.push(next);
  }

  const root = layers[layers.length - 1][0];
  const proofs = leaves.map((_, leafIndex) => {
    let idx = leafIndex;
    const proof = [];
    for (let level = 0; level < layers.length - 1; level += 1) {
      const layer = layers[level];
      const siblingIndex = idx ^ 1;
      const sibling = layer[siblingIndex] ?? layer[idx];
      proof.push(sibling);
      idx = Math.floor(idx / 2);
    }
    return proof;
  });

  return { root, proofs };
}

function computeLeaf({
  roundIdBytes32,
  matchIdString,
  trader,
  counterparty,
  tokenIn,
  tokenOut,
  amountIn,
  minAmountOut,
  expiry,
}) {
  const matchIdBytes32 = keccak256(toBytes(matchIdString));
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'roundId', type: 'bytes32' },
        { name: 'matchId', type: 'bytes32' },
        { name: 'trader', type: 'address' },
        { name: 'counterparty', type: 'address' },
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'minAmountOut', type: 'uint256' },
        { name: 'expiry', type: 'uint256' },
      ],
      [
        roundIdBytes32,
        matchIdBytes32,
        trader,
        counterparty,
        tokenIn,
        tokenOut,
        amountIn,
        minAmountOut,
        BigInt(expiry),
      ]
    )
  );
}

export function matchFromParsedIntents({ parsedIntents, now, roundIdBytes32 }) {
  const intentsCount = parsedIntents.length;
  const eligibleIntents = parsedIntents.filter((x) => x.eligible);
  const eligibleIntentsCount = eligibleIntents.length;

  const buysByPair = new Map();
  const sellsByPair = new Map();

  for (const intent of eligibleIntents) {
    const pairKey = [
      intent.baseToken.toLowerCase(),
      intent.quoteToken.toLowerCase(),
      String(intent.baseDecimals),
      String(intent.quoteDecimals),
    ].join('|');
    if (intent.side === 'buy') {
      const arr = buysByPair.get(pairKey) ?? [];
      arr.push(intent);
      buysByPair.set(pairKey, arr);
    } else {
      const arr = sellsByPair.get(pairKey) ?? [];
      arr.push(intent);
      sellsByPair.set(pairKey, arr);
    }
  }

  const pairKeys = Array.from(new Set([...buysByPair.keys(), ...sellsByPair.keys()])).sort((a, b) =>
    a.localeCompare(b)
  );

  const matchDrafts = [];
  let fillIndex = 0;

  for (const pairKey of pairKeys) {
    const buys = (buysByPair.get(pairKey) ?? []).slice();
    const sells = (sellsByPair.get(pairKey) ?? []).slice();

    buys.sort((a, b) => {
      if (a.priceWad === b.priceWad) return a.index - b.index;
      return a.priceWad > b.priceWad ? -1 : 1;
    });
    sells.sort((a, b) => {
      if (a.priceWad === b.priceWad) return a.index - b.index;
      return a.priceWad < b.priceWad ? -1 : 1;
    });

    let i = 0;
    let j = 0;
    while (i < buys.length && j < sells.length) {
      const buy = buys[i];
      const sell = sells[j];

      if (buy.priceWad < sell.priceWad) break;

      const fillBaseWei =
        buy.amountBaseWeiRemaining <= sell.amountBaseWeiRemaining
          ? buy.amountBaseWeiRemaining
          : sell.amountBaseWeiRemaining;

      if (fillBaseWei <= 0n) {
        if (buy.amountBaseWeiRemaining <= 0n) i += 1;
        if (sell.amountBaseWeiRemaining <= 0n) j += 1;
        continue;
      }

      const quoteWei = quoteAmountWeiFromBaseWei({
        baseWei: fillBaseWei,
        priceWad: sell.priceWad,
        baseDecimals: buy.baseDecimals,
        quoteDecimals: buy.quoteDecimals,
      });

      const expiry = Math.min(buy.expiry, sell.expiry);
      const baseToken = buy.baseToken;
      const quoteToken = buy.quoteToken;

      const buyerMatchId = `fill:${fillIndex}:buy:${buy.trader}:${sell.trader}`;
      const sellerMatchId = `fill:${fillIndex}:sell:${sell.trader}:${buy.trader}`;

      matchDrafts.push({
        matchId: buyerMatchId,
        trader: buy.trader,
        counterparty: sell.trader,
        tokenIn: quoteToken,
        tokenOut: baseToken,
        amountIn: quoteWei,
        minAmountOut: applySlippageDown(fillBaseWei, buy.slippageMaxBps),
        expiry,
      });
      matchDrafts.push({
        matchId: sellerMatchId,
        trader: sell.trader,
        counterparty: buy.trader,
        tokenIn: baseToken,
        tokenOut: quoteToken,
        amountIn: fillBaseWei,
        minAmountOut: applySlippageDown(quoteWei, sell.slippageMaxBps),
        expiry,
      });

      fillIndex += 1;
      buy.amountBaseWeiRemaining -= fillBaseWei;
      sell.amountBaseWeiRemaining -= fillBaseWei;

      if (buy.amountBaseWeiRemaining <= 0n) i += 1;
      if (sell.amountBaseWeiRemaining <= 0n) j += 1;
    }
  }

  const safeRoundIdBytes32 =
    roundIdBytes32 ?? '0x0000000000000000000000000000000000000000000000000000000000000000';
  const leaves = matchDrafts.map((m) =>
    computeLeaf({
      roundIdBytes32: safeRoundIdBytes32,
      matchIdString: m.matchId,
      trader: m.trader,
      counterparty: m.counterparty,
      tokenIn: m.tokenIn,
      tokenOut: m.tokenOut,
      amountIn: m.amountIn,
      minAmountOut: m.minAmountOut,
      expiry: m.expiry,
    })
  );

  const { root, proofs } = buildMerkle(leaves);

  const matches = matchDrafts.map((m, idx) => ({
    matchId: m.matchId,
    trader: m.trader,
    counterparty: m.counterparty,
    tokenIn: m.tokenIn,
    tokenOut: m.tokenOut,
    amountIn: m.amountIn.toString(),
    minAmountOut: m.minAmountOut.toString(),
    expiry: m.expiry,
    leaf: leaves[idx],
    merkleProof: proofs[idx],
    signature: null,
  }));

  const roundExpiry =
    matches.length > 0
      ? Math.min(...matches.map((m) => (typeof m.expiry === 'number' ? m.expiry : now)))
      : null;

  return {
    intentsCount,
    eligibleIntentsCount,
    merkleRoot: root,
    roundExpiry,
    matches,
  };
}

async function main() {
  const iexecIn = getIexecIn();
  const iexecOut = getIexecOut();
  await fs.mkdir(iexecOut, { recursive: true });

  const now = nowSeconds();
  const { roundId, roundIdBytes32 } = parseArgsRoundId();

  const inputFilesFolder =
    typeof process.env.IEXEC_INPUT_FILES_FOLDER === 'string' && process.env.IEXEC_INPUT_FILES_FOLDER.trim()
      ? process.env.IEXEC_INPUT_FILES_FOLDER.trim()
      : null;
  const candidatePaths = new Set();
  const resolveCandidatePaths = (name) => {
    if (typeof name !== 'string') return [];
    const trimmed = name.trim();
    if (!trimmed) return [];
    if (isAddress(trimmed)) return [];
    if (isHex(trimmed) && (trimmed.length === 66 || trimmed.length === 130)) return [];
    if (path.isAbsolute(trimmed)) return [trimmed];
    const out = [
      path.join(iexecIn, trimmed),
      path.join(iexecIn, 'input', trimmed),
      path.join(iexecIn, 'inputs', trimmed),
      path.join(iexecIn, 'dataset', trimmed),
    ];
    if (inputFilesFolder) out.push(path.join(inputFilesFolder, trimmed));
    return out;
  };

  const datasetFilename = process.env.IEXEC_DATASET_FILENAME;
  for (const p of resolveCandidatePaths(datasetFilename)) candidatePaths.add(p);

  const inputFilesCountRaw = process.env.IEXEC_INPUT_FILES_NUMBER;
  const inputFilesCount = inputFilesCountRaw && /^\d+$/.test(inputFilesCountRaw) ? Number(inputFilesCountRaw) : 0;
  for (let i = 1; i <= inputFilesCount; i += 1) {
    const name =
      process.env[`IEXEC_INPUT_FILE_NAME_${i}`] ??
      process.env[`IEXEC_INPUT_FILE_NAME${i}`] ??
      process.env[`IEXEC_INPUT_FILE_${i}`] ??
      null;
    for (const p of resolveCandidatePaths(name)) candidatePaths.add(p);
  }

  const jsonFiles = candidatePaths.size > 0 ? Array.from(candidatePaths) : await listJsonFilesRecursively(iexecIn);
  const parsedIntents = [];
  const debugInputs = [];
  const debugParsed = [];

  for (let i = 0; i < jsonFiles.length; i += 1) {
    const filePath = jsonFiles[i];
    let raw = null;
    try {
      const buf = await fs.readFile(filePath);
      if (debugInputs.length < 32) {
        debugInputs.push({
          path: filePath,
          size: buf.length,
          magicHex: buf.subarray(0, Math.min(8, buf.length)).toString('hex'),
        });
      }
      const zipEntriesDebug =
        debugParsed.length < 16 && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50 ? inspectZip(buf) : null;
      raw = tryParseJsonFromBuffer(buf);
      if (debugParsed.length < 16) {
        const obj = raw && typeof raw === 'object' ? raw : null;
        const topKeys = obj ? Object.keys(obj).slice(0, 32) : [];
        const dataObj = obj && typeof obj.data === 'object' && obj.data ? obj.data : null;
        const dataKeys = dataObj ? Object.keys(dataObj).slice(0, 32) : [];
        debugParsed.push({
          path: filePath,
          parsed: Boolean(raw),
          zipEntries: zipEntriesDebug,
          topKeys,
          dataKeys,
          sample: dataObj
            ? {
                trader: typeof dataObj.trader === 'string' ? dataObj.trader : null,
                side: typeof dataObj.side === 'string' ? dataObj.side : null,
                baseToken: typeof dataObj.baseToken === 'string' ? dataObj.baseToken : null,
                quoteToken: typeof dataObj.quoteToken === 'string' ? dataObj.quoteToken : null,
                expiry: typeof dataObj.expiry === 'number' ? dataObj.expiry : typeof dataObj.expiry === 'string' ? dataObj.expiry : null,
              }
            : obj
              ? {
                  trader: typeof obj.trader === 'string' ? obj.trader : null,
                  side: typeof obj.side === 'string' ? obj.side : null,
                  baseToken: typeof obj.baseToken === 'string' ? obj.baseToken : null,
                  quoteToken: typeof obj.quoteToken === 'string' ? obj.quoteToken : null,
                  expiry: typeof obj.expiry === 'number' ? obj.expiry : typeof obj.expiry === 'string' ? obj.expiry : null,
                }
              : null,
        });
      }
    } catch (err) {
      if (debugInputs.length < 32) {
        debugInputs.push({
          path: filePath,
          size: null,
          magicHex: null,
          readError: err && typeof err === 'object' ? (err.code ?? err.message ?? 'read_error') : 'read_error',
        });
      }
      continue;
    }
    if (!raw) continue;
    const intent = parseIntent(raw, parsedIntents.length, now);
    if (intent) parsedIntents.push(intent);
  }

  const safeRoundIdBytes32 =
    roundIdBytes32 ?? '0x0000000000000000000000000000000000000000000000000000000000000000';
  const { intentsCount, eligibleIntentsCount, merkleRoot, roundExpiry, matches } = matchFromParsedIntents({
    parsedIntents,
    now,
    roundIdBytes32: safeRoundIdBytes32,
  });

  const result = {
    roundId: roundId ?? null,
    roundIdBytes32: safeRoundIdBytes32,
    intentsCount,
    eligibleIntentsCount,
    merkleRoot,
    roundExpiry,
    matches,
    debugEnv: {
      IEXEC_IN: process.env.IEXEC_IN ?? null,
      IEXEC_OUT: process.env.IEXEC_OUT ?? null,
      IEXEC_DATASET_FILENAME: process.env.IEXEC_DATASET_FILENAME ?? null,
      IEXEC_INPUT_FILES_NUMBER: process.env.IEXEC_INPUT_FILES_NUMBER ?? null,
      IEXEC_INPUT_FILES_FOLDER: process.env.IEXEC_INPUT_FILES_FOLDER ?? null,
    },
    debugInputs,
    debugParsed,
  };

  const resultPath = path.join(iexecOut, 'result.json');
  await fs.writeFile(resultPath, JSON.stringify(result));

  const computedJsonObj = { 'deterministic-output-path': resultPath };
  await fs.writeFile(path.join(iexecOut, 'computed.json'), JSON.stringify(computedJsonObj));
}

async function runCli() {
  try {
    await main();
  } catch {
    const iexecOut = getIexecOut();
    try {
      await fs.mkdir(iexecOut, { recursive: true });
      const computedJsonObj = { 'deterministic-output-path': path.join(iexecOut, 'result.json') };
      await fs.writeFile(path.join(iexecOut, 'result.json'), JSON.stringify({ error: 'runtime_error' }));
      await fs.writeFile(path.join(iexecOut, 'computed.json'), JSON.stringify(computedJsonObj));
    } catch {}
    process.exitCode = 1;
  }
}

const isDirectRun = (() => {
  if (!process.argv?.[1]) return false;
  const candidate = pathToFileURL(path.resolve(process.argv[1])).href;
  return candidate === import.meta.url;
})();

if (isDirectRun) {
  await runCli();
}

export { parseIntent };

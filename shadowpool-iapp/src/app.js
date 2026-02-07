import { promises as fs } from 'node:fs';
import path from 'node:path';
import { encodeAbiParameters, isAddress, isHex, keccak256, parseUnits, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const WAD = 10n ** 18n;
const BPS = 10_000n;
const MIN_OUT_BPS = 9_900n;

function getTeeAccount() {
  const pk = process.env.TEE_PRIVATE_KEY;
  if (!pk || typeof pk !== 'string') return null;
  if (!isHex(pk) || pk.length !== 66) return null;
  return privateKeyToAccount(pk);
}

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

function findFirstAddress(input) {
  if (typeof input !== 'string') return null;
  const match = input.match(/0x[0-9a-fA-F]{40}/);
  return match ? match[0] : null;
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
    const commitmentsByProtectedData =
      parsed?.commitmentsByProtectedData && typeof parsed.commitmentsByProtectedData === 'object'
        ? parsed.commitmentsByProtectedData
        : null;
    const protectedDataByTrader =
      parsed?.protectedDataByTrader && typeof parsed.protectedDataByTrader === 'object' ? parsed.protectedDataByTrader : null;
    return { roundId, roundIdBytes32: toBytes32FromRoundId(roundId), commitmentsByProtectedData, protectedDataByTrader };
  } catch {
    const roundId = argString.trim();
    return { roundId, roundIdBytes32: toBytes32FromRoundId(roundId), commitmentsByProtectedData: null, protectedDataByTrader: null };
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
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        results.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  return results.sort((a, b) => a.localeCompare(b));
}

function computeIntentCommitment(args) {
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
        BigInt(args.expiry),
        args.saltBytes32,
      ]
    )
  );
}

function parseIntent(raw, index, now, opts) {
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

  const protectedDataAddress =
    typeof opts?.protectedDataAddress === 'string' && isAddress(opts.protectedDataAddress)
      ? opts.protectedDataAddress
      : null;
  const commitmentExpected =
    typeof opts?.commitmentExpected === 'string' && isHex(opts.commitmentExpected) && opts.commitmentExpected.length === 66
      ? opts.commitmentExpected
      : null;

  const saltCandidate = typeof obj.salt === 'string' ? obj.salt : typeof obj.saltBytes32 === 'string' ? obj.saltBytes32 : null;
  const saltBytes32 = saltCandidate && isHex(saltCandidate) && saltCandidate.length === 66 ? saltCandidate : null;

  let commitmentComputed = null;
  let commitmentValid = null;
  if (commitmentExpected) {
    if (!saltBytes32) {
      commitmentValid = false;
    } else {
      try {
        commitmentComputed = computeIntentCommitment({
          side,
          trader,
          baseToken,
          quoteToken,
          amountBase: amountBaseStr,
          baseDecimals,
          limitPrice: limitPriceStr,
          expiry,
          saltBytes32,
        });
        commitmentValid = commitmentComputed.toLowerCase() === commitmentExpected.toLowerCase();
      } catch {
        commitmentValid = false;
      }
    }
  }

  let eligible = expiry > now;
  if (opts?.commitmentRequired) {
    if (!protectedDataAddress || !commitmentExpected) {
      eligible = false;
    } else {
      eligible = eligible && commitmentValid === true;
    }
  } else {
    eligible = eligible && commitmentValid !== false;
  }

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
    protectedDataAddress,
    commitmentExpected,
    commitmentComputed,
    commitmentValid,
  };
}

function mulDivDown(a, b, denom) {
  if (denom === 0n) throw new Error('division by zero');
  return (a * b) / denom;
}

function quoteAmountWeiFromBaseWei({ baseWei, priceWad, baseDecimals, quoteDecimals }) {
  const scaleQuote = 10n ** BigInt(quoteDecimals);
  const scaleBase = 10n ** BigInt(baseDecimals);
  return mulDivDown(baseWei * priceWad * scaleQuote, 1n, scaleBase * WAD);
}

function applySlippageFloor(amount) {
  return mulDivDown(amount, MIN_OUT_BPS, BPS);
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
    return { root: '0x0000000000000000000000000000000000000000000000000000000000000000', proofs: [] };
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

async function main() {
  const iexecIn = getIexecIn();
  const iexecOut = getIexecOut();
  await fs.mkdir(iexecOut, { recursive: true });

  const now = nowSeconds();
  const { roundId, roundIdBytes32, commitmentsByProtectedData, protectedDataByTrader } = parseArgsRoundId();
  const teeAccount = getTeeAccount();

  const jsonFiles = await listJsonFilesRecursively(iexecIn);
  const parsedIntents = [];
  const intentsByProtectedData = {};
  const commitmentRequired = !!(commitmentsByProtectedData && typeof commitmentsByProtectedData === 'object');

  for (let i = 0; i < jsonFiles.length; i += 1) {
    const filePath = jsonFiles[i];
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      continue;
    }
    const obj = normalizeDataObject(raw);
    const traderFromPayload = typeof obj?.trader === 'string' ? obj.trader : null;
    const protectedDataAddress =
      findFirstAddress(filePath) ??
      findFirstAddress(JSON.stringify(raw)) ??
      (traderFromPayload && protectedDataByTrader && typeof protectedDataByTrader === 'object'
        ? protectedDataByTrader[String(traderFromPayload).toLowerCase()] ?? protectedDataByTrader[String(traderFromPayload)]
        : null);
    const commitmentExpected =
      protectedDataAddress && commitmentsByProtectedData && typeof commitmentsByProtectedData === 'object'
        ? commitmentsByProtectedData[String(protectedDataAddress).toLowerCase()] ?? commitmentsByProtectedData[String(protectedDataAddress)]
        : null;
    const intent = parseIntent(raw, parsedIntents.length, now, {
      protectedDataAddress,
      commitmentExpected,
      commitmentRequired,
    });
    if (intent) {
      parsedIntents.push(intent);
      if (intent.protectedDataAddress) {
        intentsByProtectedData[intent.protectedDataAddress.toLowerCase()] = {
          protectedDataAddress: intent.protectedDataAddress,
          trader: intent.trader,
          side: intent.side,
          baseToken: intent.baseToken,
          quoteToken: intent.quoteToken,
          baseDecimals: intent.baseDecimals,
          quoteDecimals: intent.quoteDecimals,
          expiry: intent.expiry,
          eligible: intent.eligible,
          commitmentExpected: intent.commitmentExpected,
          commitmentComputed: intent.commitmentComputed,
          commitmentValid: intent.commitmentValid,
        };
      }
    }
  }

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

  const pairKeys = Array.from(new Set([...buysByPair.keys(), ...sellsByPair.keys()])).sort(
    (a, b) => a.localeCompare(b)
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
        traderProtectedDataAddress: buy.protectedDataAddress ?? null,
        counterpartyProtectedDataAddress: sell.protectedDataAddress ?? null,
        tokenIn: quoteToken,
        tokenOut: baseToken,
        amountIn: quoteWei,
        minAmountOut: applySlippageFloor(fillBaseWei),
        expiry,
      });
      matchDrafts.push({
        matchId: sellerMatchId,
        trader: sell.trader,
        counterparty: buy.trader,
        traderProtectedDataAddress: sell.protectedDataAddress ?? null,
        counterpartyProtectedDataAddress: buy.protectedDataAddress ?? null,
        tokenIn: baseToken,
        tokenOut: quoteToken,
        amountIn: fillBaseWei,
        minAmountOut: applySlippageFloor(quoteWei),
        expiry,
      });

      fillIndex += 1;
      buy.amountBaseWeiRemaining -= fillBaseWei;
      sell.amountBaseWeiRemaining -= fillBaseWei;

      if (buy.amountBaseWeiRemaining <= 0n) i += 1;
      if (sell.amountBaseWeiRemaining <= 0n) j += 1;
    }
  }

  const safeRoundIdBytes32 = roundIdBytes32 ?? '0x0000000000000000000000000000000000000000000000000000000000000000';
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

  const matches = [];
  for (let idx = 0; idx < matchDrafts.length; idx += 1) {
    const m = matchDrafts[idx];
    const leaf = leaves[idx];
    matches.push({
      matchId: m.matchId,
      matchIdHash: keccak256(toBytes(m.matchId)),
      trader: m.trader,
      counterparty: m.counterparty,
      traderProtectedDataAddress: m.traderProtectedDataAddress ?? null,
      counterpartyProtectedDataAddress: m.counterpartyProtectedDataAddress ?? null,
      tokenIn: m.tokenIn,
      tokenOut: m.tokenOut,
      amountIn: m.amountIn.toString(),
      minAmountOut: m.minAmountOut.toString(),
      expiry: m.expiry,
      leaf,
      merkleProof: proofs[idx],
      signature: teeAccount
        ? await teeAccount.signMessage({
            message: {
              raw: toBytes(leaf),
            },
          })
        : null,
    });
  }

  const roundExpiry =
    matches.length > 0 ? Math.min(...matches.map((m) => (typeof m.expiry === 'number' ? m.expiry : now))) : null;

  const result = {
    roundId: roundId ?? null,
    roundIdBytes32: safeRoundIdBytes32,
    intentsCount,
    eligibleIntentsCount,
    intentsByProtectedData,
    merkleRoot: root,
    roundExpiry,
    teeSigner: teeAccount ? teeAccount.address : null,
    matches,
  };

  const resultPath = path.join(iexecOut, 'result.json');
  await fs.writeFile(resultPath, JSON.stringify(result));

  const computedJsonObj = { 'deterministic-output-path': resultPath };
  await fs.writeFile(path.join(iexecOut, 'computed.json'), JSON.stringify(computedJsonObj));
}

main().catch(async () => {
  const iexecOut = getIexecOut();
  try {
    await fs.mkdir(iexecOut, { recursive: true });
    const computedJsonObj = { 'deterministic-output-path': path.join(iexecOut, 'result.json') };
    await fs.writeFile(path.join(iexecOut, 'result.json'), JSON.stringify({ error: 'runtime_error' }));
    await fs.writeFile(path.join(iexecOut, 'computed.json'), JSON.stringify(computedJsonObj));
  } catch {}
  process.exitCode = 1;
});

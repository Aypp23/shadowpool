import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from 'viem';
import { matchFromParsedIntents, parseIntent } from '../src/app.js';

const BASE = '0x1000000000000000000000000000000000000001';
const QUOTE = '0x2000000000000000000000000000000000000002';
const BASE2 = '0x3000000000000000000000000000000000000003';
const QUOTE2 = '0x4000000000000000000000000000000000000004';

const TRADER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TRADER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TRADER_C = '0xcccccccccccccccccccccccccccccccccccccccc';

function makeRawIntent({
  trader,
  side,
  baseToken = BASE,
  quoteToken = QUOTE,
  amountBase,
  limitPrice,
  expiry,
  slippageMin = 0,
  slippageMax = 0,
  baseDecimals = 18,
  quoteDecimals = 18,
}) {
  return {
    data: {
      version: '1',
      trader,
      side,
      baseToken,
      quoteToken,
      amountBase,
      limitPrice,
      expiry,
      salt: '0x' + '11'.repeat(32),
      tokenPair: {
        base: { address: baseToken, decimals: baseDecimals },
        quote: { address: quoteToken, decimals: quoteDecimals },
      },
      slippageMin,
      slippageMax,
      notes: 'test',
    },
  };
}

test('matches multiple intents with partial fills', () => {
  const now = 1_000_000;
  const expiry = now + 3600;

  const raw = [
    makeRawIntent({ trader: TRADER_A, side: 'buy', amountBase: '15', limitPrice: '1', expiry }),
    makeRawIntent({ trader: TRADER_C, side: 'buy', amountBase: '5', limitPrice: '1', expiry }),
    makeRawIntent({ trader: TRADER_B, side: 'sell', amountBase: '10', limitPrice: '1', expiry }),
    makeRawIntent({ trader: TRADER_B, side: 'sell', amountBase: '7', limitPrice: '1', expiry }),
  ];

  const parsed = raw.map((r, i) => parseIntent(r, i, now)).filter(Boolean);
  assert.equal(parsed.length, 4);

  const res = matchFromParsedIntents({
    parsedIntents: parsed,
    now,
    roundIdBytes32: '0x' + '00'.repeat(32),
  });

  assert.equal(res.intentsCount, 4);
  assert.equal(res.eligibleIntentsCount, 4);
  assert.equal(res.matches.length, 6);
  assert.equal(res.matches.filter((m) => m.matchId.startsWith('fill:0:')).length, 2);
  assert.equal(res.matches.filter((m) => m.matchId.startsWith('fill:1:')).length, 2);
  assert.equal(res.matches.filter((m) => m.matchId.startsWith('fill:2:')).length, 2);

  const fill0Buyer = res.matches.find((m) => m.matchId.startsWith('fill:0:buy:'));
  const fill0Seller = res.matches.find((m) => m.matchId.startsWith('fill:0:sell:'));
  assert.ok(fill0Buyer);
  assert.ok(fill0Seller);

  assert.equal(fill0Buyer.tokenIn.toLowerCase(), QUOTE.toLowerCase());
  assert.equal(fill0Buyer.tokenOut.toLowerCase(), BASE.toLowerCase());
  assert.equal(fill0Seller.tokenIn.toLowerCase(), BASE.toLowerCase());
  assert.equal(fill0Seller.tokenOut.toLowerCase(), QUOTE.toLowerCase());

  const tenBaseWei = parseUnits('10', 18).toString();
  assert.equal(fill0Buyer.amountIn, tenBaseWei);
  assert.equal(fill0Buyer.minAmountOut, tenBaseWei);
  assert.equal(fill0Seller.amountIn, tenBaseWei);
  assert.equal(fill0Seller.minAmountOut, tenBaseWei);

  assert.equal(typeof res.merkleRoot, 'string');
  assert.ok(res.merkleRoot.startsWith('0x'));
  assert.equal(res.roundExpiry, expiry);
  for (const m of res.matches) {
    assert.ok(Array.isArray(m.merkleProof));
  }
});

test('does not match intents across different pairs', () => {
  const now = 1_000_000;
  const expiry = now + 3600;

  const raw = [
    makeRawIntent({ trader: TRADER_A, side: 'buy', baseToken: BASE, quoteToken: QUOTE, amountBase: '10', limitPrice: '1', expiry }),
    makeRawIntent({ trader: TRADER_B, side: 'sell', baseToken: BASE2, quoteToken: QUOTE2, amountBase: '10', limitPrice: '1', expiry }),
  ];
  const parsed = raw.map((r, i) => parseIntent(r, i, now)).filter(Boolean);

  const res = matchFromParsedIntents({
    parsedIntents: parsed,
    now,
    roundIdBytes32: '0x' + '00'.repeat(32),
  });

  assert.equal(res.matches.length, 0);
  assert.equal(res.roundExpiry, null);
});

test('filters expired intents from matching', () => {
  const now = 1_000_000;
  const raw = [
    makeRawIntent({ trader: TRADER_A, side: 'buy', amountBase: '10', limitPrice: '1', expiry: now + 3600 }),
    makeRawIntent({ trader: TRADER_B, side: 'sell', amountBase: '10', limitPrice: '1', expiry: now - 1 }),
  ];

  const parsed = raw.map((r, i) => parseIntent(r, i, now)).filter(Boolean);
  assert.equal(parsed.length, 2);

  const res = matchFromParsedIntents({
    parsedIntents: parsed,
    now,
    roundIdBytes32: '0x' + '00'.repeat(32),
  });

  assert.equal(res.eligibleIntentsCount, 1);
  assert.equal(res.matches.length, 0);
});


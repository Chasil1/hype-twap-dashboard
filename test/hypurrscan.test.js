import test from 'node:test';
import assert from 'node:assert/strict';

import { filterHypeTwaps, summarizeHypurrscanTwaps, summarizeHypurrscanTwapModes } from '../src/hypurrscan.js';

test('summarizes active Hypurrscan TWAP orders into notional buy sell and net metrics', () => {
  const now = Date.UTC(2026, 4, 30, 12, 30, 0);
  const orders = [
    {
      time: Date.UTC(2026, 4, 30, 12, 0, 0),
      action: { type: 'twapOrder', twap: { b: true, s: '10', m: 120 } },
      error: null
    },
    {
      time: Date.UTC(2026, 4, 30, 12, 30, 0),
      action: { type: 'twapOrder', twap: { b: false, s: '5', m: 60 } },
      error: null
    },
    {
      time: Date.UTC(2026, 4, 30, 12, 0, 0),
      action: { type: 'twapOrder', twap: { b: true, s: '100', m: 120 } },
      error: null,
      ended: 'ended'
    }
  ];

  assert.deepEqual(summarizeHypurrscanTwaps(orders, 2, now), {
    twapNet1h: 0,
    twapNet24h: 5,
    twapBuy24h: 15,
    twapSell24h: 10,
    activeBuyCount: 1,
    activeSellCount: 1
  });
});

test('limits 24h TWAP metrics to the next 24 hours instead of full remaining order size', () => {
  const now = Date.UTC(2026, 4, 30, 12, 0, 0);
  const orders = [
    {
      time: now,
      action: { type: 'twapOrder', twap: { b: true, s: '1000', m: 2880 } },
      error: null
    },
    {
      time: now,
      action: { type: 'twapOrder', twap: { b: false, s: '100', m: 1440 } },
      error: null
    }
  ];

  assert.deepEqual(summarizeHypurrscanTwaps(orders, 10, now), {
    twapNet1h: 166.67,
    twapNet24h: 4000,
    twapBuy24h: 5000,
    twapSell24h: 1000,
    activeBuyCount: 1,
    activeSellCount: 1
  });
});

test('filters HYPE TWAPs across perp and spot market ids', () => {
  const orders = [
    { action: { type: 'twapOrder', twap: { a: 159, b: true, s: '1', m: 60 } } },
    { action: { type: 'twapOrder', twap: { a: 10107, b: true, s: '1', m: 60 } } },
    { action: { type: 'twapOrder', twap: { a: 10207, b: false, s: '1', m: 60 } } },
    { action: { type: 'twapOrder', twap: { a: 10232, b: false, s: '1', m: 60 } } },
    { action: { type: 'twapOrder', twap: { a: 10255, b: true, s: '1', m: 60 } } },
    { action: { type: 'twapOrder', twap: { a: 10108, b: true, s: '1', m: 60 } } }
  ];

  assert.deepEqual(filterHypeTwaps(orders).map((order) => order.action.twap.a), [
    159,
    10107,
    10207,
    10232,
    10255
  ]);
});

test('summarizes TWAP metrics separately for spot perp and combined modes', () => {
  const now = Date.UTC(2026, 4, 30, 12, 0, 0);
  const orders = [
    {
      time: now,
      action: { type: 'twapOrder', twap: { a: 10107, b: true, s: '10', m: 60 } },
      error: null
    },
    {
      time: now,
      action: { type: 'twapOrder', twap: { a: 159, b: false, s: '4', m: 60 } },
      error: null
    }
  ];

  assert.deepEqual(summarizeHypurrscanTwapModes(orders, 2, now), {
    spotPerp: {
      twapNet1h: 12,
      twapNet24h: 12,
      twapBuy24h: 20,
      twapSell24h: 8,
      activeBuyCount: 1,
      activeSellCount: 1
    },
    spot: {
      twapNet1h: 20,
      twapNet24h: 20,
      twapBuy24h: 20,
      twapSell24h: 0,
      activeBuyCount: 1,
      activeSellCount: 0
    },
    perp: {
      twapNet1h: -8,
      twapNet24h: -8,
      twapBuy24h: 0,
      twapSell24h: 8,
      activeBuyCount: 0,
      activeSellCount: 1
    }
  });
});

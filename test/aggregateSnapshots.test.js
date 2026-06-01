import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateSnapshots, TIMEFRAMES } from '../src/aggregateSnapshots.js';

test('aggregates minute snapshots into OHLC candles and averaged TWAP metrics', () => {
  const snapshots = [
    {
      timestamp: '2026-05-29T10:00:00.000Z',
      price: 10,
      open: 9,
      high: 13,
      low: 8,
      close: 11,
      twapNet1h: 100,
      twapNet24h: 200,
      twapBuy24h: 300,
      twapSell24h: 50,
      twapModes: {
        spot: {
          twapNet1h: 10,
          twapNet24h: 20,
          twapBuy24h: 30,
          twapSell24h: 5,
          activeBuyCount: 2,
          activeSellCount: 1
        }
      }
    },
    {
      timestamp: '2026-05-29T10:01:00.000Z',
      price: 12,
      open: 11,
      high: 14,
      low: 10,
      close: 13,
      twapNet1h: 120,
      twapNet24h: null,
      twapBuy24h: 360,
      twapSell24h: 70,
      twapModes: {
        spot: {
          twapNet1h: 12,
          twapNet24h: 24,
          twapBuy24h: 36,
          twapSell24h: 7,
          activeBuyCount: 4,
          activeSellCount: 1
        }
      }
    },
    {
      timestamp: '2026-05-29T10:04:00.000Z',
      price: 9,
      twapNet1h: 80,
      twapNet24h: 260,
      twapBuy24h: 330,
      twapSell24h: 60
    },
    {
      timestamp: '2026-05-29T10:05:00.000Z',
      price: 11,
      twapNet1h: 110,
      twapNet24h: 220,
      twapBuy24h: 310,
      twapSell24h: 55
    }
  ];

  const result = aggregateSnapshots(snapshots, '5m');
  const cleanResult = result.map(s => {
    const clean = { ...s };
    for (const key of Object.keys(clean)) {
      if (key.startsWith('hl_') || key.startsWith('bybit_')) {
        delete clean[key];
      }
    }
    return clean;
  });

  assert.deepEqual(cleanResult, [
    {
      timestamp: '2026-05-29T10:00:00.000Z',
      open: 9,
      high: 14,
      low: 8,
      close: 9,
      price: 9,
      twapNet1h: 100,
      twapNet24h: 230,
      twapBuy24h: 330,
      twapSell24h: 60,
      twapModes: {
        spot: {
          twapNet1h: 11,
          twapNet24h: 22,
          twapBuy24h: 33,
          twapSell24h: 6,
          activeBuyCount: 3,
          activeSellCount: 1
        },
        spotPerp: {
          twapNet1h: null,
          twapNet24h: null,
          twapBuy24h: null,
          twapSell24h: null,
          activeBuyCount: null,
          activeSellCount: null
        },
        perp: {
          twapNet1h: null,
          twapNet24h: null,
          twapBuy24h: null,
          twapSell24h: null,
          activeBuyCount: null,
          activeSellCount: null
        }
      }
    },
    {
      timestamp: '2026-05-29T10:05:00.000Z',
      open: 11,
      high: 11,
      low: 11,
      close: 11,
      price: 11,
      twapNet1h: 110,
      twapNet24h: 220,
      twapBuy24h: 310,
      twapSell24h: 55,
      twapModes: {
        spotPerp: {
          twapNet1h: null,
          twapNet24h: null,
          twapBuy24h: null,
          twapSell24h: null,
          activeBuyCount: null,
          activeSellCount: null
        },
        spot: {
          twapNet1h: null,
          twapNet24h: null,
          twapBuy24h: null,
          twapSell24h: null,
          activeBuyCount: null,
          activeSellCount: null
        },
        perp: {
          twapNet1h: null,
          twapNet24h: null,
          twapBuy24h: null,
          twapSell24h: null,
          activeBuyCount: null,
          activeSellCount: null
        }
      }
    }
  ]);
});

test('exports expected chart timeframes', () => {
  assert.deepEqual(Object.keys(TIMEFRAMES), ['1m', '5m', '15m', '1h', '4h', '1d']);
});

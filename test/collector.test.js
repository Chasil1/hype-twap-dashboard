import test from 'node:test';
import assert from 'node:assert/strict';

import { Collector } from '../src/collector.js';
import { TwapCache } from '../src/twapCache.js';

// Stub global fetch to prevent actual network calls in tests
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (url && (url.includes('hyperliquid') || url.includes('bybit'))) {
    return {
      ok: false,
      status: 500,
      text: async () => 'Mocked offline response'
    };
  }
  if (typeof originalFetch === 'function') {
    return originalFetch(url, options);
  }
  return { ok: false, status: 404 };
};

const SAMPLE_TEXT = `NEXT 1H
+$10
NEXT 24H
+$25
HYPE TWAP BUY VS SELL
Buy $100
Sell $75
ACTIVE BUY TWAPS
2
ACTIVE SELL TWAPS
1`;

class MemoryStore {
  constructor() {
    this.snapshots = [];
  }

  async readAll() {
    return this.snapshots;
  }

  async append(snapshot) {
    this.snapshots = [...this.snapshots, snapshot];
    return this.snapshots;
  }
}

test('collector uses browser bridge TWAP metrics when scraper is blocked', async () => {
  const twapCache = new TwapCache();
  twapCache.updateFromText(SAMPLE_TEXT);
  const collector = new Collector({
    store: new MemoryStore(),
    priceFetcher: async () => 42.5,
    twapFetcher: null,
    scraper: {
      async read() {
        throw new Error('Turnstile blocked scraper');
      },
      getStatus() {
        return { ok: false, error: 'Turnstile blocked scraper' };
      }
    },
    twapCache
  });

  const snapshot = await collector.collectOnce();

  assert.equal(snapshot.price, 42.5);
  assert.equal(snapshot.twapBuy24h, 100);
  assert.equal(snapshot.status.twapOk, true);
  assert.equal(collector.getState().status.twapSource, 'browser-bridge');
});

test('collector uses Hypurrscan TWAP metrics before browser bridge fallback', async () => {
  const twapCache = new TwapCache();
  twapCache.updateFromText(SAMPLE_TEXT);
  const calls = [];
  const collector = new Collector({
    store: new MemoryStore(),
    priceFetcher: async () => 42.5,
    twapFetcher: async ({ price }) => {
      calls.push(price);
      return {
        twapNet1h: 15,
        twapNet24h: 50,
        twapBuy24h: 150,
        twapSell24h: 100,
        activeBuyCount: 3,
        activeSellCount: 2
      };
    },
    scraper: null,
    twapCache
  });

  const snapshot = await collector.collectOnce();

  assert.deepEqual(calls, [42.5]);
  assert.equal(snapshot.twapBuy24h, 150);
  assert.equal(snapshot.twapSell24h, 100);
  assert.equal(snapshot.status.twapOk, true);
  assert.equal(collector.getState().status.twapSource, 'hypurrscan');
});

test('collector does not carry stale TWAP values into a new failed snapshot', async () => {
  const store = new MemoryStore();
  const collector = new Collector({
    store,
    priceFetcher: async () => 42.5,
    twapFetcher: null,
    scraper: null,
    twapCache: null
  });
  collector.state.latest = {
    timestamp: '2026-05-29T00:00:00.000Z',
    price: 40,
    twapNet1h: 10,
    twapNet24h: 25,
    twapBuy24h: 100,
    twapSell24h: 75,
    activeBuyCount: 2,
    activeSellCount: 1
  };

  const snapshot = await collector.collectOnce();

  assert.equal(snapshot.price, 42.5);
  assert.equal(snapshot.twapNet1h, null);
  assert.equal(snapshot.twapNet24h, null);
  assert.equal(snapshot.twapBuy24h, null);
  assert.equal(snapshot.twapSell24h, null);
  assert.equal(snapshot.status.twapOk, false);
});

test('collector stores averaged minute snapshots from second-level samples', async () => {
  const store = new MemoryStore();
  const times = [
    Date.UTC(2026, 4, 30, 12, 0, 0),
    Date.UTC(2026, 4, 30, 12, 0, 30),
    Date.UTC(2026, 4, 30, 12, 1, 0)
  ];
  let timeIndex = 0;
  let sampleIndex = 0;
  const collector = new Collector({
    store,
    priceFetcher: async () => 10 + sampleIndex,
    twapFetcher: async () => {
      const currentSample = sampleIndex++;
      return {
        twapNet1h: 100 + currentSample,
        twapNet24h: 200 + currentSample,
        twapBuy24h: 300 + currentSample,
        twapSell24h: 400 + currentSample,
        activeBuyCount: 20 + currentSample,
        activeSellCount: 5 + currentSample,
        twapModes: {
          spot: {
            twapNet1h: 10 + currentSample,
            twapNet24h: 20 + currentSample,
            twapBuy24h: 30 + currentSample,
            twapSell24h: 40 + currentSample,
            activeBuyCount: 2 + currentSample,
            activeSellCount: 1 + currentSample
          },
          perp: {
            twapNet1h: 90 + currentSample,
            twapNet24h: 180 + currentSample,
            twapBuy24h: 270 + currentSample,
            twapSell24h: 360 + currentSample,
            activeBuyCount: 18 + currentSample,
            activeSellCount: 4 + currentSample
          },
          spotPerp: {
            twapNet1h: 100 + currentSample,
            twapNet24h: 200 + currentSample,
            twapBuy24h: 300 + currentSample,
            twapSell24h: 400 + currentSample,
            activeBuyCount: 20 + currentSample,
            activeSellCount: 5 + currentSample
          }
        }
      };
    },
    now: () => times[timeIndex++],
    scraper: null,
    twapCache: null
  });

  await collector.collectOnce();
  await collector.collectOnce();
  await collector.collectOnce();

  assert.equal(store.snapshots.length, 1);
  const cleanSnapshot = { ...store.snapshots[0] };
  for (const key of Object.keys(cleanSnapshot)) {
    if (key.startsWith('hl_') || key.startsWith('bybit_') || key.startsWith('diff_')) {
      delete cleanSnapshot[key];
    }
  }

  assert.deepEqual(cleanSnapshot, {
    timestamp: '2026-05-30T12:00:00.000Z',
    price: 10.5,
    open: 10,
    high: 11,
    low: 10,
    close: 11,
    twapNet1h: 100.5,
    twapNet24h: 200.5,
    twapBuy24h: 300.5,
    twapSell24h: 400.5,
    activeBuyCount: 20.5,
    activeSellCount: 5.5,
    twapModes: {
      spotPerp: {
        twapNet1h: 100.5,
        twapNet24h: 200.5,
        twapBuy24h: 300.5,
        twapSell24h: 400.5,
        activeBuyCount: 20.5,
        activeSellCount: 5.5
      },
      spot: {
        twapNet1h: 10.5,
        twapNet24h: 20.5,
        twapBuy24h: 30.5,
        twapSell24h: 40.5,
        activeBuyCount: 2.5,
        activeSellCount: 1.5
      },
      perp: {
        twapNet1h: 90.5,
        twapNet24h: 180.5,
        twapBuy24h: 270.5,
        twapSell24h: 360.5,
        activeBuyCount: 18.5,
        activeSellCount: 4.5
      }
    },
    status: {
      priceOk: true,
      twapOk: true
    }
  });
  assert.equal(collector.getState().latest.price, 12);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { TwapCache } from '../src/twapCache.js';

const SAMPLE_TEXT = `NEXT 1H
+$609 203
NEXT 24H
+$3 513 612
HYPE TWAP BUY VS SELL
Buy $7 691 794
Sell $4 178 181
ACTIVE BUY TWAPS
51
-
$7 691 794 remaining
ACTIVE SELL TWAPS
23`;

test('stores parsed bridge text as fresh TWAP metrics', () => {
  const cache = new TwapCache({ maxAgeMs: 60_000, now: () => 1_000 });

  const metrics = cache.updateFromText(SAMPLE_TEXT);

  assert.equal(metrics.twapNet24h, 3513612);
  assert.equal(cache.read().activeBuyCount, 51);
  assert.equal(cache.getStatus().source, 'browser-bridge');
  assert.equal(cache.getStatus().ok, true);
});

test('rejects stale TWAP bridge metrics', () => {
  let time = 1_000;
  const cache = new TwapCache({ maxAgeMs: 60_000, now: () => time });
  cache.updateFromText(SAMPLE_TEXT);
  time = 62_000;

  assert.throws(() => cache.read(), /stale/i);
  assert.equal(cache.getStatus().ok, false);
});

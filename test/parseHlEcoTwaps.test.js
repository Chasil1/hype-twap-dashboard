import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHlEcoTwaps } from '../src/parseHlEcoTwaps.js';

test('parses HYPE TWAP metrics from hl.eco visible page text', () => {
  const text = `Ecosystem
Home
TWAP $HYPE
HYPE TWAPs

Active TWAP orders on HYPE | spot and perp combined.

NEXT 1H
+$609 203
net buy - sell
NEXT 24H
+$3 513 612
net buy - sell
HYPE TWAP BUY VS SELL
Buy $7 691 794
net: +$3 513 612
Sell $4 178 181
ACTIVE BUY TWAPS
51
-
$7 691 794 remaining
ACTIVE SELL TWAPS
23
-
$4 178 181 remaining
ALL-ASSET ACTIVE TWAPS
225`;

  assert.deepEqual(parseHlEcoTwaps(text), {
    twapNet1h: 609203,
    twapNet24h: 3513612,
    twapBuy24h: 7691794,
    twapSell24h: 4178181,
    activeBuyCount: 51,
    activeSellCount: 23
  });
});

test('parses negative net values and non-breaking spaces', () => {
  const text = `NEXT 1H
−$12\u00a0345
net buy − sell
NEXT 24H
-$987\u202f654
net buy − sell
HYPE TWAP BUY VS SELL
Buy $111\u00a0000
net: -$987\u202f654
Sell $1\u00a0098\u00a0654
ACTIVE BUY TWAPS
3
-
$111 000 remaining
ACTIVE SELL TWAPS
9
-
$1 098 654 remaining`;

  assert.deepEqual(parseHlEcoTwaps(text), {
    twapNet1h: -12345,
    twapNet24h: -987654,
    twapBuy24h: 111000,
    twapSell24h: 1098654,
    activeBuyCount: 3,
    activeSellCount: 9
  });
});

export const TIMEFRAMES = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000
};

const TWAP_KEYS = ['twapNet1h', 'twapNet24h', 'twapBuy24h', 'twapSell24h'];
const TWAP_MODE_KEYS = [...TWAP_KEYS, 'activeBuyCount', 'activeSellCount'];
const TWAP_MODES = ['spotPerp', 'spot', 'perp'];

const DEPTHS = [1.5, 3, 5, 8, 15, 30, 60];
const DEPTH_KEYS = DEPTHS.flatMap((d) => {
  const suffix = String(d).replace('.', '_');
  return [
    `hl_bid_${suffix}`,
    `hl_ask_${suffix}`,
    `bybit_bid_${suffix}`,
    `bybit_ask_${suffix}`
  ];
});

function bucketStart(timestamp, timeframeMs) {
  return Math.floor(new Date(timestamp).getTime() / timeframeMs) * timeframeMs;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) {
    return null;
  }

  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function buildTwapArrays(keys = TWAP_KEYS) {
  return Object.fromEntries(keys.map((key) => [key, []]));
}

function averageTwapArrays(twaps) {
  return Object.fromEntries(
    Object.entries(twaps).map(([key, values]) => [key, average(values)])
  );
}

function snapshotOpen(snapshot) {
  return Number.isFinite(snapshot.open) ? snapshot.open : snapshot.price;
}

function snapshotHigh(snapshot) {
  return Number.isFinite(snapshot.high) ? snapshot.high : snapshot.price;
}

function snapshotLow(snapshot) {
  return Number.isFinite(snapshot.low) ? snapshot.low : snapshot.price;
}

function snapshotClose(snapshot) {
  return Number.isFinite(snapshot.close) ? snapshot.close : snapshot.price;
}

export function aggregateSnapshots(snapshots, timeframe = '1m') {
  const timeframeMs = TIMEFRAMES[timeframe] ?? TIMEFRAMES['1m'];
  const buckets = new Map();

  for (const snapshot of snapshots) {
    if (!Number.isFinite(snapshot.price)) {
      continue;
    }

    const start = bucketStart(snapshot.timestamp, timeframeMs);
    const bucket = buckets.get(start) ?? {
      timestamp: new Date(start).toISOString(),
      open: snapshotOpen(snapshot),
      high: snapshotHigh(snapshot),
      low: snapshotLow(snapshot),
      close: snapshotClose(snapshot),
      twaps: buildTwapArrays(),
      twapModes: Object.fromEntries(TWAP_MODES.map((mode) => [mode, buildTwapArrays(TWAP_MODE_KEYS)])),
      depths: Object.fromEntries(DEPTH_KEYS.map((key) => [key, []]))
    };

    bucket.high = Math.max(bucket.high, snapshotHigh(snapshot));
    bucket.low = Math.min(bucket.low, snapshotLow(snapshot));
    bucket.close = snapshotClose(snapshot);

    for (const key of TWAP_KEYS) {
      if (Number.isFinite(snapshot[key])) {
        bucket.twaps[key].push(snapshot[key]);
      }
    }

    for (const mode of TWAP_MODES) {
      for (const key of TWAP_MODE_KEYS) {
        const value = snapshot.twapModes?.[mode]?.[key];
        if (Number.isFinite(value)) {
          bucket.twapModes[mode][key].push(value);
        }
      }
    }

    for (const key of DEPTH_KEYS) {
      if (Number.isFinite(snapshot[key])) {
        bucket.depths[key].push(snapshot[key]);
      }
    }

    buckets.set(start, bucket);
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, bucket]) => {
      const depthAverages = Object.fromEntries(
        DEPTH_KEYS.map((key) => [key, average(bucket.depths[key])])
      );
      return {
        timestamp: bucket.timestamp,
        open: bucket.open,
        high: bucket.high,
        low: bucket.low,
        close: bucket.close,
        twapNet1h: average(bucket.twaps.twapNet1h),
        twapNet24h: average(bucket.twaps.twapNet24h),
        twapBuy24h: average(bucket.twaps.twapBuy24h),
        twapSell24h: average(bucket.twaps.twapSell24h),
        twapModes: Object.fromEntries(
          TWAP_MODES.map((mode) => [mode, averageTwapArrays(bucket.twapModes[mode])])
        ),
        ...depthAverages
      };
    });
}

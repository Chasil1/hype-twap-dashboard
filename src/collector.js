import { fetchHypePrice } from './hyperliquid.js';
import { fetchHypurrscanTwaps } from './hypurrscan.js';
import { fetchDepths } from './depths.js';
import { computeCustomDiffs, computeAverages } from './aggregateSnapshots.js';
import { withTimeout } from './fetchHelper.js';


const DEFAULT_INTERVAL_MS = 1_000;
const TWAP_KEYS = ['twapNet1h', 'twapNet24h', 'twapBuy24h', 'twapSell24h', 'activeBuyCount', 'activeSellCount'];
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

function buildErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function minuteStartMs(timestampMs) {
  return Math.floor(timestampMs / 60_000) * 60_000;
}

function average(values) {
  const numericValues = values.filter((value) => Number.isFinite(value));
  if (numericValues.length === 0) {
    return null;
  }

  return numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
}

function roundMetric(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

function averageFields(samples, readValue) {
  return Object.fromEntries(
    TWAP_KEYS.map((key) => [
      key,
      roundMetric(average(samples.map((sample) => readValue(sample, key))))
    ])
  );
}

function buildPriceCandle(samples) {
  const prices = samples.map((sample) => sample.price).filter(Number.isFinite);
  if (prices.length === 0) {
    return {
      open: null,
      high: null,
      low: null,
      close: null
    };
  }

  return {
    open: prices[0],
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: prices.at(-1)
  };
}

export class Collector {
  constructor({
    store,
    scraper = null,
    twapCache = null,
    priceFetcher = fetchHypePrice,
    twapFetcher = fetchHypurrscanTwaps,
    now = Date.now,
    intervalMs = DEFAULT_INTERVAL_MS,
    alertEngine = null,
    autoTradingEngine = null
  }) {
    this.store = store;
    this.scraper = scraper;
    this.twapCache = twapCache;
    this.priceFetcher = priceFetcher;
    this.twapFetcher = twapFetcher;
    this.now = now;
    this.intervalMs = intervalMs;
    this.alertEngine = alertEngine;
    this.autoTradingEngine = autoTradingEngine;
    this.timer = null;
    this.running = false;
    this.minuteBucket = null;
    this.state = {
      latest: null,
      snapshots: [],
      status: {
        running: false,
        lastStartedAt: null,
        lastCompletedAt: null,
        nextRunAt: null,
        priceError: null,
        twapError: null,
        twapSource: null,
        bridge: twapCache?.getStatus() ?? null,
        scraper: scraper?.getStatus() ?? null
      }
    };
  }

  async flushMinuteBucket() {
    if (!this.minuteBucket || this.minuteBucket.samples.length === 0) {
      return null;
    }

    const samples = this.minuteBucket.samples;
    const averagedTwaps = averageFields(samples, (sample, key) => sample[key]);
    const candle = buildPriceCandle(samples);
    const averagedDepths = Object.fromEntries(
      DEPTH_KEYS.map((key) => [
        key,
        roundMetric(average(samples.map((sample) => sample[key])))
      ])
    );
    const customDiffs = computeCustomDiffs(averagedDepths);
    const customAverages = computeAverages(averagedDepths);
    Object.keys(customAverages).forEach((key) => {
      customAverages[key] = roundMetric(customAverages[key]);
    });
    const snapshot = {
      timestamp: new Date(this.minuteBucket.minuteMs).toISOString(),
      price: roundMetric(average(samples.map((sample) => sample.price))),
      ...candle,
      ...averagedTwaps,
      ...averagedDepths,
      ...customDiffs,
      ...customAverages,
      twapModes: Object.fromEntries(
        TWAP_MODES.map((mode) => [
          mode,
          averageFields(samples, (sample, key) => sample.twapModes?.[mode]?.[key])
        ])
      ),
      status: {
        priceOk: samples.some((sample) => sample.status.priceOk),
        twapOk: samples.some((sample) => sample.status.twapOk)
      }
    };

    const previousSnapshot = this.state.snapshots.at(-1) || null;
    this.state.snapshots = await this.store.append(snapshot, this.state.snapshots);

    if (this.alertEngine) {
      this.alertEngine.checkAlerts(this.state.snapshots).catch(err => {
        console.error('Error running alerts in minute flush:', err);
      });
    }

    if (this.autoTradingEngine && this.alertEngine) {
      this.alertEngine.alertsStore.readAll()
        .then(alerts => {
          return this.autoTradingEngine.update(this.state.snapshots, alerts, this.alertEngine);
        })
        .catch(err => {
          console.error('Error running auto trading bot in minute flush:', err);
        });
    }

    return snapshot;
  }

  async addMinuteSample(sample, timestampMs) {
    const sampleMinuteMs = minuteStartMs(timestampMs);

    if (!this.minuteBucket) {
      this.minuteBucket = {
        minuteMs: sampleMinuteMs,
        samples: []
      };
    }

    if (sampleMinuteMs !== this.minuteBucket.minuteMs) {
      await this.flushMinuteBucket();
      this.minuteBucket = {
        minuteMs: sampleMinuteMs,
        samples: []
      };
    }

    this.minuteBucket.samples.push(sample);
  }

  async start() {
    try {
      this.state.snapshots = await this.store.readAll();
      this.state.latest = this.state.snapshots.at(-1) ?? null;
    } catch (err) {
      console.error('Failed to read initial snapshots:', err);
      this.state.snapshots = [];
      this.state.latest = null;
    }
    this.state.status.running = true;
    try {
      await this.collectOnce();
    } catch (error) {
      console.error('Initial collection failed:', error);
    } finally {
      this.scheduleNext();
    }
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state.status.running = false;
  }

  async collectOnce() {
    if (this.running) {
      return this.state.latest;
    }

    this.running = true;
    const timestampMs = this.now();
    this.state.status.lastStartedAt = new Date(timestampMs).toISOString();

    let price = null;
    let twapMetrics = null;
    let priceError = null;
    let twapError = null;
    let depthMetrics = null;

    try {
      const [priceResult, depthResult] = await Promise.allSettled([
        withTimeout(this.priceFetcher(), 10000, 'Price fetcher timed out'),
        withTimeout(fetchDepths(), 10000, 'Depths fetcher timed out')
      ]);

      if (priceResult.status === 'fulfilled') {
        price = priceResult.value;
      } else {
        priceError = buildErrorMessage(priceResult.reason);
      }

      if (depthResult.status === 'fulfilled') {
        depthMetrics = depthResult.value;
      }

      let twapSource = null;

      if (this.twapFetcher && price !== null) {
        try {
          twapMetrics = await withTimeout(this.twapFetcher({ price }), 10000, 'TWAP fetcher timed out');
          twapSource = 'hypurrscan';
        } catch (error) {
          twapError = `hypurrscan: ${buildErrorMessage(error)}`;
        }
      }

      if (this.twapCache) {
        if (!twapMetrics) {
          try {
            twapMetrics = this.twapCache.read();
            twapSource = 'browser-bridge';
            twapError = null;
          } catch (error) {
            const bridgeError = buildErrorMessage(error);
            twapError = twapError ? `${twapError}; bridge: ${bridgeError}` : `bridge: ${bridgeError}`;
          }
        }
      }

      if (!twapMetrics && this.scraper) {
        try {
          twapMetrics = await withTimeout(this.scraper.read(), 30000, 'Scraper timed out');
          twapSource = 'playwright';
          twapError = null;
        } catch (error) {
          const scraperError = buildErrorMessage(error);
          twapError = twapError ? `${twapError}; scraper: ${scraperError}` : scraperError;
        }
      }

      if (!twapMetrics && !twapError) {
        twapError = 'no TWAP source available';
      }

      if (price !== null || twapMetrics !== null) {
        const previous = this.state.latest ?? {};
        const sample = {
          timestamp: new Date(timestampMs).toISOString(),
          price: price ?? previous.price ?? null,
          twapNet1h: twapMetrics?.twapNet1h ?? null,
          twapNet24h: twapMetrics?.twapNet24h ?? null,
          twapBuy24h: twapMetrics?.twapBuy24h ?? null,
          twapSell24h: twapMetrics?.twapSell24h ?? null,
          activeBuyCount: twapMetrics?.activeBuyCount ?? null,
          activeSellCount: twapMetrics?.activeSellCount ?? null,
          twapModes: twapMetrics?.twapModes ?? null,
          ...Object.fromEntries(DEPTH_KEYS.map((key) => [key, depthMetrics?.[key] ?? null])),
          status: {
            priceOk: priceError === null,
            twapOk: twapError === null
          }
        };

        this.state.latest = sample;
        await withTimeout(this.addMinuteSample(sample, timestampMs), 15000, 'Add minute sample timed out');
      }

      this.state.status.priceError = priceError;
      this.state.status.twapError = twapError;
      this.state.status.twapSource = twapSource;
      this.state.status.bridge = this.twapCache?.getStatus() ?? null;
      this.state.status.scraper = this.scraper?.getStatus() ?? null;
      this.state.status.lastCompletedAt = new Date(timestampMs).toISOString();
    } catch (error) {
      console.error('Error in collectOnce:', error);
    } finally {
      this.running = false;
    }

    return this.state.latest;
  }

  scheduleNext() {
    const nextRun = this.now() + this.intervalMs;
    this.state.status.nextRunAt = new Date(nextRun).toISOString();
    this.timer = setTimeout(async () => {
      try {
        await this.collectOnce();
      } catch (error) {
        console.error('Collection cycle failed:', error);
      } finally {
        this.scheduleNext();
      }
    }, this.intervalMs);
  }

  getState() {
    return this.state;
  }
}

import { fetchJsonWithTimeout } from './fetchHelper.js';

const HYPURRSCAN_TWAP_URL = 'https://api.hypurrscan.io/twap';
const ONE_HOUR_MS = 60 * 60_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const HYPE_PERP_MARKET_IDS = new Set([159]);
const HYPE_SPOT_MARKET_IDS = new Set([10107, 10207, 10232, 10255]);
const DEFAULT_HYPE_MARKET_IDS = new Set([...HYPE_PERP_MARKET_IDS, ...HYPE_SPOT_MARKET_IDS]);

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function estimateTwapNotional(order, price, nowMs) {
  const twap = order?.action?.twap;
  const size = Number(twap?.s);
  const durationMinutes = Number(twap?.m);
  const startMs = Number(order?.time);

  if (
    order?.ended ||
    order?.error ||
    order?.action?.type !== 'twapOrder' ||
    !Number.isFinite(size) ||
    !Number.isFinite(durationMinutes) ||
    !Number.isFinite(startMs) ||
    durationMinutes <= 0 ||
    !Number.isFinite(price)
  ) {
    return null;
  }

  const durationMs = durationMinutes * 60_000;
  const remainingMs = Math.max(0, startMs + durationMs - nowMs);

  if (remainingMs <= 0) {
    return null;
  }

  const nextHourSize = size * (Math.min(ONE_HOUR_MS, remainingMs) / durationMs);
  const nextDaySize = size * (Math.min(ONE_DAY_MS, remainingMs) / durationMs);

  return {
    isBuy: twap.b === true,
    nextHourNotional: nextHourSize * price,
    nextDayNotional: nextDaySize * price
  };
}

export function filterHypeTwaps(orders, hypeMarketIds = DEFAULT_HYPE_MARKET_IDS) {
  return orders.filter((order) => hypeMarketIds.has(Number(order?.action?.twap?.a)));
}

function emptySummary() {
  return {
    twapNet1h: 0,
    twapNet24h: 0,
    twapBuy24h: 0,
    twapSell24h: 0,
    activeBuyCount: 0,
    activeSellCount: 0
  };
}

export function summarizeHypurrscanTwaps(orders, price, nowMs = Date.now()) {
  const totals = {
    nextHourBuy: 0,
    nextHourSell: 0,
    buy: 0,
    sell: 0,
    activeBuyCount: 0,
    activeSellCount: 0
  };

  for (const order of orders) {
    const estimate = estimateTwapNotional(order, price, nowMs);
    if (!estimate) {
      continue;
    }

    if (estimate.isBuy) {
      totals.buy += estimate.nextDayNotional;
      totals.nextHourBuy += estimate.nextHourNotional;
      totals.activeBuyCount += 1;
    } else {
      totals.sell += estimate.nextDayNotional;
      totals.nextHourSell += estimate.nextHourNotional;
      totals.activeSellCount += 1;
    }
  }

  return {
    twapNet1h: roundMoney(totals.nextHourBuy - totals.nextHourSell),
    twapNet24h: roundMoney(totals.buy - totals.sell),
    twapBuy24h: roundMoney(totals.buy),
    twapSell24h: roundMoney(totals.sell),
    activeBuyCount: totals.activeBuyCount,
    activeSellCount: totals.activeSellCount
  };
}

export function summarizeHypurrscanTwapModes(orders, price, nowMs = Date.now()) {
  const spot = summarizeHypurrscanTwaps(filterHypeTwaps(orders, HYPE_SPOT_MARKET_IDS), price, nowMs);
  const perp = summarizeHypurrscanTwaps(filterHypeTwaps(orders, HYPE_PERP_MARKET_IDS), price, nowMs);
  const spotPerp = summarizeHypurrscanTwaps(filterHypeTwaps(orders), price, nowMs);

  return {
    spotPerp: spotPerp ?? emptySummary(),
    spot: spot ?? emptySummary(),
    perp: perp ?? emptySummary()
  };
}

export async function fetchHypurrscanTwaps({ price, nowMs = Date.now() } = {}) {
  try {
    const orders = await fetchJsonWithTimeout(`${HYPURRSCAN_TWAP_URL}/*`, {}, 5000);
    if (!Array.isArray(orders)) {
      throw new Error('Hypurrscan TWAP response was not an array');
    }

    const modes = summarizeHypurrscanTwapModes(orders, price, nowMs);
    return {
      ...modes.spotPerp,
      twapModes: modes
    };
  } catch (error) {
    throw new Error(`Hypurrscan TWAP request failed: ${error.message}`);
  }
}

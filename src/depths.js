import { fetchJsonWithTimeout } from './fetchHelper.js';

const DEPTHS = [1.5, 3, 5, 8, 15, 30, 60];

function calculateDepth(bids, asks, mid, depthPct, side) {
  if (!bids || !asks || !mid || !Number.isFinite(mid) || mid <= 0) return null;
  const limitBid = mid * (1 - depthPct / 100);
  const limitAsk = mid * (1 + depthPct / 100);
  
  let total = 0;
  if (side === 'bid') {
    for (const bid of bids) {
      const price = Number(bid.px ?? bid[0]);
      const size = Number(bid.sz ?? bid[1]);
      if (Number.isFinite(price) && Number.isFinite(size) && price >= limitBid) {
        total += price * size;
      }
    }
  } else {
    for (const ask of asks) {
      const price = Number(ask.px ?? ask[0]);
      const size = Number(ask.sz ?? ask[1]);
      if (Number.isFinite(price) && Number.isFinite(size) && price <= limitAsk) {
        total += price * size;
      }
    }
  }
  return total;
}

// Robust Bybit orderbook fetcher with domain rotation and timeouts
async function fetchBybitOrderbook() {
  const domains = [
    'api.bybit.com',
    'api.bybit.nl',
    'api.bytick.com'
  ];

  const errors = [];
  for (const domain of domains) {
    const url = `https://${domain}/v5/market/orderbook?category=linear&symbol=HYPEUSDT&limit=500`;
    try {
      const json = await fetchJsonWithTimeout(url, {}, 3000);
      if (json && json.retCode === 0 && json.result && json.result.b?.length > 0 && json.result.a?.length > 0) {
        return json;
      } else {
        errors.push(`${domain} (retCode=${json?.retCode} retMsg=${json?.retMsg})`);
      }
    } catch (err) {
      errors.push(`${domain} (Error: ${err.message})`);
    }
  }
  
  console.error(`Bybit API fetch failed on all domains: ${errors.join('; ')}`);
  return null;
}

// 5-second cache to prevent hitting rate limits
let cacheTime = 0;
let cacheResult = null;

export async function fetchDepths() {
  const now = Date.now();
  if (cacheResult && (now - cacheTime < 5000)) {
    return cacheResult;
  }

  const result = {};
  
  // Pre-initialize all keys to null
  for (const d of DEPTHS) {
    const suffix = String(d).replace('.', '_');
    result[`hl_bid_${suffix}`] = null;
    result[`hl_ask_${suffix}`] = null;
    result[`bybit_bid_${suffix}`] = null;
    result[`bybit_ask_${suffix}`] = null;
  }

  let hl3 = null;
  let hl2 = null;
  let bybit = null;

  try {
    const [resHL3, resHL2, bybitData] = await Promise.allSettled([
      fetchJsonWithTimeout('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'l2Book', coin: 'HYPE', nSigFigs: 3 })
      }, 3000),
      fetchJsonWithTimeout('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'l2Book', coin: 'HYPE', nSigFigs: 2 })
      }, 3000),
      fetchBybitOrderbook()
    ]);

    if (resHL3.status === 'fulfilled') hl3 = resHL3.value;
    if (resHL2.status === 'fulfilled') hl2 = resHL2.value;
    if (bybitData.status === 'fulfilled') bybit = bybitData.value;
  } catch (err) {
    console.error('Error fetching order books in fetchDepths:', err);
  }

  // Compute Hyperliquid depth metrics
  const validHLBook = hl3 || hl2;
  if (validHLBook && validHLBook.levels && validHLBook.levels[0]?.length > 0 && validHLBook.levels[1]?.length > 0) {
    const hl3Mid = hl3?.levels?.[0]?.[0]?.px && hl3?.levels?.[1]?.[0]?.px
      ? (Number(hl3.levels[0][0].px) + Number(hl3.levels[1][0].px)) / 2
      : null;
    const hl2Mid = hl2?.levels?.[0]?.[0]?.px && hl2?.levels?.[1]?.[0]?.px
      ? (Number(hl2.levels[0][0].px) + Number(hl2.levels[1][0].px)) / 2
      : null;

    const hlMidFallback = hl3Mid ?? hl2Mid;

    for (const d of DEPTHS) {
      const suffix = String(d).replace('.', '_');
      const hlBook = (d === 1.5 || d === 3) ? (hl3 ?? hl2) : (hl2 ?? hl3);
      const hlMid = (d === 1.5 || d === 3) ? (hl3Mid ?? hlMidFallback) : (hl2Mid ?? hlMidFallback);

      if (hlBook && hlBook.levels && hlBook.levels[0]?.length > 0) {
        result[`hl_bid_${suffix}`] = calculateDepth(hlBook.levels[0], hlBook.levels[1], hlMid, d, 'bid');
        result[`hl_ask_${suffix}`] = calculateDepth(hlBook.levels[0], hlBook.levels[1], hlMid, d, 'ask');
      }
    }
  }

  // Compute Bybit depth metrics
  if (bybit && bybit.result && bybit.result.b?.length > 0 && bybit.result.a?.length > 0) {
    const bybitBids = bybit.result.b;
    const bybitAsks = bybit.result.a;
    const bybitMid = (Number(bybitBids[0][0]) + Number(bybitAsks[0][0])) / 2;

    for (const d of DEPTHS) {
      const suffix = String(d).replace('.', '_');
      result[`bybit_bid_${suffix}`] = calculateDepth(bybitBids, bybitAsks, bybitMid, d, 'bid');
      result[`bybit_ask_${suffix}`] = calculateDepth(bybitBids, bybitAsks, bybitMid, d, 'ask');
    }
  }

  // Cache results if we got any valid metrics to prevent blank runs
  if (validHLBook || bybit) {
    cacheResult = result;
    cacheTime = now;
  }

  return result;
}

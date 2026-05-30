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

export async function fetchDepths() {
  const result = {};
  
  // Pre-initialize all keys to null
  for (const d of DEPTHS) {
    const suffix = String(d).replace('.', '_');
    result[`hl_bid_${suffix}`] = null;
    result[`hl_ask_${suffix}`] = null;
    result[`bybit_bid_${suffix}`] = null;
    result[`bybit_ask_${suffix}`] = null;
  }

  // Fetch from APIs in parallel
  let hl3 = null;
  let hl2 = null;
  let bybit = null;

  try {
    const [resHL3, resHL2, resBybit] = await Promise.allSettled([
      fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'l2Book', coin: 'HYPE', nSigFigs: 3 })
      }),
      fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'l2Book', coin: 'HYPE', nSigFigs: 2 })
      }),
      fetch('https://api.bytick.com/v5/market/orderbook?category=linear&symbol=HYPEUSDT&limit=500')
    ]);

    if (resHL3.status === 'fulfilled') {
      if (resHL3.value.ok) {
        hl3 = await resHL3.value.json();
      } else {
        console.error(`Hyperliquid L2 Book (nSigFigs=3) fetch failed: ${resHL3.value.status} ${resHL3.value.statusText}`);
      }
    } else {
      console.error('Hyperliquid L2 Book (nSigFigs=3) promise rejected:', resHL3.reason);
    }

    if (resHL2.status === 'fulfilled') {
      if (resHL2.value.ok) {
        hl2 = await resHL2.value.json();
      } else {
        console.error(`Hyperliquid L2 Book (nSigFigs=2) fetch failed: ${resHL2.value.status} ${resHL2.value.statusText}`);
      }
    } else {
      console.error('Hyperliquid L2 Book (nSigFigs=2) promise rejected:', resHL2.reason);
    }

    if (resBybit.status === 'fulfilled') {
      if (resBybit.value.ok) {
        bybit = await resBybit.value.json();
      } else {
        const bodyText = await resBybit.value.text().catch(() => '');
        console.error(`Bybit API fetch failed: ${resBybit.value.status} ${resBybit.value.statusText} - ${bodyText.slice(0, 200)}`);
      }
    } else {
      console.error('Bybit API fetch promise rejected:', resBybit.reason);
    }
  } catch (err) {
    console.error('Error fetching order books in fetchDepths:', err);
  }

  // Compute Hyperliquid depth metrics
  // Check if we got at least one book to compute
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
      // For narrow depth (1.5, 3), prefer hl3 (nSigFigs: 3). Otherwise prefer hl2 (nSigFigs: 2).
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

  return result;
}

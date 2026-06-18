import { fetchJsonWithTimeout } from './fetchHelper.js';

const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';

export async function fetchHypePrice() {
  try {
    const mids = await fetchJsonWithTimeout(HYPERLIQUID_INFO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' })
    }, 5000);

    const raw = mids?.HYPE;
    const price = Number(raw);

    if (!Number.isFinite(price)) {
      throw new Error('Hyperliquid response did not include HYPE price');
    }

    return price;
  } catch (error) {
    throw new Error(`Hyperliquid price request failed: ${error.message}`);
  }
}

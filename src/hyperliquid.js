const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';

export async function fetchHypePrice() {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' })
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid price request failed: ${response.status}`);
  }

  const mids = await response.json();
  const raw = mids.HYPE;
  const price = Number(raw);

  if (!Number.isFinite(price)) {
    throw new Error('Hyperliquid response did not include HYPE price');
  }

  return price;
}

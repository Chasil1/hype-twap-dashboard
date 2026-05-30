# HYPE TWAP Monitor

Local dashboard for HYPE price and TWAP metrics. HYPE price is read from Hyperliquid, and TWAP metrics are read from the Hypurrscan TWAP API once per second. Chart snapshots are stored as one-minute averages.

## Run

```powershell
npm.cmd install
npm.cmd start
```

Open `http://127.0.0.1:4175`.

## TWAP Source

The dashboard uses `https://api.hypurrscan.io/twap/*` as the primary TWAP source, then filters all known HYPE perp and spot market ids. Hypurrscan returns active TWAP orders, not a direct `twap net` number, so the app estimates:

- `twapNet1h`: buy notional minus sell notional expected over the next hour.
- `twapNet24h`: buy notional minus sell notional expected over the next 24 hours.
- `twapBuy24h` / `twapSell24h`: estimated buy/sell notional expected over the next 24 hours.

The estimate is linear from order size, start time, duration, side, and current HYPE price.

## TWAP Bridge

`hl.eco` protects its live TWAP stream with Cloudflare Turnstile. Automated Playwright reads can be blocked, so the dashboard includes a browser bridge fallback:

1. Open the dashboard.
2. Click `Copy bridge`.
3. Open `https://hl.eco/twaps` in your normal browser and wait until TWAP values are visible.
4. Paste the copied `javascript:...` text into the address bar and press Enter.

The bridge posts the visible TWAP text to the local dashboard once per minute. If Hypurrscan is unavailable, the dashboard can use this bridge data and writes snapshots to `data/snapshots.json`.

## Optional Playwright Scraper

To attempt automated scraping anyway:

```powershell
npx.cmd playwright install chromium
$env:PLAYWRIGHT_SCRAPER='1'
$env:HEADLESS='0'
npm.cmd start
```

If Turnstile blocks it, use the browser bridge.

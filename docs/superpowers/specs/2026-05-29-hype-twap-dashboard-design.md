# HYPE TWAP Dashboard Design

## Goal

Build a local web dashboard that tracks HYPE price in near real time and records once-per-minute snapshots of TWAP metrics shown on `https://hl.eco/twaps`.

## Data Sources

- HYPE price: official Hyperliquid `https://api.hyperliquid.xyz/info` endpoint with `type: "allMids"`.
- TWAP metrics: local Playwright worker attempts to open `https://hl.eco/twaps` and parse visible page text because the internal `api.hl.eco/api/stream?feeds=twaps` endpoint is protected by browser session and Turnstile.
- Fallback TWAP metrics: browser bridge/bookmarklet runs in the user's normal browser on `https://hl.eco/twaps` and posts visible page text to `POST /api/ingest-hl-eco`.

## Metrics

Each snapshot contains:

- timestamp
- HYPE price
- TWAP net for next 1 hour
- TWAP net for next 24 hours
- 24h TWAP buy amount
- 24h TWAP sell amount
- active buy TWAP count
- active sell TWAP count
- scraper status and error, when present

## App Shape

Use a Node/Express app with a background collector:

- `server.js` serves API routes and static frontend files.
- `src/collector.js` runs the minute snapshot loop.
- `src/hlEcoScraper.js` owns the Playwright browser page and parses `hl.eco/twaps`.
- `src/hyperliquid.js` fetches HYPE price.
- `src/store.js` persists snapshots to `data/snapshots.json`.
- `public/` contains the main dashboard and `/chart` window.

## Frontend

The main page shows compact trading-monitor cards:

- live HYPE price
- TWAP net 1h
- TWAP net 24h
- buy 24h
- sell 24h
- delta status and scraper health

The chart page opens separately at `/chart` and overlays:

- HYPE price
- TWAP net 1h
- TWAP net 24h
- buy 24h
- sell 24h

The frontend polls `/api/state` every few seconds and uses `/api/snapshots` for history.

## Failure Handling

- If the price API fails, keep the previous snapshots and show the current error in status.
- If `hl.eco` asks for manual verification or changes its text layout, the scraper reports a clear error.
- If Playwright is blocked by Turnstile, the dashboard can still collect TWAP snapshots from the browser bridge.
- The app keeps serving the last successful snapshot so the chart does not disappear.
- Snapshot writes are atomic to avoid corrupt JSON.

## Verification

- Unit-test the `hl.eco` text parser against a captured real text sample.
- Run the app locally and verify `/api/state`, `/api/snapshots`, `/`, and `/chart`.
- If Playwright browser binaries are missing, document the required install command.

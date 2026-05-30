import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Collector } from './src/collector.js';
import { aggregateSnapshots, TIMEFRAMES } from './src/aggregateSnapshots.js';
import { HlEcoScraper } from './src/hlEcoScraper.js';
import { SnapshotStore } from './src/store.js';
import { TwapCache } from './src/twapCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT ?? 4175);
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 1_000);
const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE ?? path.join(__dirname, 'data', 'snapshots.json');

const app = express();
const store = new SnapshotStore(SNAPSHOT_FILE);
const twapCache = new TwapCache();
const scraper = process.env.PLAYWRIGHT_SCRAPER === '1'
  ? new HlEcoScraper({ headless: process.env.HEADLESS !== '0' })
  : null;
const collector = new Collector({
  store,
  scraper,
  twapCache,
  intervalMs: SNAPSHOT_INTERVAL_MS
});

app.use('/api/ingest-hl-eco', express.text({ type: '*/*', limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

app.use('/api/ingest-hl-eco', (_request, response, next) => {
  response.setHeader('access-control-allow-origin', 'https://hl.eco');
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
  next();
});

app.options('/api/ingest-hl-eco', (_request, response) => {
  response.sendStatus(204);
});

app.get('/chart', (_request, response) => {
  response.sendFile(path.join(__dirname, 'public', 'chart.html'));
});

app.get('/api/state', (_request, response) => {
  response.json(collector.getState());
});

app.get('/api/snapshots', (_request, response) => {
  const timeframe = String(_request.query.timeframe ?? '1m');
  const snapshots = collector.getState().snapshots;

  if (!Object.hasOwn(TIMEFRAMES, timeframe)) {
    response.status(400).json({ error: `Unsupported timeframe: ${timeframe}` });
    return;
  }

  response.json(aggregateSnapshots(snapshots, timeframe));
});

app.post('/api/collect-now', async (_request, response) => {
  try {
    const latest = await collector.collectOnce();
    response.json({ ok: true, latest });
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/ingest-hl-eco', (request, response) => {
  try {
    const metrics = twapCache.updateFromText(String(request.body ?? ''));
    response.json({ ok: true, metrics });
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message });
  }
});

const server = app.listen(PORT, async () => {
  console.log(`HYPE TWAP dashboard: http://127.0.0.1:${PORT}`);
  try {
    await collector.start();
  } catch (error) {
    console.error('Initial collection failed:', error);
  }
});

async function shutdown() {
  collector.stop();
  await scraper?.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

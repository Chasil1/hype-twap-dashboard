import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Collector } from './src/collector.js';
import { aggregateSnapshots, TIMEFRAMES } from './src/aggregateSnapshots.js';
import { HlEcoScraper } from './src/hlEcoScraper.js';
import { SnapshotStore, AlertsStore, ConfigStore } from './src/store.js';
import { TwapCache } from './src/twapCache.js';
import { AlertEngine } from './src/alertEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT ?? 4175);
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 1_000);
const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE ?? path.join(__dirname, 'data', 'snapshots.json');

const app = express();
const store = new SnapshotStore(SNAPSHOT_FILE);
const alertsStore = new AlertsStore(process.env.ALERTS_FILE ?? path.join(__dirname, 'data', 'alerts.json'));
const configStore = new ConfigStore(process.env.CONFIG_FILE ?? path.join(__dirname, 'data', 'config.json'));
const alertEngine = new AlertEngine({ alertsStore, configStore });

const twapCache = new TwapCache();
const scraper = process.env.PLAYWRIGHT_SCRAPER === '1'
  ? new HlEcoScraper({ headless: process.env.HEADLESS !== '0' })
  : null;
const collector = new Collector({
  store,
  scraper,
  twapCache,
  intervalMs: SNAPSHOT_INTERVAL_MS,
  alertEngine
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

// Alerts Configuration APIs
app.get('/api/config/telegram', async (req, res) => {
  try {
    let token = await configStore.get('telegram_bot_token') || process.env.TELEGRAM_BOT_TOKEN || '';
    let chatId = await configStore.get('telegram_chat_id') || process.env.TELEGRAM_CHAT_ID || '';

    if (token) {
      token = token.slice(0, 6) + '...' + token.slice(-4);
    }
    res.json({
      telegramBotTokenMasked: token,
      telegramChatId: chatId,
      isConfigured: !!(token && chatId)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config/telegram', express.json(), async (req, res) => {
  try {
    const { token, chatId } = req.body;
    if (token !== undefined && !token.includes('...')) {
      await configStore.set('telegram_bot_token', token.trim());
    }
    if (chatId !== undefined) {
      await configStore.set('telegram_chat_id', chatId.trim());
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const alerts = await alertsStore.readAll();
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alerts', express.json(), async (req, res) => {
  try {
    const { name, expression, frequency_minutes, trend_mode } = req.body;

    if (!name || !expression || frequency_minutes === undefined) {
      res.status(400).json({ error: 'Missing name, expression or frequency_minutes' });
      return;
    }

    const newAlert = {
      id: crypto.randomUUID(),
      name,
      expression,
      frequency_minutes: Number(frequency_minutes),
      trend_mode: trend_mode || 'none',
      last_crossover_price: null,
      last_triggered_at: null,
      active: true,
      created_at: new Date().toISOString()
    };

    const ok = await alertsStore.save(newAlert);
    if (ok) {
      res.json(newAlert);
    } else {
      res.status(500).json({ error: 'Failed to save alert' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alerts/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const alerts = await alertsStore.readAll();
    const alert = alerts.find(a => a.id === id);
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    alert.active = !alert.active;
    const ok = await alertsStore.save(alert);
    if (ok) {
      res.json(alert);
    } else {
      res.status(500).json({ error: 'Failed to toggle alert' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/alerts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const ok = await alertsStore.delete(id);
    if (ok) {
      res.json({ ok: true });
    } else {
      res.status(500).json({ error: 'Failed to delete alert' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alerts/test', express.json(), async (req, res) => {
  try {
    let { token, chatId } = req.body || {};
    const savedConfig = await alertEngine.getTelegramConfig();

    if (token && token.includes('...')) {
      token = savedConfig.token;
    }

    const finalToken = (token || savedConfig.token || '').trim();
    const finalChatId = (chatId || savedConfig.chatId || '').trim();

    if (!finalToken || !finalChatId) {
      res.status(400).json({ error: 'Telegram bot not configured.' });
      return;
    }

    const testMsg = `🔔 <b>HYPE Alert Test Bot</b>\nConnection successful! Your alerts are ready.`;
    const url = `https://api.telegram.org/bot${finalToken}/sendMessage`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: finalChatId, text: testMsg, parse_mode: 'HTML' })
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Telegram error: ${response.status} - ${errText}`);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

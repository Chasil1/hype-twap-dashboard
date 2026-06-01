import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine } from '../src/alertEngine.js';

class MockAlertsStore {
  constructor(alerts = []) {
    this.alerts = alerts;
  }
  async readAll() {
    return this.alerts;
  }
  async save(alert) {
    const idx = this.alerts.findIndex(a => a.id === alert.id);
    if (idx !== -1) {
      this.alerts[idx] = alert;
    } else {
      this.alerts.push(alert);
    }
    return true;
  }
}

class MockConfigStore {
  constructor(config = {}) {
    this.config = config;
  }
  async get(key) {
    return this.config[key] || null;
  }
}

test('AlertEngine processes Long crossover modes correctly', async () => {
  const alerts = [
    {
      id: 'alert-1',
      name: 'Long crossover test',
      expression: {
        field1: 'hl_bid_3',
        operator: 'gt',
        compareType: 'metric',
        field2: 'hl_ask_3'
      },
      frequency_minutes: 0,
      trend_mode: 'long',
      last_crossover_price: null,
      last_triggered_at: null,
      active: true
    }
  ];

  const alertsStore = new MockAlertsStore(alerts);
  const configStore = new MockConfigStore({
    telegram_bot_token: '123:abc',
    telegram_chat_id: '456'
  });

  const engine = new AlertEngine({ alertsStore, configStore });

  // Stub sendTelegramNotification to track notifications
  let notificationCount = 0;
  engine.sendTelegramNotification = async () => {
    notificationCount++;
  };

  // 1. Initial State: Bid <= Ask (Condition false)
  // Snapshot 1: bid = 10, ask = 20, price = 5.0
  const s1 = { hl_bid_3: 10, hl_ask_3: 20, price: 5.0, timestamp: Date.now() };
  await engine.checkAlerts(s1, null);
  assert.equal(notificationCount, 0, 'No alert since condition is false');
  assert.equal(alerts[0].last_crossover_price, null);

  // 2. Bid > Ask (Condition true - First Crossover)
  // Snapshot 2: bid = 30, ask = 20, price = 5.0 (transition false -> true)
  const s2 = { hl_bid_3: 30, hl_ask_3: 20, price: 5.0, timestamp: Date.now() };
  await engine.checkAlerts(s2, s1);
  assert.equal(notificationCount, 1, 'First crossover triggers notification immediately');
  assert.equal(alerts[0].last_crossover_price, 5.0, 'Updates last crossover price to 5.0');

  // 3. Bid > Ask (Condition still true, not a crossover)
  // Snapshot 3: bid = 35, ask = 20, price = 5.1 (transition true -> true)
  const s3 = { hl_bid_3: 35, hl_ask_3: 20, price: 5.1, timestamp: Date.now() };
  await engine.checkAlerts(s3, s2);
  assert.equal(notificationCount, 1, 'No alert since it is not a crossover transition');

  // 4. Bid <= Ask (Condition false again)
  // Snapshot 4: bid = 15, ask = 20, price = 5.2 (transition true -> false)
  const s4 = { hl_bid_3: 15, hl_ask_3: 20, price: 5.2, timestamp: Date.now() };
  await engine.checkAlerts(s4, s3);
  assert.equal(notificationCount, 1, 'No alert, condition is false');

  // 5. Bid > Ask (Condition true - Second Crossover, price 5.3 > 5.0)
  // Snapshot 5: bid = 30, ask = 20, price = 5.3 (transition false -> true)
  const s5 = { hl_bid_3: 30, hl_ask_3: 20, price: 5.3, timestamp: Date.now() };
  await engine.checkAlerts(s5, s4);
  assert.equal(notificationCount, 2, 'Crossover triggers since current price 5.3 > last crossover 5.0');
  assert.equal(alerts[0].last_crossover_price, 5.3, 'Updates last crossover price to 5.3');

  // 6. Bid <= Ask (Condition false again)
  const s6 = { hl_bid_3: 15, hl_ask_3: 20, price: 5.4, timestamp: Date.now() };
  await engine.checkAlerts(s6, s5);

  // 7. Bid > Ask (Condition true - Third Crossover, price 5.1 <= 5.3)
  // Snapshot 7: bid = 30, ask = 20, price = 5.1 (transition false -> true)
  const s7 = { hl_bid_3: 30, hl_ask_3: 20, price: 5.1, timestamp: Date.now() };
  await engine.checkAlerts(s7, s6);
  assert.equal(notificationCount, 2, 'No alert triggers since current price 5.1 is not higher than last crossover price 5.3');
  assert.equal(alerts[0].last_crossover_price, 5.1, 'Updates last crossover price to 5.1 regardless of skip');
});

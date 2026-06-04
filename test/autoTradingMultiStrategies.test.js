import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoTradeStore } from '../src/store.js';
import { rm, writeFile } from 'node:fs/promises';

test('AutoTradeStore handles old single-strategy migration correctly', async () => {
  const tempConfigPath = './test_autotrade_config_tmp.json';
  const tempStatePath = './test_autotrade_state_tmp.json';
  const store = new AutoTradeStore(tempConfigPath, tempStatePath);

  // Clear any existing tmp files
  await rm(tempConfigPath, { force: true });
  await rm(tempStatePath, { force: true });

  const oldSingleStrategyConfig = {
    enabled: true,
    exchange: 'hl',
    testnet: true,
    wallet: '0x123',
    privateKey: 'pk_secret',
    alertId: 'crossover-alert-1',
    direction: 'long',
    orderCount: 2,
    tradeAmount: 100,
    legOffset1: -0.5,
    legAmount1: 50,
    legOffset2: -1.5,
    legAmount2: 50,
    tpMode: 'percent',
    tpPercent: 2.0,
    tpAnchor: 'avg',
    tpCloseSelect: 'same',
    slMode: 'percent',
    slPercent: 3.0,
    slCloseSelect: 'same'
  };

  await writeFile(tempConfigPath, JSON.stringify(oldSingleStrategyConfig));

  // Get config and check migration
  const migrated = await store.getConfig();
  assert.ok(migrated.strategies);
  assert.equal(migrated.strategies.length, 1);

  const strat = migrated.strategies[0];
  assert.equal(strat.id, 'default_strategy');
  assert.equal(strat.name, 'Default Strategy');
  assert.equal(strat.enabled, true);
  assert.equal(strat.exchange, 'hl');
  assert.equal(strat.wallet, '0x123');
  assert.equal(strat.privateKey, 'pk_secret');
  assert.equal(strat.alertId, 'crossover-alert-1');
  assert.equal(strat.direction, 'long');
  assert.equal(strat.orderCount, 2);
  assert.equal(strat.tradeAmount, 100);
  assert.equal(strat.legOffset1, -0.5);
  assert.equal(strat.legAmount1, 50);
  assert.equal(strat.legOffset2, -1.5);
  assert.equal(strat.legAmount2, 50);
  assert.equal(strat.tpMode, 'percent');
  assert.equal(strat.tpPercent, 2.0);
  assert.equal(strat.slMode, 'percent');
  assert.equal(strat.slPercent, 3.0);

  // Clean up
  await rm(tempConfigPath, { force: true });
  await rm(tempStatePath, { force: true });
});

test('AutoTradeStore handles clean multi-strategies config read/write', async () => {
  const tempConfigPath = './test_autotrade_config_tmp.json';
  const tempStatePath = './test_autotrade_state_tmp.json';
  const store = new AutoTradeStore(tempConfigPath, tempStatePath);

  // Clear any existing tmp files
  await rm(tempConfigPath, { force: true });
  await rm(tempStatePath, { force: true });

  const multiConfig = {
    strategies: [
      { id: 'strat-1', name: 'Strat 1', enabled: true, alertId: 'a1' },
      { id: 'strat-2', name: 'Strat 2', enabled: false, alertId: 'a2' }
    ]
  };

  await store.saveConfig(multiConfig);

  const loaded = await store.getConfig();
  assert.ok(loaded.strategies);
  assert.equal(loaded.strategies.length, 2);
  assert.equal(loaded.strategies[0].name, 'Strat 1');
  assert.equal(loaded.strategies[1].name, 'Strat 2');
  assert.equal(loaded.strategies[1].enabled, false);

  // Clean up
  await rm(tempConfigPath, { force: true });
  await rm(tempStatePath, { force: true });
});

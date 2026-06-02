import test from 'node:test';
import assert from 'node:assert/strict';

// 1. Simulating dynamic presets key helper from chart.js
function getPresetsKey(currentUser) {
  return (currentUser && currentUser.id) ? `hype_chart_presets_${currentUser.id}` : 'hype_chart_presets_public';
}

test('Presets isolation key resolution', () => {
  // Scenario A: User is not logged in (currentUser is null)
  assert.equal(getPresetsKey(null), 'hype_chart_presets_public');

  // Scenario B: User A is logged in
  const userA = { id: 12345, first_name: 'Alice' };
  assert.equal(getPresetsKey(userA), 'hype_chart_presets_12345');

  // Scenario C: User B is logged in
  const userB = { id: 67890, first_name: 'Bob' };
  assert.equal(getPresetsKey(userB), 'hype_chart_presets_67890');
});

// Mock database alerts list to test ownership check logic
const mockAlertsDb = [
  {
    id: 'alert-1',
    name: 'Alice Alert',
    telegram_user_id: '12345',
    active: true
  },
  {
    id: 'alert-2',
    name: 'Bob Alert',
    telegram_user_id: '67890',
    active: true
  },
  {
    id: 'alert-3',
    name: 'Legacy Global Alert',
    telegram_user_id: null,
    active: true
  }
];

// Helper to simulate endpoint ownership check
function verifyAlertOwnership(alertId, reqUserId) {
  const alert = mockAlertsDb.find(a => a.id === alertId);
  if (!alert) return { status: 404, error: 'Alert not found' };
  if (alert.telegram_user_id && alert.telegram_user_id !== String(reqUserId)) {
    return { status: 403, error: 'Forbidden: You do not own this alert.' };
  }
  return { status: 200, ok: true };
}

test('Backend Alert CRUD ownership validation', () => {
  // Scenario A: Alice attempts to access/modify her own alert
  const aliceRes = verifyAlertOwnership('alert-1', '12345');
  assert.equal(aliceRes.status, 200);
  assert.equal(aliceRes.ok, true);

  // Scenario B: Alice attempts to access/modify Bob's alert
  const accessBobRes = verifyAlertOwnership('alert-2', '12345');
  assert.equal(accessBobRes.status, 403);
  assert.equal(accessBobRes.error, 'Forbidden: You do not own this alert.');

  // Scenario C: Alice attempts to access/modify legacy global alert
  const accessGlobalRes = verifyAlertOwnership('alert-3', '12345');
  assert.equal(accessGlobalRes.status, 200);
  assert.equal(accessGlobalRes.ok, true);

  // Scenario D: Non-existent alert
  const nonExistentRes = verifyAlertOwnership('alert-missing', '12345');
  assert.equal(nonExistentRes.status, 404);
  assert.equal(nonExistentRes.error, 'Alert not found');
});

import { PresetsStore } from '../src/store.js';
import { rm } from 'node:fs/promises';

test('PresetsStore Local File Mode CRUD Isolation', async () => {
  const tempPresetsFile = './test_presets_tmp.json';
  const store = new PresetsStore(tempPresetsFile);

  // Clear any existing tmp file
  try {
    await rm(tempPresetsFile, { force: true });
  } catch {}

  const userA = 'user_123';
  const userB = 'user_456';

  const presetData1 = { exchange: 'bybit', timeframe: '1m', panels: [] };
  const presetData2 = { exchange: 'hl', timeframe: '5m', panels: [] };

  // Save preset for User A
  const saveARes = await store.save(userA, 'MyView', presetData1);
  assert.equal(saveARes, true);

  // Save preset for User B
  const saveBRes = await store.save(userB, 'BobView', presetData2);
  assert.equal(saveBRes, true);

  // Verify User A can read their preset, but not User B's
  const presetsA = await store.readAll(userA);
  assert.equal(presetsA.length, 1);
  assert.equal(presetsA[0].name, 'MyView');
  assert.deepEqual(presetsA[0].preset_data, presetData1);

  // Verify User B can read their preset
  const presetsB = await store.readAll(userB);
  assert.equal(presetsB.length, 1);
  assert.equal(presetsB[0].name, 'BobView');

  // Delete User A's preset
  const deleteARes = await store.delete(userA, 'MyView');
  assert.equal(deleteARes, true);

  // Verify User A has no presets left, but User B's is intact
  const presetsA2 = await store.readAll(userA);
  assert.equal(presetsA2.length, 0);

  const presetsB2 = await store.readAll(userB);
  assert.equal(presetsB2.length, 1);
  assert.equal(presetsB2[0].name, 'BobView');

  // Clean up
  await rm(tempPresetsFile, { force: true });
});

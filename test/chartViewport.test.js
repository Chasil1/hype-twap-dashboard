import test from 'node:test';
import assert from 'node:assert/strict';

import { clampViewport, panViewport, zoomViewport } from '../public/chartViewport.js';

test('clamps price chart viewport to available buckets', () => {
  assert.deepEqual(clampViewport({ start: -10, size: 500 }, 100), {
    start: 0,
    size: 100
  });
  assert.deepEqual(clampViewport({ start: 95, size: 20 }, 100), {
    start: 80,
    size: 20
  });
});

test('pans price chart viewport horizontally', () => {
  assert.deepEqual(panViewport({ start: 20, size: 40 }, 100, -10), {
    start: 10,
    size: 40
  });
  assert.deepEqual(panViewport({ start: 20, size: 40 }, 100, 90), {
    start: 60,
    size: 40
  });
});

test('zooms price chart viewport around an anchor ratio', () => {
  assert.deepEqual(zoomViewport({ start: 20, size: 40 }, 100, 0.5, 0.5), {
    start: 30,
    size: 20
  });
  assert.deepEqual(zoomViewport({ start: 30, size: 20 }, 100, 2, 0.5), {
    start: 20,
    size: 40
  });
});

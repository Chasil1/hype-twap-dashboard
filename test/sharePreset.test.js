import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

test('Share preset and timeframe integration test', async (t) => {
  // 1. Start the server on a custom test port
  const testPort = '4176';
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: testPort }
  });

  // Wait for the server to be ready
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
      if (output.includes('HYPE TWAP dashboard')) {
        resolve();
      }
    });
    child.stderr.on('data', (data) => {
      // Optional logger
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('Server start timeout')), 10000);
  });

  // 2. Launch chromium with clipboard permissions
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write']
  });
  const page = await context.newPage();

  try {
    // 3. Open chart page
    await page.goto(`http://127.0.0.1:${testPort}/chart.html`, { waitUntil: 'load' });

    // 4. Manipulate DOM to set up a specific state
    // - Select exchange: "combined"
    // - Select timeframe: "15m"
    // - Add a subchart, and add some metrics
    await page.evaluate(() => {
      // Set exchange
      const exchangeSelect = document.getElementById('exchangeSourceSelect');
      exchangeSelect.value = 'combined';
      exchangeSelect.dispatchEvent(new Event('change'));

      // Set timeframe button
      const tfBtn = document.querySelector('[data-timeframe="15m"]');
      if (tfBtn) {
        tfBtn.click();
      }

      // Add a subchart
      const addSubchartBtn = document.getElementById('addNewPanelBtn');
      if (addSubchartBtn) {
        addSubchartBtn.click();
      }
    });

    // Wait for the new subchart panel to be created
    await page.waitForFunction(() => {
      return document.querySelectorAll('.dynamic-panel-container').length === 1;
    });

    // Add a metric to the subchart
    await page.evaluate(() => {
      const panel = document.querySelector('.dynamic-panel-container');
      const addMetricSelect = panel.querySelector('.add-metric-select');
      addMetricSelect.value = 'bid_1.5';
      addMetricSelect.dispatchEvent(new Event('change'));
    });

    // Click the Share button
    await page.click('#sharePresetBtn');

    // Read the clipboard text
    const shareUrl = await page.evaluate(() => navigator.clipboard.readText());

    assert.ok(shareUrl.includes('share='));

    // 6. Navigate to the share URL in a new page/context
    const page2 = await context.newPage();
    await page2.goto(shareUrl, { waitUntil: 'load' });

    // 7. Verify the shared preset is applied on load
    const presetState = await page2.evaluate(() => {
      const activeTfBtn = document.querySelector('.timeframes button.timeframe.active');
      const activeTf = activeTfBtn ? activeTfBtn.dataset.timeframe : '';
      const badgeText = document.querySelector('.active-metrics-badges')?.textContent || '';

      return {
        exchange: document.getElementById('exchangeSourceSelect').value,
        timeframe: activeTf,
        panelsCount: document.querySelectorAll('.dynamic-panel-container').length,
        badgeText: badgeText
      };
    });

    assert.equal(presetState.exchange, 'combined');
    assert.equal(presetState.timeframe, '15m');
    assert.equal(presetState.panelsCount, 1);
    assert.ok(presetState.badgeText.includes('1.5%'));

  } finally {
    // 8. Clean up
    await browser.close();
    child.kill('SIGKILL');
  }
});

import { chromium } from 'playwright';

async function run() {
  console.log('Launching browser to debug animations...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on('console', msg => {
    console.log(`[Browser Console ${msg.type()}]:`, msg.text());
  });

  page.on('pageerror', err => {
    console.error('[Browser Runtime Error]:', err.stack || err.message);
  });

  try {
    await page.goto('http://127.0.0.1:4175/', { waitUntil: 'load', timeout: 10000 });
    console.log('Page loaded. Monitoring console for 5 seconds...');
    
    // Inject loggers into app.js methods to see what values are passing
    await page.evaluate(() => {
      const originalAnimateValue = window.animateValue;
      // We can inspect elements or overwrite to see if it triggers
      console.log('Price element content:', document.querySelector('#price').textContent);
    });

    await page.waitForTimeout(5000);
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
}

run();

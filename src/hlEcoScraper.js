import { chromium } from 'playwright';

import { parseHlEcoTwaps } from './parseHlEcoTwaps.js';

const HL_ECO_TWAPS_URL = 'https://hl.eco/twaps';

export class HlEcoScraper {
  constructor({ headless = false, timeoutMs = 45000 } = {}) {
    this.headless = headless;
    this.timeoutMs = timeoutMs;
    this.browser = null;
    this.page = null;
    this.status = {
      ok: false,
      url: HL_ECO_TWAPS_URL,
      lastReadAt: null,
      error: 'not started'
    };
  }

  async read() {
    await this.ensurePage();

    try {
      await this.page.waitForFunction(
        () => document.body.innerText.includes('HYPE TWAPs') && document.body.innerText.includes('NEXT 24H'),
        null,
        { timeout: this.timeoutMs }
      );

      const text = await this.page.evaluate(() => document.body.innerText);
      const metrics = parseHlEcoTwaps(text);

      this.status = {
        ok: true,
        url: HL_ECO_TWAPS_URL,
        lastReadAt: new Date().toISOString(),
        error: null
      };

      return metrics;
    } catch (error) {
      this.status = {
        ok: false,
        url: HL_ECO_TWAPS_URL,
        lastReadAt: this.status.lastReadAt,
        error: error.message
      };
      throw error;
    }
  }

  async ensurePage() {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.headless });
    }

    if (!this.page || this.page.isClosed()) {
      this.page = await this.browser.newPage({
        viewport: { width: 1440, height: 1100 }
      });
      await this.page.goto(HL_ECO_TWAPS_URL, {
        waitUntil: 'domcontentloaded',
        timeout: this.timeoutMs
      });
    }
  }

  getStatus() {
    return this.status;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}

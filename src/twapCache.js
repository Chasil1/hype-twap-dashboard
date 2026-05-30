import { parseHlEcoTwaps } from './parseHlEcoTwaps.js';

export class TwapCache {
  constructor({ maxAgeMs = 90_000, now = () => Date.now() } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.metrics = null;
    this.updatedAtMs = null;
    this.status = {
      ok: false,
      source: 'browser-bridge',
      lastReadAt: null,
      error: 'no bridge data received'
    };
  }

  updateFromText(text) {
    this.metrics = parseHlEcoTwaps(text);
    this.updatedAtMs = this.now();
    this.status = {
      ok: true,
      source: 'browser-bridge',
      lastReadAt: new Date(this.updatedAtMs).toISOString(),
      error: null
    };
    return this.metrics;
  }

  read() {
    if (!this.metrics || !this.updatedAtMs) {
      this.status.ok = false;
      this.status.error = 'no bridge data received';
      throw new Error(this.status.error);
    }

    const ageMs = this.now() - this.updatedAtMs;
    if (ageMs > this.maxAgeMs) {
      this.status.ok = false;
      this.status.error = `bridge data is stale by ${Math.round(ageMs / 1000)}s`;
      throw new Error(this.status.error);
    }

    this.status.ok = true;
    this.status.error = null;
    return this.metrics;
  }

  getStatus() {
    return this.status;
  }
}

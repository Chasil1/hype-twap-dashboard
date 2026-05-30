# HYPE TWAP Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local dashboard that snapshots HYPE price and `hl.eco/twaps` metrics once per minute, then charts price and TWAP series in a separate window.

**Architecture:** Node/Express serves static pages and API routes. A background collector fetches HYPE price from Hyperliquid and reads TWAP values through a Playwright page scraper, then persists snapshots to local JSON.

**Tech Stack:** Node 24, Express 5, Playwright, native `node:test`, browser Chart.js via CDN.

---

## File Structure

- `package.json`: scripts and dependencies.
- `server.js`: Express app, API routes, static file serving, collector lifecycle.
- `src/parseHlEcoTwaps.js`: pure parser from `hl.eco/twaps` visible text to numeric metrics.
- `src/hyperliquid.js`: fetch HYPE mid price.
- `src/hlEcoScraper.js`: Playwright-backed reader for `hl.eco/twaps`.
- `src/twapCache.js`: browser-bridge cache for visible `hl.eco/twaps` text when Turnstile blocks Playwright.
- `src/store.js`: atomic JSON snapshot persistence.
- `src/collector.js`: recurring snapshot orchestration and state.
- `test/parseHlEcoTwaps.test.js`: parser regression tests based on captured page text.
- `public/index.html`, `public/chart.html`: dashboard and separate chart window.
- `public/styles.css`, `public/app.js`, `public/chart.js`: frontend presentation and polling.

## Tasks

- [x] Write parser test from captured real page text and verify it fails before implementation.
- [x] Implement parser and verify parser test passes.
- [ ] Add package metadata and dependencies.
- [ ] Implement Hyperliquid price adapter.
- [ ] Implement snapshot store.
- [ ] Implement Playwright `hl.eco` scraper.
- [x] Add browser-bridge fallback after Turnstile blocked Playwright automation.
- [ ] Implement collector and API server.
- [ ] Implement dashboard and chart UI.
- [ ] Run automated tests and local smoke checks.

const elements = {
  price: document.querySelector('#price'),
  twapSource: document.querySelector('#twapSource'),
  twapNet1h: document.querySelector('#twapNet1h'),
  twapNet24h: document.querySelector('#twapNet24h'),
  twapBuy24h: document.querySelector('#twapBuy24h'),
  twapSell24h: document.querySelector('#twapSell24h'),
  activeBuyCount: document.querySelector('#activeBuyCount'),
  activeSellCount: document.querySelector('#activeSellCount'),
  scraperStatus: document.querySelector('#scraperStatus'),
  statusDetail: document.querySelector('#statusDetail'),
  collectNow: document.querySelector('#collectNow'),
  copyBridge: document.querySelector('#copyBridge'),
  twapModeButtons: [...document.querySelectorAll('.twap-mode')]
};

let selectedTwapMode = 'spotPerp';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});

const price = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4
});

function formatMoney(value, formatter = money) {
  return Number.isFinite(value) ? formatter.format(value) : '--';
}

function formatSigned(value) {
  if (!Number.isFinite(value)) {
    return '--';
  }

  return `${value > 0 ? '+' : ''}${money.format(value)}`;
}

function formatTime(value) {
  if (!value) {
    return '--';
  }

  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

const lastValues = {
  price: null,
  twapNet1h: null,
  twapNet24h: null,
  twapBuy24h: null,
  twapSell24h: null
};

function triggerPulse(element, isUp) {
  element.classList.remove('pulse-up', 'pulse-down');
  void element.offsetWidth; // Force layout reflow to restart animation
  element.classList.add(isUp ? 'pulse-up' : 'pulse-down');
}

let isModeSwitching = false;

function animateValue(element, start, end, duration, formatFn, shouldPulse = false) {
  const currentVal = element._currentValue;
  const actualStart = (currentVal !== undefined && currentVal !== null) ? currentVal : (start !== null ? start : 0);

  if (!Number.isFinite(end)) {
    element.textContent = '--';
    element._currentValue = null;
    return;
  }

  const isUp = end > actualStart;
  const isDown = end < actualStart;
  if (shouldPulse) {
    if (isUp) triggerPulse(element, true);
    if (isDown) triggerPulse(element, false);
  }

  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    
    let currentValue;
    if (elapsed <= duration) {
      const progress = elapsed / duration;
      currentValue = actualStart + (end - actualStart) * progress;
    } else {
      // Smooth sinusoidal oscillation (drift) after reaching target value
      const driftElapsed = (elapsed - duration) / 1000; // in seconds
      const amplitude = Math.abs(end) * 0.00005; // 0.005% of value for a calm live vibration
      const oscillation = Math.sin(driftElapsed * 3.5) * amplitude;
      currentValue = end + oscillation;
    }

    element._currentValue = currentValue;
    element.textContent = formatFn(currentValue);

    element._animationId = requestAnimationFrame(update);
  }

  if (element._animationId) {
    cancelAnimationFrame(element._animationId);
  }
  element._animationId = requestAnimationFrame(update);
}

function animateSigned(element, start, end, duration, shouldPulse = false) {
  element.classList.toggle('positive', end > 0);
  element.classList.toggle('negative', end < 0);
  animateValue(element, start, end, duration, formatSigned, shouldPulse);
}

function animateMoney(element, start, end, duration, formatter = money, shouldPulse = false) {
  animateValue(element, start, end, duration, (val) => formatMoney(val, formatter), shouldPulse);
}

function buildBridgeScript() {
  const endpoint = `${window.location.origin}/api/ingest-hl-eco`;
  return `javascript:(()=>{const u=${JSON.stringify(endpoint)};const send=()=>fetch(u,{method:'POST',mode:'no-cors',headers:{'content-type':'text/plain'},body:document.body.innerText}).catch(console.error);send();setInterval(send,60000);alert('HYPE TWAP bridge active');})()`;
}

async function refresh() {
  const response = await fetch('/api/state');
  const state = await response.json();
  const latest = state.latest ?? {};
  const status = state.status ?? {};

  const visibleTwap = latest.twapModes?.[selectedTwapMode] ?? latest;

  elements.twapSource.textContent = status.twapSource ?? 'waiting';
  elements.activeBuyCount.textContent = visibleTwap.activeBuyCount ?? '--';
  elements.activeSellCount.textContent = visibleTwap.activeSellCount ?? '--';

  const shouldPulse = isModeSwitching;
  isModeSwitching = false; // Reset mode toggle flag

  const duration = 1200; // Animate over 1.2s to fully stretch across the 1.0s refresh intervals smoothly

  const targetPrice = latest.price;
  const targetNet1h = visibleTwap.twapNet1h;
  const targetNet24h = visibleTwap.twapNet24h;
  const targetBuy24h = visibleTwap.twapBuy24h;
  const targetSell24h = visibleTwap.twapSell24h;

  if (lastValues.price !== targetPrice) {
    animateMoney(elements.price, lastValues.price, targetPrice, duration, price, shouldPulse);
    lastValues.price = targetPrice;
  }
  if (lastValues.twapNet1h !== targetNet1h) {
    animateSigned(elements.twapNet1h, lastValues.twapNet1h, targetNet1h, duration, shouldPulse);
    lastValues.twapNet1h = targetNet1h;
  }
  if (lastValues.twapNet24h !== targetNet24h) {
    animateSigned(elements.twapNet24h, lastValues.twapNet24h, targetNet24h, duration, shouldPulse);
    lastValues.twapNet24h = targetNet24h;
  }
  if (lastValues.twapBuy24h !== targetBuy24h) {
    animateMoney(elements.twapBuy24h, lastValues.twapBuy24h, targetBuy24h, duration, money, shouldPulse);
    lastValues.twapBuy24h = targetBuy24h;
  }
  if (lastValues.twapSell24h !== targetSell24h) {
    animateMoney(elements.twapSell24h, lastValues.twapSell24h, targetSell24h, duration, money, shouldPulse);
    lastValues.twapSell24h = targetSell24h;
  }

  const scraper = status.scraper ?? {};
  const bridge = status.bridge ?? {};
  elements.scraperStatus.textContent = scraper.ok || bridge.ok ? 'Online' : 'Needs attention';
  elements.statusDetail.textContent = [
    bridge.lastReadAt ? `Bridge: ${formatTime(bridge.lastReadAt)}` : null,
    !bridge.ok ? 'Open hl.eco/twaps in your browser and run the copied bridge script.' : null,
    status.priceError ? `Price: ${status.priceError}` : null,
    status.twapError ? `TWAP: ${status.twapError}` : null,
    scraper.lastReadAt ? `Last hl.eco read: ${formatTime(scraper.lastReadAt)}` : null
  ].filter(Boolean).join(' | ') || 'Collector is running.';
}

elements.collectNow.addEventListener('click', async () => {
  elements.collectNow.disabled = true;
  try {
    await fetch('/api/collect-now', { method: 'POST' });
    await refresh();
  } finally {
    elements.collectNow.disabled = false;
  }
});

elements.copyBridge.addEventListener('click', async () => {
  await navigator.clipboard.writeText(buildBridgeScript());
  elements.copyBridge.textContent = 'Copied';
  setTimeout(() => {
    elements.copyBridge.textContent = 'Copy bridge';
  }, 1600);
});

for (const button of elements.twapModeButtons) {
  button.addEventListener('click', () => {
    selectedTwapMode = button.dataset.twapMode;
    elements.twapModeButtons.forEach((item) => item.classList.toggle('active', item === button));
    isModeSwitching = true;
    refresh().catch(console.error);
  });
}

refresh().catch(console.error);
setInterval(() => refresh().catch(console.error), 1000);

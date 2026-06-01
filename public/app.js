const elements = {
  price: document.querySelector('#price'),
  twapSource: document.querySelector('#twapSource'),
  twapNet1h: document.querySelector('#twapNet1h'),
  twapNet24h: document.querySelector('#twapNet24h'),
  twapBuy24h: document.querySelector('#twapBuy24h'),
  twapSell24h: document.querySelector('#twapSell24h'),
  activeBuyCount: document.querySelector('#activeBuyCount'),
  activeSellCount: document.querySelector('#activeSellCount'),
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


}



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

// ==========================================
// TELEGRAM ALERTS CONFIGURATOR FRONTEND
// ==========================================

const alertElements = {
  toggleSettingsBtn: document.querySelector('#toggleSettingsBtn'),
  settingsDrawer: document.querySelector('#settingsDrawer'),
  tgTokenInput: document.querySelector('#tgTokenInput'),
  tgChatIdInput: document.querySelector('#tgChatIdInput'),
  saveConfigBtn: document.querySelector('#saveConfigBtn'),
  testBotBtn: document.querySelector('#testBotBtn'),
  settingsMessage: document.querySelector('#settingsMessage'),

  tabActiveAlerts: document.querySelector('#tabActiveAlerts'),
  tabCreateAlert: document.querySelector('#tabCreateAlert'),
  tabContentList: document.querySelector('#tabContentList'),
  tabContentForm: document.querySelector('#tabContentForm'),
  alertsCount: document.querySelector('#alertsCount'),
  alertsList: document.querySelector('#alertsList'),

  createAlertForm: document.querySelector('#createAlertForm'),
  alertNameInput: document.querySelector('#alertNameInput'),
  leftMetricSelect: document.querySelector('#leftMetricSelect'),
  operatorSelect: document.querySelector('#operatorSelect'),
  compareTypeSelect: document.querySelector('#compareTypeSelect'),
  rightValueGroup: document.querySelector('#rightValueGroup'),
  rightValueInput: document.querySelector('#rightValueInput'),
  rightMetricGroup: document.querySelector('#rightMetricGroup'),
  rightMetricSelect: document.querySelector('#rightMetricSelect'),
  frequencySelect: document.querySelector('#frequencySelect'),
  formFeedback: document.querySelector('#formFeedback')
};

const METRIC_LABELS = {
  price: 'HYPE Price',
  twapNet1h: 'TWAP Net 1H',
  twapNet24h: 'TWAP Net 24H',
  twapBuy24h: 'TWAP Buy 24H',
  twapSell24h: 'TWAP Sell 24H',
  activeBuyCount: 'Active Buy Count',
  activeSellCount: 'Active Sell Count'
};

const depths = [1.5, 3, 5, 8, 15, 30, 60];
depths.forEach(d => {
  const suffix = String(d).replace('.', '_');
  METRIC_LABELS[`hl_bid_${suffix}`] = `HL Bid ${d}%`;
  METRIC_LABELS[`hl_ask_${suffix}`] = `HL Ask ${d}%`;
  METRIC_LABELS[`bybit_bid_${suffix}`] = `Bybit Bid ${d}%`;
  METRIC_LABELS[`bybit_ask_${suffix}`] = `Bybit Ask ${d}%`;
});

function populateMetricSelects() {
  const selects = document.querySelectorAll('.metric-select');
  selects.forEach(select => {
    const optGroupHlBid = document.createElement('optgroup');
    optGroupHlBid.label = 'Hyperliquid Bid Depth';
    const optGroupHlAsk = document.createElement('optgroup');
    optGroupHlAsk.label = 'Hyperliquid Ask Depth';
    const optGroupBybitBid = document.createElement('optgroup');
    optGroupBybitBid.label = 'Bybit Bid Depth';
    const optGroupBybitAsk = document.createElement('optgroup');
    optGroupBybitAsk.label = 'Bybit Ask Depth';

    depths.forEach(d => {
      const suffix = String(d).replace('.', '_');

      const optHlBid = document.createElement('option');
      optHlBid.value = `hl_bid_${suffix}`;
      optHlBid.textContent = `HL Bid ${d}%`;
      optGroupHlBid.appendChild(optHlBid);

      const optHlAsk = document.createElement('option');
      optHlAsk.value = `hl_ask_${suffix}`;
      optHlAsk.textContent = `HL Ask ${d}%`;
      optGroupHlAsk.appendChild(optHlAsk);

      const optBybitBid = document.createElement('option');
      optBybitBid.value = `bybit_bid_${suffix}`;
      optBybitBid.textContent = `Bybit Bid ${d}%`;
      optGroupBybitBid.appendChild(optBybitBid);

      const optBybitAsk = document.createElement('option');
      optBybitAsk.value = `bybit_ask_${suffix}`;
      optBybitAsk.textContent = `Bybit Ask ${d}%`;
      optGroupBybitAsk.appendChild(optBybitAsk);
    });

    select.appendChild(optGroupHlBid);
    select.appendChild(optGroupHlAsk);
    select.appendChild(optGroupBybitBid);
    select.appendChild(optGroupBybitAsk);
  });
}

function showFeedback(element, text, isSuccess) {
  element.textContent = text;
  element.className = `feedback-msg ${isSuccess ? 'success' : 'error'}`;
  setTimeout(() => {
    element.textContent = '';
    element.className = 'feedback-msg';
  }, 4000);
}

async function loadTelegramConfig() {
  try {
    const response = await fetch('/api/config/telegram');
    const config = await response.json();
    if (config.telegramBotTokenMasked) {
      alertElements.tgTokenInput.value = config.telegramBotTokenMasked;
    }
    if (config.telegramChatId) {
      alertElements.tgChatIdInput.value = config.telegramChatId;
    }
  } catch (err) {
    console.error('Failed to load Telegram settings:', err);
  }
}

async function saveTelegramConfig() {
  const token = alertElements.tgTokenInput.value.trim();
  const chatId = alertElements.tgChatIdInput.value.trim();

  try {
    const response = await fetch('/api/config/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, chatId })
    });
    if (!response.ok) throw new Error('Save config failed');
    showFeedback(alertElements.settingsMessage, 'Settings saved successfully.', true);
    await loadTelegramConfig();
  } catch (err) {
    showFeedback(alertElements.settingsMessage, 'Failed to save settings.', false);
  }
}

async function testTelegramConnection() {
  const token = alertElements.tgTokenInput.value.trim();
  const chatId = alertElements.tgChatIdInput.value.trim();

  alertElements.testBotBtn.disabled = true;
  alertElements.testBotBtn.textContent = 'Testing...';
  try {
    const response = await fetch('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, chatId })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Connection failed');
    showFeedback(alertElements.settingsMessage, 'Test alert sent! Check your Telegram.', true);
  } catch (err) {
    showFeedback(alertElements.settingsMessage, `Test failed: ${err.message}`, false);
  } finally {
    alertElements.testBotBtn.disabled = false;
    alertElements.testBotBtn.textContent = 'Test Connection';
  }
}

async function loadAlerts() {
  try {
    const response = await fetch('/api/alerts');
    const alerts = await response.json();
    alertElements.alertsCount.textContent = String(alerts.length);
    renderAlertsList(alerts);
  } catch (err) {
    console.error('Failed to load alerts:', err);
  }
}

function renderAlertsList(alerts) {
  const container = alertElements.alertsList;
  container.innerHTML = '';

  if (alerts.length === 0) {
    container.innerHTML = '<p class="placeholder-text">No alerts configured yet.</p>';
    return;
  }

  alerts.forEach(alert => {
    const item = document.createElement('div');
    item.className = 'alert-item';

    const expr = alert.expression;
    const leftName = METRIC_LABELS[expr.field1] || expr.field1;
    const rightName = expr.compareType === 'value' ? formatStaticValue(expr.field1, expr.value) : (METRIC_LABELS[expr.field2] || expr.field2);
    const opLabel = { gt: '>', lt: '<', gte: '>=', lte: '<=' }[expr.operator] || expr.operator;
    const ruleString = `${leftName} ${opLabel} ${rightName}`;
    const cooldownString = alert.frequency_minutes > 0 ? `cooldown: ${alert.frequency_minutes}m` : 'no cooldown';

    item.innerHTML = `
      <div class="alert-info">
        <span class="alert-title">${alert.name}</span>
        <span class="alert-rule">${ruleString} (${cooldownString})</span>
      </div>
      <div class="alert-actions">
        <label class="switch">
          <input type="checkbox" class="toggle-alert-active" data-id="${alert.id}" ${alert.active ? 'checked' : ''}/>
          <span class="slider"></span>
        </label>
        <button class="delete-alert-btn" data-id="${alert.id}" title="Delete Alert" type="button">×</button>
      </div>
    `;

    item.querySelector('.toggle-alert-active').addEventListener('change', async () => {
      await toggleAlertActive(alert.id);
    });

    item.querySelector('.delete-alert-btn').addEventListener('click', async () => {
      if (confirm(`Are you sure you want to delete alert "${alert.name}"?`)) {
        await deleteAlert(alert.id);
      }
    });

    container.appendChild(item);
  });
}

function formatStaticValue(field, val) {
  if (field === 'price') return `$${Number(val).toFixed(2)}`;
  if (field.startsWith('hl_') || field.startsWith('bybit_') || field.startsWith('twap')) {
    const num = Number(val);
    if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
    if (Math.abs(num) >= 1_000) return `$${(num / 1_000).toFixed(0)}k`;
    return `$${num}`;
  }
  return String(val);
}

async function toggleAlertActive(id) {
  try {
    const response = await fetch(`/api/alerts/${id}/toggle`, { method: 'POST' });
    if (!response.ok) throw new Error('Toggle failed');
    await loadAlerts();
  } catch (err) {
    console.error('Failed to toggle alert status:', err);
  }
}

async function deleteAlert(id) {
  try {
    const response = await fetch(`/api/alerts/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Delete failed');
    await loadAlerts();
  } catch (err) {
    console.error('Failed to delete alert:', err);
  }
}

async function handleCreateAlert(e) {
  e.preventDefault();

  const name = alertElements.alertNameInput.value.trim();
  const field1 = alertElements.leftMetricSelect.value;
  const operator = alertElements.operatorSelect.value;
  const compareType = alertElements.compareTypeSelect.value;
  const frequency_minutes = Number(alertElements.frequencySelect.value);

  const expression = {
    field1,
    operator,
    compareType
  };

  if (compareType === 'value') {
    const val = Number(alertElements.rightValueInput.value);
    if (isNaN(val)) {
      showFeedback(alertElements.formFeedback, 'Please enter a valid numeric target value.', false);
      return;
    }
    expression.value = val;
  } else {
    expression.field2 = alertElements.rightMetricSelect.value;
  }

  try {
    const response = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, expression, frequency_minutes })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to create alert.');

    showFeedback(alertElements.formFeedback, 'Alert created successfully!', true);
    alertElements.createAlertForm.reset();

    // Switch tabs to alerts list
    alertElements.tabActiveAlerts.click();
    await loadAlerts();
  } catch (err) {
    showFeedback(alertElements.formFeedback, err.message, false);
  }
}

// Attach UI Event Listeners
alertElements.toggleSettingsBtn.addEventListener('click', () => {
  alertElements.settingsDrawer.classList.toggle('hidden');
});

alertElements.saveConfigBtn.addEventListener('click', saveTelegramConfig);
alertElements.testBotBtn.addEventListener('click', testTelegramConnection);

alertElements.tabActiveAlerts.addEventListener('click', () => {
  alertElements.tabActiveAlerts.classList.add('active');
  alertElements.tabCreateAlert.classList.remove('active');
  alertElements.tabContentList.classList.remove('hidden');
  alertElements.tabContentForm.classList.add('hidden');
});

alertElements.tabCreateAlert.addEventListener('click', () => {
  alertElements.tabCreateAlert.classList.add('active');
  alertElements.tabActiveAlerts.classList.remove('active');
  alertElements.tabContentForm.classList.remove('hidden');
  alertElements.tabContentList.classList.add('hidden');
});

alertElements.compareTypeSelect.addEventListener('change', () => {
  const isValue = alertElements.compareTypeSelect.value === 'value';
  alertElements.rightValueGroup.classList.toggle('hidden', !isValue);
  alertElements.rightMetricGroup.classList.toggle('hidden', isValue);

  if (isValue) {
    alertElements.rightValueInput.required = true;
    alertElements.rightMetricSelect.required = false;
  } else {
    alertElements.rightValueInput.required = false;
    alertElements.rightMetricSelect.required = true;
  }
});

alertElements.createAlertForm.addEventListener('submit', handleCreateAlert);

// Startup Initialization
populateMetricSelects();
loadTelegramConfig().catch(console.error);
loadAlerts().catch(console.error);

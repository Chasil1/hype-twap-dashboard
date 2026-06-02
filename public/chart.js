// Active charts and series references
let priceChart = null;
let priceSeries = null;
let twapChart = null;
let twapSeriesMap = {};

let activeCharts = []; // Price, TWAP, and dynamic subcharts
let dynamicPanels = []; // list of: { panelId, chart, activeMetrics }
let panelCount = 0; // panel numbering index

let currentBuckets = [];
let selectedTimeframe = '1m';
let selectedTwapMode = 'spotPerp';

function getLocalTimestamp(timestampStr) {
  const d = new Date(timestampStr);
  const localTimeMs = d.getTime() - (d.getTimezoneOffset() * 60 * 1000);
  return Math.floor(localTimeMs / 1000);
}

// UI Selectors
const snapshotCount = document.querySelector('#snapshotCount');
const priceRange = document.querySelector('#priceRange');
const timeframeButtons = [...document.querySelectorAll('.timeframe')];
const twapModeButtons = [...document.querySelectorAll('.twap-mode')];
const metricInputs = [...document.querySelectorAll('[data-metric]')];
const addNewPanelBtn = document.querySelector('#addNewPanelBtn');
const exchangeSourceSelect = document.querySelector('#exchangeSourceSelect');
const chartsStack = document.querySelector('#chartsStack');

// Chart Theme styling
const chartTheme = {
  layout: {
    background: { type: 'solid', color: '#11161a' },
    textColor: '#81908b',
    fontSize: 11,
    fontFamily: 'Segoe UI, sans-serif'
  },
  grid: {
    vertLines: { color: 'rgba(38, 49, 55, 0.4)' },
    horzLines: { color: 'rgba(38, 49, 55, 0.4)' }
  },
  crosshair: {
    mode: 0 // Normal
  },
  rightPriceScale: {
    borderColor: '#263137',
    alignLabels: true
  },
  timeScale: {
    borderColor: '#263137',
    timeVisible: true,
    secondsVisible: false
  }
};

// Compact number formatting (e.g. 100500 -> $100.5k, 5400000 -> $5.4M)
function formatKandM(val) {
  if (val === null || val === undefined || !Number.isFinite(val)) return '';
  const absVal = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (absVal >= 1_000_000) {
    return sign + '$' + (absVal / 1_000_000).toFixed(1) + 'M';
  }
  if (absVal >= 1_000) {
    return sign + '$' + (absVal / 1_000).toFixed(1) + 'k';
  }
  return sign + '$' + absVal.toFixed(2);
}

function formatPrice(value) {
  return Number.isFinite(value) ? `$${value.toFixed(4)}` : '--';
}

// Automatic Resizing Observer
const resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const container = entry.target;
    const chart = activeCharts.find(c => c._container === container);
    if (chart && entry.contentRect.height > 10) {
      chart.resize(entry.contentRect.width, entry.contentRect.height);

      // Update ruler canvas size if exists
      const canvas = container.querySelector('.ruler-canvas');
      if (canvas) {
        canvas.width = entry.contentRect.width;
        canvas.height = entry.contentRect.height;
        if (canvas.drawRuler) {
          canvas.drawRuler();
        }
      }
    }
  }
});

// Timescale Synchronization Logic (Registered once per chart instance on init)
let isTimescaleSyncing = false;
function handleTimescaleChange(srcChart, range) {
  if (isTimescaleSyncing || !range) return;
  isTimescaleSyncing = true;
  activeCharts.forEach((targetChart) => {
    if (targetChart !== srcChart) {
      targetChart.timeScale().setVisibleLogicalRange(range);
    }
  });
  isTimescaleSyncing = false;
}

// Crosshair Synchronization Logic (Registered once per chart instance on init)
let isCrosshairSyncing = false;
function handleCrosshairMove(srcChart, param) {
  if (isCrosshairSyncing) return;
  isCrosshairSyncing = true;

  const time = param.time;
  activeCharts.forEach((targetChart) => {
    if (targetChart !== srcChart) {
      if (time === undefined || param.logical === undefined) {
        targetChart.clearCrosshairPosition();
      } else {
        const targetSeries = targetChart._syncSeries;
        if (targetSeries) {
          const bucket = currentBuckets.find(
            (b) => getLocalTimestamp(b.timestamp) === time
          );

          let targetPrice = 0;
          if (bucket) {
            if (targetChart._type === 'price') {
              targetPrice = bucket.close ?? bucket.price ?? 0;
            } else if (targetChart._type === 'twap') {
              const mode = selectedTwapMode;
              targetPrice = bucket.twapModes?.[mode]?.twapNet1h ?? bucket.twapNet1h ?? 0;
            } else if (targetChart._type === 'dynamic') {
              const panelId = targetChart._panelId;
              const panel = dynamicPanels.find(p => p.panelId === panelId);
              if (panel) {
                // Find first active metric key to snap to
                const firstKey = Object.keys(panel.activeMetrics)[0];
                if (firstKey) {
                  const metric = panel.activeMetrics[firstKey];
                  const type = metric.type;
                  const suffix = metric.depth.replace('.', '_');
                  const source = exchangeSourceSelect.value;
                  
                  if (type === 'bid' || type === 'ask') {
                    if (source === 'combined') {
                      targetPrice = ((bucket[`bybit_${type}_${suffix}`] || 0) + (bucket[`hl_${type}_${suffix}`] || 0)) || 0;
                    } else if (source === 'hl') {
                      targetPrice = bucket[`hl_${type}_${suffix}`] ?? 0;
                    } else {
                      targetPrice = bucket[`bybit_${type}_${suffix}`] ?? 0;
                    }
                  } else if (type === 'diff') {
                    let bidVal = 0;
                    let askVal = 0;
                    if (source === 'bybit') {
                      bidVal = bucket[`bybit_bid_${suffix}`] || 0;
                      askVal = bucket[`bybit_ask_${suffix}`] || 0;
                    } else if (source === 'hl') {
                      bidVal = bucket[`hl_bid_${suffix}`] || 0;
                      askVal = bucket[`hl_ask_${suffix}`] || 0;
                    } else {
                      bidVal = (bucket[`bybit_bid_${suffix}`] || 0) + (bucket[`hl_bid_${suffix}`] || 0);
                      askVal = (bucket[`bybit_ask_${suffix}`] || 0) + (bucket[`hl_ask_${suffix}`] || 0);
                    }
                    targetPrice = bidVal - askVal;
                  }
                }
              }
            }
          }
          targetChart.setCrosshairPosition(targetPrice, time, targetSeries);
        }
      }
    }
  });

  isCrosshairSyncing = false;
}

// 1. Initializing Price Chart
function initPriceChart() {
  const container = document.querySelector('#priceChart');
  const rect = container.getBoundingClientRect();
  
  priceChart = LightweightCharts.createChart(container, {
    ...chartTheme,
    width: rect.width,
    height: rect.height || 300,
    localization: {
      priceFormatter: formatPrice
    }
  });

  priceSeries = priceChart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#35d083',
    downColor: '#ef5e5e',
    borderVisible: false,
    wickUpColor: '#35d083',
    wickDownColor: '#ef5e5e',
    priceLineVisible: false
  });

  priceChart._type = 'price';
  priceChart._container = container;
  priceChart._syncSeries = priceSeries;

  activeCharts.push(priceChart);
  resizeObserver.observe(container);

  // Register Event Listeners once
  priceChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    handleTimescaleChange(priceChart, range);
  });
  priceChart.subscribeCrosshairMove((param) => {
    handleCrosshairMove(priceChart, param);
  });
}

// 2. Initializing TWAP Chart
function initTwapChart() {
  const container = document.querySelector('#twapChart');
  const rect = container.getBoundingClientRect();

  twapChart = LightweightCharts.createChart(container, {
    ...chartTheme,
    width: rect.width,
    height: rect.height || 240,
    localization: {
      priceFormatter: formatKandM
    }
  });

  twapSeriesMap = {
    twapNet1h: twapChart.addSeries(LightweightCharts.LineSeries, { color: '#5aa7ff', lineWidth: 2, title: 'Net 1H', priceLineVisible: false }),
    twapNet24h: twapChart.addSeries(LightweightCharts.LineSeries, { color: '#eef4ee', lineWidth: 1.5, title: 'Net 24H', priceLineVisible: false }),
    twapBuy24h: twapChart.addSeries(LightweightCharts.LineSeries, { color: '#35d083', lineWidth: 1.5, title: 'Buy 24H', priceLineVisible: false }),
    twapSell24h: twapChart.addSeries(LightweightCharts.LineSeries, { color: '#ef5e5e', lineWidth: 1.5, title: 'Sell 24H', priceLineVisible: false })
  };

  twapChart._type = 'twap';
  twapChart._container = container;
  twapChart._syncSeries = twapSeriesMap.twapNet1h;

  activeCharts.push(twapChart);
  resizeObserver.observe(container);
  updateTwapSeriesVisibility();

  // Register Event Listeners once
  twapChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    handleTimescaleChange(twapChart, range);
  });
  twapChart.subscribeCrosshairMove((param) => {
    handleCrosshairMove(twapChart, param);
  });
}

// Update TWAP Series visibility based on checklist
function updateTwapSeriesVisibility() {
  metricInputs.forEach((input) => {
    const key = input.dataset.metric;
    const series = twapSeriesMap[key];
    if (series) {
      series.applyOptions({
        visible: input.checked
      });
    }
  });
}

// Custom colors mapping based on type and depth percentages
function getMetricColor(type, depth) {
  const colors = {
    '1.5': { bid: '#2af598', ask: '#ff4e50', diff: '#5aa7ff' },
    '3':   { bid: '#35d083', ask: '#ef5e5e', diff: '#00c6ff' },
    '5':   { bid: '#7efeb4', ask: '#ff9595', diff: '#0072ff' },
    '8':   { bid: '#10ac84', ask: '#ee5253', diff: '#5f27cd' },
    '15':  { bid: '#05c46b', ask: '#ff3f34', diff: '#ff9f43' },
    '30':  { bid: '#00d2d3', ask: '#ff6b6b', diff: '#f5d020' },
    '60':  { bid: '#1dd1a1', ask: '#ff6b81', diff: '#95afc0' }
  };
  return colors[depth]?.[type] ?? '#ffffff';
}

// Update dynamic subchart metric series visibility based on exchange source selection
function updatePanelMetricVisibility(panel, metricKey) {
  const source = exchangeSourceSelect.value;
  const metric = panel.activeMetrics[metricKey];
  if (!metric) return;

  if (metric.type === 'bid' || metric.type === 'ask') {
    const s = metric.series;
    s.bybit.applyOptions({ visible: (source === 'bybit' || source === 'all') });
    s.hl.applyOptions({ visible: (source === 'hl' || source === 'all') });
    s.combined.applyOptions({ visible: (source === 'combined') });
  } else if (metric.type === 'diff') {
    metric.series.diff.applyOptions({ visible: true });
  }
}

// Update all dynamic subcharts when global configurations change
function updateAllSubcharts() {
  dynamicPanels.forEach((panel) => {
    Object.keys(panel.activeMetrics).forEach((metricKey) => {
      updatePanelMetricVisibility(panel, metricKey);
      if (panel.activeMetrics[metricKey].type === 'diff') {
        populatePanelDiffData(panel, metricKey);
      }
    });
  });
}

// Create a new empty dynamic subchart panel
function createNewPanel() {
  panelCount++;
  const panelId = `panel_${Date.now()}`;

  const wrapperDiv = document.createElement('div');
  wrapperDiv.className = 'chart-wrapper-container dynamic-panel-container';
  wrapperDiv.setAttribute('data-panel-id', panelId);

  wrapperDiv.innerHTML = `
    <div class="panel-header-controls">
      <span class="panel-label">Subchart #${panelCount}</span>
      <div class="panel-actions-group">
        <select class="add-metric-select" data-panel-id="${panelId}">
          <option value="" disabled selected>+ Add Metric...</option>
          <optgroup label="Bid Depth">
            <option value="bid_1.5">Bid Depth 1.5%</option>
            <option value="bid_3">Bid Depth 3%</option>
            <option value="bid_5">Bid Depth 5%</option>
            <option value="bid_8">Bid Depth 8%</option>
            <option value="bid_15">Bid Depth 15%</option>
            <option value="bid_30">Bid Depth 30%</option>
            <option value="bid_60">Bid Depth 60%</option>
          </optgroup>
          <optgroup label="Ask Depth">
            <option value="ask_1.5">Ask Depth 1.5%</option>
            <option value="ask_3">Ask Depth 3%</option>
            <option value="ask_5">Ask Depth 5%</option>
            <option value="ask_8">Ask Depth 8%</option>
            <option value="ask_15">Ask Depth 15%</option>
            <option value="ask_30">Ask Depth 30%</option>
            <option value="ask_60">Ask Depth 60%</option>
          </optgroup>
          <optgroup label="Difference (Bid - Ask)">
            <option value="diff_1.5">Diff Depth 1.5%</option>
            <option value="diff_3">Diff Depth 3%</option>
            <option value="diff_5">Diff Depth 5%</option>
            <option value="diff_8">Diff Depth 8%</option>
            <option value="diff_15">Diff Depth 15%</option>
            <option value="diff_30">Diff Depth 30%</option>
            <option value="diff_60">Diff Depth 60%</option>
          </optgroup>
        </select>
        <button class="close-panel-btn" data-panel-id="${panelId}" type="button">×</button>
      </div>
    </div>
    <div class="active-metrics-badges" id="badges_${panelId}"></div>
    <div id="chart_${panelId}" class="lightweight-chart-wrapper subchart-wrapper"></div>
  `;

  chartsStack.appendChild(wrapperDiv);

  const container = document.getElementById(`chart_${panelId}`);
  const rect = container.getBoundingClientRect();

  const chart = LightweightCharts.createChart(container, {
    ...chartTheme,
    width: rect.width || 300,
    height: rect.height || 160,
    localization: {
      priceFormatter: formatKandM
    }
  });

  chart._type = 'dynamic';
  chart._panelId = panelId;
  chart._container = container;

  const panelObj = {
    panelId,
    chart,
    activeMetrics: {}
  };

  dynamicPanels.push(panelObj);
  activeCharts.push(chart);
  resizeObserver.observe(container);

  // Synchronization event listeners
  chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    handleTimescaleChange(chart, range);
  });
  chart.subscribeCrosshairMove((param) => {
    handleCrosshairMove(chart, param);
  });

  // Setup Event Listeners
  wrapperDiv.querySelector('.close-panel-btn').addEventListener('click', () => {
    removePanel(panelId);
  });

  wrapperDiv.querySelector('.add-metric-select').addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) return;
    const parts = val.split('_');
    addMetricToPanel(panelId, parts[0], parts[1]);
    e.target.value = ''; // reset dropdown select
  });

  // Sync to current timescale range
  const currentRange = priceChart.timeScale().getVisibleLogicalRange();
  if (currentRange) {
    chart.timeScale().setVisibleLogicalRange(currentRange);
  }

  if (isRulerModeActive) {
    updateRulerOverlays();
  }
}

// Add a specific metric onto a dynamic subchart panel
function addMetricToPanel(panelId, type, depth) {
  const panel = dynamicPanels.find(p => p.panelId === panelId);
  if (!panel) return;

  const metricKey = `${type}_${depth}`;
  if (panel.activeMetrics[metricKey]) return; // already added

  const color = getMetricColor(type, depth);
  const series = {};

  if (type === 'bid' || type === 'ask') {
    series.bybit = panel.chart.addSeries(LightweightCharts.LineSeries, {
      color: color,
      lineWidth: 1.5,
      title: `Bybit ${type === 'bid' ? 'Bid' : 'Ask'} ${depth}%`,
      priceLineVisible: false
    });
    series.hl = panel.chart.addSeries(LightweightCharts.LineSeries, {
      color: color,
      lineWidth: 1.2,
      lineStyle: 2,
      title: `HL ${type === 'bid' ? 'Bid' : 'Ask'} ${depth}%`,
      priceLineVisible: false
    });
    series.combined = panel.chart.addSeries(LightweightCharts.LineSeries, {
      color: color,
      lineWidth: 2.2,
      title: `Combined ${type === 'bid' ? 'Bid' : 'Ask'} ${depth}%`,
      priceLineVisible: false
    });
  } else if (type === 'diff') {
    series.diff = panel.chart.addSeries(LightweightCharts.BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: '#35d083',          // Green line for positive values
      topFillColor1: 'rgba(53, 208, 131, 0.15)',
      topFillColor2: 'rgba(53, 208, 131, 0.0)',
      bottomLineColor: '#ef5e5e',       // Red line for negative values
      bottomFillColor1: 'rgba(239, 94, 94, 0.0)',
      bottomFillColor2: 'rgba(239, 94, 94, 0.15)',
      lineWidth: 2,
      title: `Diff ${depth}%`,
      priceLineVisible: false
    });
  }

  panel.activeMetrics[metricKey] = {
    type,
    depth,
    color,
    series
  };

  // Sync crosshair snap series reference to the first metric added
  const firstKey = Object.keys(panel.activeMetrics)[0];
  if (firstKey) {
    const firstMetric = panel.activeMetrics[firstKey];
    panel.chart._syncSeries = firstMetric.type === 'diff' ? firstMetric.series.diff : firstMetric.series.combined;
  }

  updatePanelBadges(panelId);
  updatePanelMetricVisibility(panel, metricKey);

  if (type === 'diff') {
    populatePanelDiffData(panel, metricKey);
  } else {
    populatePanelDepthData(panel, metricKey);
  }
}

// Remove a specific metric from a dynamic subchart panel
function removeMetricFromPanel(panelId, metricKey) {
  const panel = dynamicPanels.find(p => p.panelId === panelId);
  if (!panel) return;

  const metric = panel.activeMetrics[metricKey];
  if (!metric) return;

  Object.values(metric.series).forEach((seriesInstance) => {
    panel.chart.removeSeries(seriesInstance);
  });

  delete panel.activeMetrics[metricKey];

  // Update crosshair snap reference
  const firstKey = Object.keys(panel.activeMetrics)[0];
  if (firstKey) {
    const firstMetric = panel.activeMetrics[firstKey];
    panel.chart._syncSeries = firstMetric.type === 'diff' ? firstMetric.series.diff : firstMetric.series.combined;
  } else {
    panel.chart._syncSeries = null;
  }

  updatePanelBadges(panelId);
}

// Render active metric badges inside panel header
function updatePanelBadges(panelId) {
  const panel = dynamicPanels.find(p => p.panelId === panelId);
  if (!panel) return;

  const badgesDiv = document.getElementById(`badges_${panelId}`);
  if (!badgesDiv) return;

  badgesDiv.innerHTML = '';

  Object.keys(panel.activeMetrics).forEach((metricKey) => {
    const metric = panel.activeMetrics[metricKey];
    const label = `${metric.type.toUpperCase()} ${metric.depth}%`;

    const badge = document.createElement('div');
    badge.className = 'metric-badge';
    badge.innerHTML = `
      <span class="badge-color-dot" style="background-color: ${metric.color};"></span>
      <span>${label}</span>
      <button class="remove-badge-btn" type="button" data-metric-key="${metricKey}">×</button>
    `;

    badge.querySelector('.remove-badge-btn').addEventListener('click', () => {
      removeMetricFromPanel(panelId, metricKey);
    });

    badgesDiv.appendChild(badge);
  });
}

// Remove dynamic panel instance
function removePanel(panelId) {
  const panelIndex = dynamicPanels.findIndex(p => p.panelId === panelId);
  if (panelIndex === -1) return;

  const panel = dynamicPanels[panelIndex];

  if (panel._container) {
    resizeObserver.unobserve(panel._container);
  }

  activeCharts = activeCharts.filter((c) => c !== panel.chart);
  dynamicPanels.splice(panelIndex, 1);

  const wrapper = chartsStack.querySelector(`[data-panel-id="${panelId}"]`);
  if (wrapper) {
    wrapper.remove();
  }

  // Re-sync logical range for remaining charts
  const range = priceChart.timeScale().getVisibleLogicalRange();
  if (range) {
    activeCharts.forEach((targetChart) => {
      targetChart.timeScale().setVisibleLogicalRange(range);
    });
  }
}

// Populate Data
function populatePriceData() {
  const candles = currentBuckets.map((bucket) => ({
    time: getLocalTimestamp(bucket.timestamp),
    open: bucket.open ?? bucket.price,
    high: bucket.high ?? bucket.price,
    low: bucket.low ?? bucket.price,
    close: bucket.close ?? bucket.price
  })).filter((c) => Number.isFinite(c.open));

  priceSeries.setData(candles);

  if (candles.length > 0) {
    const minPrice = Math.min(...candles.map(c => c.low));
    const maxPrice = Math.max(...candles.map(c => c.high));
    priceRange.textContent = `${formatPrice(minPrice)} - ${formatPrice(maxPrice)}`;
  } else {
    priceRange.textContent = '--';
  }
}

function populateTwapData() {
  const map = {
    twapNet1h: [],
    twapNet24h: [],
    twapBuy24h: [],
    twapSell24h: []
  };

  currentBuckets.forEach((bucket) => {
      const time = getLocalTimestamp(bucket.timestamp);
    const mode = selectedTwapMode;
    
    const valNet1h = bucket.twapModes?.[mode]?.twapNet1h ?? bucket.twapNet1h;
    const valNet24h = bucket.twapModes?.[mode]?.twapNet24h ?? bucket.twapNet24h;
    const valBuy24h = bucket.twapModes?.[mode]?.twapBuy24h ?? bucket.twapBuy24h;
    const valSell24h = bucket.twapModes?.[mode]?.twapSell24h ?? bucket.twapSell24h;

    if (Number.isFinite(valNet1h)) map.twapNet1h.push({ time, value: valNet1h });
    if (Number.isFinite(valNet24h)) map.twapNet24h.push({ time, value: valNet24h });
    if (Number.isFinite(valBuy24h)) map.twapBuy24h.push({ time, value: valBuy24h });
    if (Number.isFinite(valSell24h)) map.twapSell24h.push({ time, value: valSell24h });
  });

  Object.keys(twapSeriesMap).forEach((key) => {
    twapSeriesMap[key].setData(map[key]);
  });
}

function populatePanelDepthData(panel, metricKey) {
  const metric = panel.activeMetrics[metricKey];
  if (!metric) return;

  const { type, depth, series } = metric;
  const suffix = depth.replace('.', '_');
  const dataset = {
    bybit: [],
    hl: [],
    combined: []
  };

  currentBuckets.forEach((bucket) => {
      const time = getLocalTimestamp(bucket.timestamp);
    const valBybit = bucket[`bybit_${type}_${suffix}`];
    const valHl = bucket[`hl_${type}_${suffix}`];

    if (Number.isFinite(valBybit)) dataset.bybit.push({ time, value: valBybit });
    if (Number.isFinite(valHl)) dataset.hl.push({ time, value: valHl });

    const hasBybit = Number.isFinite(valBybit);
    const hasHl = Number.isFinite(valHl);
    if (hasBybit || hasHl) {
      dataset.combined.push({ time, value: (valBybit || 0) + (valHl || 0) });
    }
  });

  series.bybit.setData(dataset.bybit);
  series.hl.setData(dataset.hl);
  series.combined.setData(dataset.combined);
}

function populatePanelDiffData(panel, metricKey) {
  const metric = panel.activeMetrics[metricKey];
  if (!metric) return;

  const { depth, series } = metric;
  const suffix = depth.replace('.', '_');
  const source = exchangeSourceSelect.value;
  const diffData = [];

  currentBuckets.forEach((bucket) => {
      const time = getLocalTimestamp(bucket.timestamp);
    const bybitBid = bucket[`bybit_bid_${suffix}`];
    const bybitAsk = bucket[`bybit_ask_${suffix}`];
    const hlBid = bucket[`hl_bid_${suffix}`];
    const hlAsk = bucket[`hl_ask_${suffix}`];

    let bidVal = null;
    let askVal = null;

    if (source === 'bybit') {
      if (Number.isFinite(bybitBid)) bidVal = bybitBid;
      if (Number.isFinite(bybitAsk)) askVal = bybitAsk;
    } else if (source === 'hl') {
      if (Number.isFinite(hlBid)) bidVal = hlBid;
      if (Number.isFinite(hlAsk)) askVal = hlAsk;
    } else {
      // Combined or All: show combined diff
      const hasBybitBid = Number.isFinite(bybitBid);
      const hasHlBid = Number.isFinite(hlBid);
      if (hasBybitBid || hasHlBid) bidVal = (bybitBid || 0) + (hlBid || 0);

      const hasBybitAsk = Number.isFinite(bybitAsk);
      const hasHlAsk = Number.isFinite(hlAsk);
      if (hasBybitAsk || hasHlAsk) askVal = (bybitAsk || 0) + (hlAsk || 0);
    }

    if (bidVal !== null || askVal !== null) {
      diffData.push({ time, value: (bidVal || 0) - (askVal || 0) });
    }
  });

  series.diff.setData(diffData);
}

function populateAllChartsData() {
  populatePriceData();
  populateTwapData();
  dynamicPanels.forEach((panel) => {
    Object.keys(panel.activeMetrics).forEach((metricKey) => {
      const metric = panel.activeMetrics[metricKey];
      if (metric.type === 'diff') {
        populatePanelDiffData(panel, metricKey);
      } else {
        populatePanelDepthData(panel, metricKey);
      }
    });
  });
}

// Refresh from Backend
async function refreshChart() {
  try {
    const response = await fetch(`/api/snapshots?timeframe=${encodeURIComponent(selectedTimeframe)}`);
    currentBuckets = await response.json();
    snapshotCount.textContent = String(currentBuckets.length);
    populateAllChartsData();
  } catch (err) {
    console.error('Error refreshing chart snapshot data:', err);
  }
}

// Event Listeners
timeframeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedTimeframe = button.dataset.timeframe;
    timeframeButtons.forEach((item) => item.classList.toggle('active', item === button));
    refreshChart().catch(console.error);
  });
});

twapModeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedTwapMode = button.dataset.twapMode;
    twapModeButtons.forEach((item) => item.classList.toggle('active', item === button));
    populateTwapData();
  });
});

metricInputs.forEach((input) => {
  input.addEventListener('change', () => {
    updateTwapSeriesVisibility();
  });
});

// Dropdown Add Subchart handler
addNewPanelBtn.addEventListener('click', () => {
  createNewPanel();
});

// Global control listeners
exchangeSourceSelect.addEventListener('change', () => {
  updateAllSubcharts();
});

// Presets Implementation
const savePresetModal = document.getElementById('savePresetModal');
const presetNameInput = document.getElementById('presetNameInput');
const saveTimeframeCheckbox = document.getElementById('saveTimeframeCheckbox');
const confirmSavePresetBtn = document.getElementById('confirmSavePresetBtn');
const cancelSavePresetBtn = document.getElementById('cancelSavePresetBtn');
const presetSelect = document.getElementById('presetSelect');
const deletePresetBtn = document.getElementById('deletePresetBtn');
const savePresetBtn = document.getElementById('savePresetBtn');

function getPresetsKey() {
  return (currentUser && currentUser.id) ? `hype_chart_presets_${currentUser.id}` : 'hype_chart_presets_public';
}

function saveCurrentAsPreset(presetName, includeTimeframe) {
  const presetKey = getPresetsKey();
  const presets = JSON.parse(localStorage.getItem(presetKey) || '{}');

  const panelsData = dynamicPanels.map((panel) => {
    const metrics = Object.keys(panel.activeMetrics).map((metricKey) => {
      const m = panel.activeMetrics[metricKey];
      return { type: m.type, depth: m.depth };
    });
    return { metrics };
  });

  presets[presetName] = {
    name: presetName,
    exchange: exchangeSourceSelect.value,
    timeframe: includeTimeframe ? selectedTimeframe : null,
    panels: panelsData
  };

  localStorage.setItem(presetKey, JSON.stringify(presets));
  populatePresetSelectDropdown();
}

function loadPreset(presetName) {
  const presetKey = getPresetsKey();
  const presets = JSON.parse(localStorage.getItem(presetKey) || '{}');
  const preset = presets[presetName];
  if (!preset) return;

  // 1. Clear all existing panels (create a copy to prevent mutation bugs)
  const panelIds = dynamicPanels.map(p => p.panelId);
  panelIds.forEach(id => removePanel(id));

  // 2. Set global exchange source
  if (preset.exchange) {
    exchangeSourceSelect.value = preset.exchange;
  }

  // 3. Set timeframe if stored in preset
  if (preset.timeframe) {
    selectedTimeframe = preset.timeframe;
    timeframeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.timeframe === selectedTimeframe);
    });
    refreshChart().catch(console.error);
  }

  // 4. Rebuild panels
  preset.panels.forEach((panelData) => {
    createNewPanel();
    const newPanel = dynamicPanels[dynamicPanels.length - 1];
    if (newPanel) {
      panelData.metrics.forEach((metric) => {
        addMetricToPanel(newPanel.panelId, metric.type, metric.depth);
      });
    }
  });

  updateAllSubcharts();
  populateAllChartsData();
}

function deletePreset(presetName) {
  if (!presetName) return;
  const presetKey = getPresetsKey();
  const presets = JSON.parse(localStorage.getItem(presetKey) || '{}');
  if (presets[presetName]) {
    delete presets[presetName];
    localStorage.setItem(presetKey, JSON.stringify(presets));
    populatePresetSelectDropdown();
  }
}

function populatePresetSelectDropdown() {
  if (!presetSelect) return;
  presetSelect.innerHTML = '<option value="" disabled selected>Load Preset...</option>';

  const presetKey = getPresetsKey();
  const presets = JSON.parse(localStorage.getItem(presetKey) || '{}');
  Object.keys(presets).forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    presetSelect.appendChild(opt);
  });
}

function showSaveModal() {
  presetNameInput.value = '';
  const label = saveTimeframeCheckbox.parentElement;
  if (label) {
    label.innerHTML = `<input type="checkbox" id="saveTimeframeCheckbox" checked> Include current timeframe (${selectedTimeframe})`;
  }
  savePresetModal.classList.remove('hidden');
  presetNameInput.focus();
}

function hideSaveModal() {
  savePresetModal.classList.add('hidden');
}

// Preset Event Listeners
savePresetBtn.addEventListener('click', showSaveModal);
cancelSavePresetBtn.addEventListener('click', hideSaveModal);

confirmSavePresetBtn.addEventListener('click', () => {
  const name = presetNameInput.value.trim();
  if (!name) {
    alert('Please enter a preset name.');
    return;
  }
  const includeTf = document.getElementById('saveTimeframeCheckbox').checked;
  saveCurrentAsPreset(name, includeTf);
  hideSaveModal();
});

presetSelect.addEventListener('change', (e) => {
  const val = e.target.value;
  if (!val) return;
  loadPreset(val);
});

deletePresetBtn.addEventListener('click', () => {
  const val = presetSelect.value;
  if (!val) {
    alert('Please select a preset to delete from the dropdown.');
    return;
  }
  if (confirm(`Are you sure you want to delete preset "${val}"?`)) {
    deletePreset(val);
    presetSelect.value = '';
  }
});

// ==========================================
// CHART RULER TOOL IMPLEMENTATION
// ==========================================

let isRulerModeActive = false;

function updateRulerOverlays() {
  activeCharts.forEach((chart) => {
    const container = chart._container;
    if (!container) return;

    let canvas = container.querySelector('.ruler-canvas');
    if (isRulerModeActive) {
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.className = 'ruler-canvas';
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.zIndex = '100';
        canvas.style.cursor = 'crosshair';
        canvas.style.pointerEvents = 'auto';

        const rect = container.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        container.appendChild(canvas);
        setupRulerEvents(canvas, chart);
      } else {
        canvas.style.display = 'block';
        canvas.style.pointerEvents = 'auto';
      }
    } else {
      if (canvas) {
        canvas.style.display = 'none';
        canvas.style.pointerEvents = 'none';
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.measureState = null;
      }
    }
  });
}

function setupRulerEvents(canvas, chart) {
  canvas.drawRuler = () => drawRuler(canvas, chart);

  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    canvas.measureState = {
      startX: e.offsetX,
      startY: e.offsetY,
      currentX: e.offsetX,
      currentY: e.offsetY,
      isDrawing: true,
      locked: false
    };
    canvas.drawRuler();
  });

  canvas.addEventListener('mousemove', (e) => {
    e.preventDefault();
    canvas.hoverX = e.offsetX;
    canvas.hoverY = e.offsetY;

    const state = canvas.measureState;
    if (state && state.isDrawing) {
      state.currentX = e.offsetX;
      state.currentY = e.offsetY;
    }
    canvas.drawRuler();
  });

  canvas.addEventListener('mouseup', (e) => {
    e.preventDefault();
    const state = canvas.measureState;
    if (state && state.isDrawing) {
      state.isDrawing = false;
      state.locked = true;
      canvas.drawRuler();
    }
  });

  canvas.addEventListener('mouseenter', (e) => {
    canvas.hoverX = e.offsetX;
    canvas.hoverY = e.offsetY;
    canvas.drawRuler();
  });

  canvas.addEventListener('mouseleave', (e) => {
    canvas.hoverX = undefined;
    canvas.hoverY = undefined;
    const state = canvas.measureState;
    if (state && state.isDrawing) {
      state.isDrawing = false;
      state.locked = true;
    }
    canvas.drawRuler();
  });
}

function drawRuler(canvas, chart) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const state = canvas.measureState;
  const hoverX = canvas.hoverX;
  const hoverY = canvas.hoverY;

  // 1. Draw crosshair guidelines
  if (hoverX !== undefined && hoverY !== undefined) {
    ctx.save();
    ctx.strokeStyle = 'rgba(129, 144, 139, 0.3)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    
    ctx.beginPath();
    ctx.moveTo(0, hoverY);
    ctx.lineTo(canvas.width, hoverY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(hoverX, 0);
    ctx.lineTo(hoverX, canvas.height);
    ctx.stroke();
    ctx.restore();
  }

  if (!state) return;

  const { startX, startY, currentX, currentY } = state;
  const series = chart._syncSeries;
  if (!series) return;

  const startVal = series.coordinateToPrice(startY);
  const currentVal = series.coordinateToPrice(currentY);

  if (startVal === null || currentVal === null || startVal === undefined || currentVal === undefined) {
    return;
  }

  ctx.save();

  const isUp = currentVal >= startVal;
  const colorBase = isUp ? '53, 208, 131' : '239, 94, 94';
  const fillColor = `rgba(${colorBase}, 0.12)`;
  const strokeColor = `rgba(${colorBase}, 0.85)`;

  // Rect fill
  ctx.fillStyle = fillColor;
  ctx.fillRect(startX, startY, currentX - startX, currentY - startY);

  // Rect border
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(startX, startY, currentX - startX, currentY - startY);

  // Diagonal connection
  ctx.strokeStyle = strokeColor;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(currentX, currentY);
  ctx.stroke();

  // Anchors
  ctx.fillStyle = strokeColor;
  ctx.beginPath();
  ctx.arc(startX, startY, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(currentX, currentY, 4, 0, Math.PI * 2);
  ctx.fill();

  // Label percentage calculation
  const deltaVal = currentVal - startVal;
  const pctChange = startVal !== 0 ? (deltaVal / Math.abs(startVal)) * 100 : 0;

  const sign = deltaVal >= 0 ? '+' : '';
  let startPriceStr = '';
  let endPriceStr = '';
  let deltaStr = '';

  if (chart._type === 'price') {
    startPriceStr = `$${startVal.toFixed(4)}`;
    endPriceStr = `$${currentVal.toFixed(4)}`;
    deltaStr = `${sign}${deltaVal.toFixed(4)}`;
  } else {
    startPriceStr = formatKandM(startVal);
    endPriceStr = formatKandM(currentVal);
    deltaStr = `${sign}${formatKandM(deltaVal)}`;
  }

  const line1 = `${startPriceStr} → ${endPriceStr}`;
  const line2 = `${deltaStr} (${sign}${pctChange.toFixed(2)}%)`;

  // Determine price scale width dynamically
  let scaleWidth = 65;
  try {
    if (chart && typeof chart.priceScale === 'function') {
      const pScale = chart.priceScale('right');
      if (pScale && typeof pScale.width === 'function') {
        scaleWidth = pScale.width();
      }
    }
  } catch (e) {
    console.error('Error getting price scale width:', e);
  }
  if (!scaleWidth || scaleWidth <= 0) scaleWidth = 65;

  const axisX = canvas.width - scaleWidth;
  const midY = (startY + currentY) / 2;

  // Render Start Price Tag on the axis
  ctx.fillStyle = '#263137'; // dark neutral gray for start price
  ctx.fillRect(axisX, startY - 9, scaleWidth - 2, 18);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 10px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(startPriceStr, axisX + (scaleWidth - 2) / 2, startY);

  // Render End Price Tag on the axis
  ctx.fillStyle = strokeColor; // Trend color (green or red)
  ctx.fillRect(axisX, currentY - 9, scaleWidth - 2, 18);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 10px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(endPriceStr, axisX + (scaleWidth - 2) / 2, currentY);

  // Render Delta / Percentage Tooltip (pinned next to axis)
  ctx.font = 'bold 11px Segoe UI, sans-serif';
  const labelWidth = ctx.measureText(line2).width;
  const paddingX = 8;
  const paddingY = 5;
  const rectW = labelWidth + paddingX * 2;
  const rectH = 22;

  const rectX = axisX - rectW - 6;
  const rectY = midY - rectH / 2;

  ctx.fillStyle = 'rgba(17, 22, 26, 0.96)';
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  
  ctx.beginPath();
  const radius = 4;
  ctx.moveTo(rectX + radius, rectY);
  ctx.lineTo(rectX + rectW - radius, rectY);
  ctx.quadraticCurveTo(rectX + rectW, rectY, rectX + rectW, rectY + radius);
  ctx.lineTo(rectX + rectW, rectY + rectH - radius);
  ctx.quadraticCurveTo(rectX + rectW, rectY + rectH, rectX + rectW - radius, rectY + rectH);
  ctx.lineTo(rectX + radius, rectY + rectH);
  ctx.quadraticCurveTo(rectX, rectY + rectH, rectX, rectY + rectH - radius);
  ctx.lineTo(rectX, rectY + radius);
  ctx.quadraticCurveTo(rectX, rectY, rectX + radius, rectY);
  ctx.closePath();
  
  ctx.fill();
  ctx.stroke();

  // Draw delta and percentage text inside the box
  ctx.fillStyle = isUp ? '#35d083' : '#ef5e5e';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(line2, rectX + rectW / 2, midY + 1);

  ctx.restore();
}

// Register click listener for the ruler button
const rulerToggleBtn = document.querySelector('#rulerToggleBtn');
if (rulerToggleBtn) {
  rulerToggleBtn.addEventListener('click', () => {
    isRulerModeActive = !isRulerModeActive;
    rulerToggleBtn.classList.toggle('active', isRulerModeActive);
    updateRulerOverlays();
  });
}

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
  addConditionBtn: document.querySelector('#addConditionBtn'),
  logicalOperatorSelect: document.querySelector('#logicalOperatorSelect'),
  logicalOperatorGroup: document.querySelector('#logicalOperatorGroup'),
  conditionsContainer: document.querySelector('#conditionsContainer'),
  trendModeSelect: document.querySelector('#trendModeSelect'),
  alertTimeframeSelect: document.querySelector('#alertTimeframeSelect'),
  frequencySelect: document.querySelector('#frequencySelect'),
  formFeedback: document.querySelector('#formFeedback'),
  editAlertId: document.querySelector('#editAlertId')
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

const depthsList = [1.5, 3, 5, 8, 15, 30, 60];
depthsList.forEach(d => {
  const suffix = String(d).replace('.', '_');
  METRIC_LABELS[`hl_bid_${suffix}`] = `HL Bid ${d}%`;
  METRIC_LABELS[`hl_ask_${suffix}`] = `HL Ask ${d}%`;
  METRIC_LABELS[`bybit_bid_${suffix}`] = `Bybit Bid ${d}%`;
  METRIC_LABELS[`bybit_ask_${suffix}`] = `Bybit Ask ${d}%`;
});

function populateAlertMetricSelectsForRow(row) {
  const selects = row.querySelectorAll('.metric-select');
  selects.forEach(select => {
    const optGroupHlBid = document.createElement('optgroup');
    optGroupHlBid.label = 'Hyperliquid Bid Depth';
    const optGroupHlAsk = document.createElement('optgroup');
    optGroupHlAsk.label = 'Hyperliquid Ask Depth';
    const optGroupBybitBid = document.createElement('optgroup');
    optGroupBybitBid.label = 'Bybit Bid Depth';
    const optGroupBybitAsk = document.createElement('optgroup');
    optGroupBybitAsk.label = 'Bybit Ask Depth';

    depthsList.forEach(d => {
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

function createConditionRow(data = null) {
  const row = document.createElement('div');
  row.className = 'condition-row';
  row.style.display = 'flex';
  row.style.flexDirection = 'column';
  row.style.gap = '8px';
  row.style.background = 'rgba(15, 19, 23, 0.4)';
  row.style.border = '1px solid var(--line)';
  row.style.borderRadius = '6px';
  row.style.padding = '12px';
  row.style.position = 'relative';

  row.innerHTML = `
    <button type="button" class="remove-condition-btn" style="position: absolute; right: 10px; top: 10px; background: transparent; border: 0; color: #ff5252; cursor: pointer; font-size: 14px; padding: 2px;">✕</button>
    
    <div style="display: grid; grid-template-columns: 2fr 1fr 2fr; gap: 8px; align-items: end;">
      <div class="form-group" style="margin-bottom: 0;">
        <label style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">Left Metric</label>
        <select class="metric-select left-metric-select" required style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;">
          <option value="price">HYPE Price</option>
          <option value="twapNet1h">TWAP Net 1H</option>
          <option value="twapNet24h">TWAP Net 24H</option>
          <option value="twapBuy24h">TWAP Buy 24H</option>
          <option value="twapSell24h">TWAP Sell 24H</option>
          <option value="activeBuyCount">Active Buy Count</option>
          <option value="activeSellCount">Active Sell Count</option>
        </select>
      </div>

      <div class="form-group" style="margin-bottom: 0;">
        <label style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">Operator</label>
        <select class="operator-select" required style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;">
          <option value="gt">&gt;</option>
          <option value="lt">&lt;</option>
          <option value="gte">&gt;=</option>
          <option value="lte">&lt;=</option>
        </select>
      </div>

      <div class="form-group" style="margin-bottom: 0;">
        <label style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">Compare With</label>
        <select class="compare-type-select" required style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;">
          <option value="value">Static Value</option>
          <option value="metric">Another Metric</option>
        </select>
      </div>
    </div>

    <div class="target-value-group form-group" style="margin-bottom: 0;">
      <label style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">Target Value</label>
      <input type="number" step="any" class="target-value-input" placeholder="e.g. 30000000 (for $30M)" required style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;"/>
    </div>

    <div class="target-metric-group form-group hidden" style="margin-bottom: 0;">
      <label style="font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;">Right Metric</label>
      <select class="metric-select right-metric-select" style="font-size: 12px; padding: 6px; background: #0f1317; border: 1px solid var(--line); color: var(--text); border-radius: 4px; width: 100%;">
        <option value="price">HYPE Price</option>
        <option value="twapNet1h">TWAP Net 1H</option>
        <option value="twapNet24h">TWAP Net 24H</option>
        <option value="twapBuy24h">TWAP Buy 24H</option>
        <option value="twapSell24h">TWAP Sell 24H</option>
        <option value="activeBuyCount">Active Buy Count</option>
        <option value="activeSellCount">Active Sell Count</option>
      </select>
    </div>
  `;

  populateAlertMetricSelectsForRow(row);

  const compareTypeSelect = row.querySelector('.compare-type-select');
  const valueGroup = row.querySelector('.target-value-group');
  const metricGroup = row.querySelector('.target-metric-group');
  const valueInput = row.querySelector('.target-value-input');

  compareTypeSelect.addEventListener('change', () => {
    if (compareTypeSelect.value === 'value') {
      valueGroup.classList.remove('hidden');
      metricGroup.classList.add('hidden');
      valueInput.required = true;
    } else {
      valueGroup.classList.add('hidden');
      metricGroup.classList.remove('hidden');
      valueInput.required = false;
    }
  });

  row.querySelector('.remove-condition-btn').addEventListener('click', () => {
    row.remove();
    updateLogicalOperatorVisibility();
  });

  if (data) {
    row.querySelector('.left-metric-select').value = data.field1;
    row.querySelector('.operator-select').value = data.operator;
    compareTypeSelect.value = data.compareType;
    if (data.compareType === 'value') {
      valueInput.value = data.value;
      valueGroup.classList.remove('hidden');
      metricGroup.classList.add('hidden');
      valueInput.required = true;
    } else {
      row.querySelector('.right-metric-select').value = data.field2;
      valueGroup.classList.add('hidden');
      metricGroup.classList.remove('hidden');
      valueInput.required = false;
    }
  }

  return row;
}

function updateLogicalOperatorVisibility() {
  const container = alertElements.conditionsContainer;
  const logicalOpGroup = alertElements.logicalOperatorGroup;
  if (!container || !logicalOpGroup) return;
  const rows = container.querySelectorAll('.condition-row');
  const rowsCount = rows.length;
  
  if (rowsCount > 1) {
    logicalOpGroup.classList.remove('hidden');
    rows.forEach(row => {
      let removeBtn = row.querySelector('.remove-condition-btn');
      if (!removeBtn) {
        removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-condition-btn';
        removeBtn.style.position = 'absolute';
        removeBtn.style.right = '10px';
        removeBtn.style.top = '10px';
        removeBtn.style.background = 'transparent';
        removeBtn.style.border = '0';
        removeBtn.style.color = '#ff5252';
        removeBtn.style.cursor = 'pointer';
        removeBtn.style.fontSize = '14px';
        removeBtn.style.padding = '2px';
        removeBtn.innerHTML = '✕';
        removeBtn.addEventListener('click', () => {
          row.remove();
          updateLogicalOperatorVisibility();
        });
        row.appendChild(removeBtn);
      }
    });
  } else {
    logicalOpGroup.classList.add('hidden');
    rows.forEach(row => {
      const removeBtn = row.querySelector('.remove-condition-btn');
      if (removeBtn) removeBtn.remove();
    });
  }
}

function resetAlertFormToDefault() {
  alertElements.createAlertForm.reset();
  const container = alertElements.conditionsContainer;
  if (container) {
    container.innerHTML = '';
    const row = createConditionRow();
    container.appendChild(row);
  }
  updateLogicalOperatorVisibility();
}

function showAlertFeedback(element, text, isSuccess) {
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
    showAlertFeedback(alertElements.settingsMessage, 'Settings saved successfully.', true);
    await loadTelegramConfig();
    await checkAuthState(); // Bot username could have changed
  } catch (err) {
    showAlertFeedback(alertElements.settingsMessage, 'Failed to save settings.', false);
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
    showAlertFeedback(alertElements.settingsMessage, 'Test alert sent! Check your Telegram.', true);
  } catch (err) {
    showAlertFeedback(alertElements.settingsMessage, `Test failed: ${err.message}`, false);
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

let isAuthenticated = false;
let currentUser = null;

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
    let ruleString = '';
    if (expr && expr.type === 'compound') {
      const logicalConnector = ` ${expr.logicalOperator.toUpperCase()} `;
      ruleString = expr.conditions.map(cond => {
        const left = METRIC_LABELS[cond.field1] || cond.field1;
        const op = { gt: '>', lt: '<', gte: '>=', lte: '<=' }[cond.operator] || cond.operator;
        const right = cond.compareType === 'value' ? formatStaticValue(cond.field1, cond.value) : (METRIC_LABELS[cond.field2] || cond.field2);
        return `${left} ${op} ${right}`;
      }).join(logicalConnector);
    } else if (expr) {
      const leftName = METRIC_LABELS[expr.field1] || expr.field1;
      const rightName = expr.compareType === 'value' ? formatStaticValue(expr.field1, expr.value) : (METRIC_LABELS[expr.field2] || expr.field2);
      const opLabel = { gt: '>', lt: '<', gte: '>=', lte: '<=' }[expr.operator] || expr.operator;
      ruleString = `${leftName} ${opLabel} ${rightName}`;
    }
    const tfString = alert.timeframe || '1m';
    const cooldownString = alert.frequency_minutes > 0 ? `cooldown: ${alert.frequency_minutes}m` : 'no cooldown';

    let trendLabel = '';
    if (alert.trend_mode === 'long') {
      trendLabel = ' <span class="trend-badge long-badge" style="color: #35d083; background: rgba(53, 208, 131, 0.1); padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-left: 6px;">Long Crossover</span>';
    } else if (alert.trend_mode === 'short') {
      trendLabel = ' <span class="trend-badge short-badge" style="color: #ef5e5e; background: rgba(239, 94, 94, 0.1); padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-left: 6px;">Short Crossover</span>';
    }

    if (isAuthenticated) {
      item.innerHTML = `
        <div class="alert-info">
          <span class="alert-title">${alert.name}${trendLabel}</span>
          <span class="alert-rule">${ruleString} (tf: ${tfString}, ${cooldownString})</span>
        </div>
        <div class="alert-actions">
          <label class="switch">
            <input type="checkbox" class="toggle-alert-active" data-id="${alert.id}" ${alert.active ? 'checked' : ''}/>
            <span class="slider"></span>
          </label>
          <button class="edit-alert-btn" data-id="${alert.id}" title="Edit Alert" type="button">✏️</button>
          <button class="delete-alert-btn" data-id="${alert.id}" title="Delete Alert" type="button">×</button>
        </div>
      `;

      item.querySelector('.slider').addEventListener('click', async (e) => {
        e.preventDefault();
        const checkbox = item.querySelector('.toggle-alert-active');
        checkbox.checked = !checkbox.checked;
        await toggleAlertActive(alert.id);
      });

      item.querySelector('.edit-alert-btn').addEventListener('click', () => {
        startEditAlert(alert);
      });

      item.querySelector('.delete-alert-btn').addEventListener('click', async () => {
        if (confirm(`Are you sure you want to delete alert "${alert.name}"?`)) {
          await deleteAlert(alert.id);
        }
      });
    } else {
      // Read-only view
      item.innerHTML = `
        <div class="alert-info">
          <span class="alert-title">${alert.name}${trendLabel}</span>
          <span class="alert-rule">${ruleString} (tf: ${tfString}, ${cooldownString})</span>
        </div>
        <div class="alert-actions">
          <span style="font-size: 11px; color: var(--muted); background: rgba(38,49,55,0.4); padding: 2px 6px; border-radius: 4px;">${alert.active ? 'Active' : 'Inactive'}</span>
        </div>
      `;
    }

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

function startEditAlert(alert) {
  const submitBtn = alertElements.createAlertForm.querySelector('button[type="submit"]');
  alertElements.editAlertId.value = alert.id;
  alertElements.alertNameInput.value = alert.name;

  const container = alertElements.conditionsContainer;
  container.innerHTML = '';

  const expr = alert.expression;
  if (expr && expr.type === 'compound') {
    alertElements.logicalOperatorSelect.value = expr.logicalOperator || 'and';
    expr.conditions.forEach(cond => {
      const row = createConditionRow(cond);
      container.appendChild(row);
    });
  } else if (expr) {
    const row = createConditionRow(expr);
    container.appendChild(row);
  } else {
    const row = createConditionRow();
    container.appendChild(row);
  }

  updateLogicalOperatorVisibility();

  alertElements.trendModeSelect.value = alert.trend_mode || 'none';
  alertElements.alertTimeframeSelect.value = alert.timeframe || '1m';
  alertElements.frequencySelect.value = String(alert.frequency_minutes);

  alertElements.tabCreateAlert.textContent = '✏️ Edit Alert';
  if (submitBtn) submitBtn.textContent = 'Save Changes';

  // Navigate to Create tab
  alertElements.tabCreateAlert.click();
}

function clearEditAlertMode() {
  const submitBtn = alertElements.createAlertForm.querySelector('button[type="submit"]');
  alertElements.editAlertId.value = '';
  alertElements.tabCreateAlert.textContent = 'Create Alert';
  if (submitBtn) submitBtn.textContent = 'Create Alert';
  resetAlertFormToDefault();
}

async function handleCreateAlert(e) {
  e.preventDefault();

  const name = alertElements.alertNameInput.value.trim();
  const trend_mode = alertElements.trendModeSelect.value;
  const timeframe = alertElements.alertTimeframeSelect.value;
  const frequency_minutes = Number(alertElements.frequencySelect.value);
  const editId = alertElements.editAlertId.value;

  const container = alertElements.conditionsContainer;
  const rows = container.querySelectorAll('.condition-row');
  
  if (rows.length === 0) {
    showAlertFeedback(alertElements.formFeedback, 'Please add at least one condition.', false);
    return;
  }

  let expression;

  if (rows.length === 1) {
    const row = rows[0];
    const field1 = row.querySelector('.left-metric-select').value;
    const operator = row.querySelector('.operator-select').value;
    const compareType = row.querySelector('.compare-type-select').value;
    
    expression = {
      field1,
      operator,
      compareType
    };

    if (compareType === 'value') {
      const val = Number(row.querySelector('.target-value-input').value);
      if (isNaN(val)) {
        showAlertFeedback(alertElements.formFeedback, 'Please enter a valid numeric target value.', false);
        return;
      }
      expression.value = val;
    } else {
      expression.field2 = row.querySelector('.right-metric-select').value;
    }
  } else {
    const logicalOperator = alertElements.logicalOperatorSelect.value;
    const conditions = [];

    for (const row of rows) {
      const field1 = row.querySelector('.left-metric-select').value;
      const operator = row.querySelector('.operator-select').value;
      const compareType = row.querySelector('.compare-type-select').value;
      
      const cond = {
        field1,
        operator,
        compareType
      };

      if (compareType === 'value') {
        const val = Number(row.querySelector('.target-value-input').value);
        if (isNaN(val)) {
          showAlertFeedback(alertElements.formFeedback, 'Please enter a valid numeric target value for all conditions.', false);
          return;
        }
        cond.value = val;
      } else {
        cond.field2 = row.querySelector('.right-metric-select').value;
      }
      conditions.push(cond);
    }

    expression = {
      type: 'compound',
      logicalOperator,
      conditions
    };
  }

  try {
    const isEditing = !!editId;
    const url = isEditing ? `/api/alerts/${editId}` : '/api/alerts';
    const method = isEditing ? 'PUT' : 'POST';

    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, expression, frequency_minutes, trend_mode, timeframe })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to save alert.');

    showAlertFeedback(alertElements.formFeedback, isEditing ? 'Alert updated successfully!' : 'Alert created successfully!', true);
    alertElements.createAlertForm.reset();
    clearEditAlertMode();

    // Switch tabs to alerts list
    alertElements.tabActiveAlerts.click();
    await loadAlerts();
  } catch (err) {
    showAlertFeedback(alertElements.formFeedback, err.message, false);
  }
}

async function logoutTelegram() {
  try {
    const res = await fetch('/api/auth/logout', { method: 'POST' });
    if (res.ok) {
      await checkAuthState();
      window.location.reload();
    }
  } catch (err) {
    console.error('Logout failed:', err);
  }
}

async function checkAuthState() {
  try {
    const res = await fetch('/api/auth/telegram/config');
    const data = await res.json();
    const authBar = document.getElementById('authBar');
    const presetSaveBtn = document.getElementById('savePresetBtn');
    const presetDeleteBtn = document.getElementById('deletePresetBtn');
    const alertsTabs = document.getElementById('alertsTabs');
    const toggleSettingsBtn = document.getElementById('toggleSettingsBtn');
    const alertsAuthPlaceholder = document.getElementById('alertsAuthPlaceholder');

    if (data.user) {
      isAuthenticated = true;
      currentUser = data.user;
      if (authBar) {
        authBar.innerHTML = `<span>Logged in as <strong>${data.user.first_name}</strong></span> <button id="logoutBtn" class="logout-btn" type="button">Logout</button>`;
        document.getElementById('logoutBtn').addEventListener('click', logoutTelegram);
      }
      if (presetSaveBtn) {
        presetSaveBtn.disabled = false;
        presetSaveBtn.title = '';
      }
      if (presetDeleteBtn) {
        presetDeleteBtn.disabled = false;
        presetDeleteBtn.title = '';
      }
      if (alertsTabs) alertsTabs.classList.remove('hidden');
      if (toggleSettingsBtn) toggleSettingsBtn.classList.remove('hidden');
      if (alertsAuthPlaceholder) alertsAuthPlaceholder.classList.add('hidden');
    } else {
      isAuthenticated = false;
      currentUser = null;
      if (authBar) {
        authBar.innerHTML = '';
      }
      if (presetSaveBtn) {
        presetSaveBtn.disabled = true;
        presetSaveBtn.title = '🔒 Log in with Telegram to save presets';
      }
      if (presetDeleteBtn) {
        presetDeleteBtn.disabled = true;
        presetDeleteBtn.title = '🔒 Log in with Telegram to delete presets';
      }
      if (alertsTabs) {
        alertsTabs.classList.add('hidden');
        alertElements.tabActiveAlerts.click();
      }
      if (toggleSettingsBtn) {
        toggleSettingsBtn.classList.remove('hidden');
      }
      if (alertsAuthPlaceholder) {
        alertsAuthPlaceholder.classList.remove('hidden');
      }

      const loginContainer = document.getElementById('telegram-login-container');
      if (loginContainer) {
        if (data.botUsername) {
          loginContainer.innerHTML = '';
          const script = document.createElement('script');
          script.async = true;
          script.src = 'https://telegram.org/js/telegram-widget.js?22';
          script.setAttribute('data-telegram-login', data.botUsername);
          script.setAttribute('data-size', 'medium');
          script.setAttribute('data-onauth', 'onTelegramAuth(user)');
          script.setAttribute('data-request-access', 'write');
          loginContainer.appendChild(script);
        } else {
          loginContainer.innerHTML = '<span style="color: var(--red); font-size: 11px;">Telegram Bot token not configured on server. Set token in Settings or env.</span>';
        }
      }
    }
    populatePresetSelectDropdown();
    await loadAlerts();
  } catch (err) {
    console.error('Error checking auth state:', err);
  }
}

// Telegram global auth callback
window.onTelegramAuth = async function(user) {
  try {
    const res = await fetch('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user)
    });
    if (res.ok) {
      await checkAuthState();
      window.location.reload();
    } else {
      const err = await res.json();
      alert(`Login failed: ${err.error || 'Unknown error'}`);
    }
  } catch (err) {
    console.error('Telegram authentication error:', err);
  }
};

function initAlertConfigurator() {
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
    clearEditAlertMode();
  });

  alertElements.tabCreateAlert.addEventListener('click', () => {
    alertElements.tabCreateAlert.classList.add('active');
    alertElements.tabActiveAlerts.classList.remove('active');
    alertElements.tabContentForm.classList.remove('hidden');
    alertElements.tabContentList.classList.add('hidden');
  });

  alertElements.addConditionBtn.addEventListener('click', () => {
    const row = createConditionRow();
    alertElements.conditionsContainer.appendChild(row);
    updateLogicalOperatorVisibility();
  });

  alertElements.createAlertForm.addEventListener('submit', handleCreateAlert);

  resetAlertFormToDefault();
  checkAuthState().catch(console.error);
}

// Startup Execution
function startup() {
  initPriceChart();
  initTwapChart();
  populatePresetSelectDropdown();
  initAlertConfigurator();
  
  refreshChart().catch(console.error);
  setInterval(() => refreshChart().catch(console.error), 5000);
}

// Run startup
startup();

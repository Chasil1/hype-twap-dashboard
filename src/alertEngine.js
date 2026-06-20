import { aggregateSnapshots } from './aggregateSnapshots.js';

export class AlertEngine {
  constructor({ alertsStore, configStore }) {
    this.alertsStore = alertsStore;
    this.configStore = configStore;
  }

  async getTelegramConfig() {
    let token = await this.configStore.get('telegram_bot_token');
    let chatId = await this.configStore.get('telegram_chat_id');

    // Fallback to environment variables
    if (!token) token = process.env.TELEGRAM_BOT_TOKEN;
    if (!chatId) chatId = process.env.TELEGRAM_CHAT_ID;

    return {
      token: token ? token.trim() : null,
      chatId: chatId ? chatId.trim() : null
    };
  }

  async checkAlerts(snapshotsInput, legacyPrevInput) {
    try {
      const { token, chatId: globalChatId } = await this.getTelegramConfig();
      if (!token) {
        return; // Telegram bot token not configured, silent return
      }

      let snapshots = [];
      if (Array.isArray(snapshotsInput)) {
        snapshots = snapshotsInput;
      } else if (snapshotsInput) {
        // Legacy compatibility: wrap single snapshot
        snapshots = legacyPrevInput ? [legacyPrevInput, snapshotsInput] : [snapshotsInput];
      }

      if (snapshots.length === 0) return;

      const alerts = await this.alertsStore.readAll();
      const activeAlerts = alerts.filter(a => a.active);

      for (const alert of activeAlerts) {
        try {
          const timeframe = alert.timeframe || '1m';
          const buckets = aggregateSnapshots(snapshots, timeframe);
          const currentBucket = buckets.at(-1);
          if (!currentBucket) continue;

          const previousBucket = buckets.at(-2) || null;

          const isTriggered = this.evaluate(currentBucket, alert.expression);
          if (!isTriggered) continue;

          const targetChatId = alert.telegram_user_id || globalChatId;
          if (!targetChatId) continue;

          const trendMode = alert.trend_mode || 'none';

          if (trendMode === 'long' || trendMode === 'short') {
            // Check crossover condition: must have been false in the previous bucket
            const wasTriggeredPrev = previousBucket ? this.evaluate(previousBucket, alert.expression) : false;

            if (wasTriggeredPrev) {
              // Not a crossover transition from false to true, so skip
              continue;
            }

            // Prevent multiple crossover triggers within the same timeframe bucket/candle
            if (alert.last_crossover_bucket_timestamp === currentBucket.timestamp) {
              continue;
            }

            // A crossover has occurred! Now verify the price direction
            const currentPrice = currentBucket.price;
            if (currentPrice === null || currentPrice === undefined) {
              continue;
            }

            const lastCrossoverPrice = alert.last_crossover_price;
            let shouldSkipAlert = false;

            if (trendMode === 'long') {
              if (lastCrossoverPrice !== null && lastCrossoverPrice !== undefined && currentPrice <= lastCrossoverPrice) {
                shouldSkipAlert = true;
              }
            } else if (trendMode === 'short') {
              if (lastCrossoverPrice !== null && lastCrossoverPrice !== undefined && currentPrice >= lastCrossoverPrice) {
                shouldSkipAlert = true;
              }
            }

            alert.last_crossover_bucket_timestamp = currentBucket.timestamp;
            alert.last_crossover_price = currentPrice;

            if (shouldSkipAlert) {
              // Save the new crossover threshold but skip sending notifications
              await this.alertsStore.save(alert);
              continue;
            }

            // Crossover price matches direction criteria (or baseline case). Trigger the alert!
            const now = Date.now();
            const lastTriggered = alert.last_triggered_at ? new Date(alert.last_triggered_at).getTime() : 0;
            const cooldownMs = (alert.frequency_minutes || 0) * 60 * 1000;

            if (now - lastTriggered >= cooldownMs) {
              await this.sendTelegramNotification(token, targetChatId, alert, currentBucket);
              alert.last_triggered_at = new Date(now).toISOString();
            }

            await this.alertsStore.save(alert);

          } else {
            // Standard (Static Threshold Alert)
            const now = Date.now();
            const lastTriggered = alert.last_triggered_at ? new Date(alert.last_triggered_at).getTime() : 0;
            const cooldownMs = (alert.frequency_minutes || 0) * 60 * 1000;

            if (now - lastTriggered >= cooldownMs) {
              await this.sendTelegramNotification(token, targetChatId, alert, currentBucket);

              alert.last_triggered_at = new Date(now).toISOString();
              await this.alertsStore.save(alert);
            }
          }
        } catch (err) {
          console.error(`Error checking alert "${alert.name}":`, err);
        }
      }
    } catch (err) {
      console.error('Error running checkAlerts loop:', err);
    }
  }

  evaluate(snapshot, expr) {
    if (!expr) return false;

    if (expr.type === 'compound') {
      const conditions = expr.conditions || [];
      if (conditions.length === 0) return false;

      if (expr.logicalOperator === 'or') {
        return conditions.some(cond => this.evaluate(snapshot, cond));
      } else {
        return conditions.every(cond => this.evaluate(snapshot, cond));
      }
    }

    if (!expr.field1 || !expr.operator) return false;

    const v1 = snapshot[expr.field1];
    if (v1 === null || v1 === undefined) return false;

    let v2;
    if (expr.compareType === 'value') {
      v2 = expr.value;
    } else {
      v2 = snapshot[expr.field2];
    }
    if (v2 === null || v2 === undefined) return false;

    const num1 = Number(v1);
    const num2 = Number(v2);

    if (!Number.isFinite(num1) || !Number.isFinite(num2)) return false;

    switch (expr.operator) {
      case 'gt': return num1 > num2;
      case 'lt': return num1 < num2;
      case 'gte': return num1 >= num2;
      case 'lte': return num1 <= num2;
      default: return false;
    }
  }

  async sendTelegramNotification(token, chatId, alert, snapshot) {
    const message = this.formatAlertMessage(alert, snapshot);
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML'
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Telegram server replied: ${response.status} - ${errText}`);
      }
      console.log(`Telegram alert successfully sent: "${alert.name}"`);
    } catch (error) {
      console.error(`Failed to dispatch Telegram message for alert "${alert.name}":`, error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  formatAlertMessage(alert, snapshot) {
    const expr = alert.expression;
    const metricLabels = getMetricLabelsMap();

    let conditionText = '';
    let stateText = '';

    if (expr && expr.type === 'compound') {
      const logicalOp = (expr.logicalOperator || 'and').toUpperCase();
      const conditions = expr.conditions || [];
      
      conditionText = conditions.map((cond) => {
        const leftName = escapeHTML(metricLabels[cond.field1] || cond.field1);
        const opSymbol = escapeHTML({ gt: '>', lt: '<', gte: '>=', lte: '<=' }[cond.operator] || cond.operator);
        let rightVal;
        if (cond.compareType === 'value') {
          rightVal = escapeHTML(formatMetricValue(cond.field1, cond.value));
        } else {
          rightVal = escapeHTML(metricLabels[cond.field2] || cond.field2);
        }
        return `(${leftName} ${opSymbol} ${rightVal})`;
      }).join(` <b>${escapeHTML(logicalOp)}</b> `);

      stateText = '<b>Current State:</b>\n';
      conditions.forEach((cond) => {
        const leftName = escapeHTML(metricLabels[cond.field1] || cond.field1);
        const val1 = snapshot[cond.field1];
        const formattedVal1 = escapeHTML(formatMetricValue(cond.field1, val1));
        
        stateText += `• ${leftName}: <code>${formattedVal1}</code>`;
        if (cond.compareType === 'metric') {
          const rightName = escapeHTML(metricLabels[cond.field2] || cond.field2);
          const val2 = snapshot[cond.field2];
          const formattedVal2 = escapeHTML(formatMetricValue(cond.field2, val2));
          stateText += ` (vs ${rightName}: <code>${formattedVal2}</code>)`;
        } else {
          const formattedVal2 = escapeHTML(formatMetricValue(cond.field1, cond.value));
          stateText += ` (target: <code>${formattedVal2}</code>)`;
        }
        stateText += '\n';
      });
    } else if (expr) {
      const v1 = snapshot[expr.field1];
      let v2 = expr.compareType === 'value' ? expr.value : snapshot[expr.field2];

      const name1 = escapeHTML(metricLabels[expr.field1] || expr.field1);
      const name2 = expr.compareType === 'value' ? escapeHTML(formatMetricValue(expr.field1, v2)) : escapeHTML(metricLabels[expr.field2] || expr.field2);

      const formattedV1 = escapeHTML(formatMetricValue(expr.field1, v1));
      const formattedV2 = expr.compareType === 'value' ? name2 : escapeHTML(formatMetricValue(expr.field2, v2));

      const opSymbol = escapeHTML({ gt: '>', lt: '<', gte: '>=', lte: '<=' }[expr.operator] || expr.operator);

      conditionText = `${name1} ${opSymbol} ${expr.compareType === 'value' ? formattedV2 : name2}`;
      stateText = `<b>Current State:</b>\n` +
                  `• ${name1}: <code>${formattedV1}</code>\n` +
                  (expr.compareType === 'metric' ? `• ${name2}: <code>${formattedV2}</code>\n` : '');
    }

    let modeText = '';
    if (alert.trend_mode === 'long') {
      modeText = `📈 <b>Long Crossover Mode</b>\n(Triggered because HYPE price <code>$${snapshot.price?.toFixed(4)}</code> > last crossover price <code>$${alert.last_crossover_price?.toFixed(4) || 'none'}</code>)\n\n`;
    } else if (alert.trend_mode === 'short') {
      modeText = `📉 <b>Short Crossover Mode</b>\n(Triggered because HYPE price <code>$${snapshot.price?.toFixed(4)}</code> < last crossover price <code>$${alert.last_crossover_price?.toFixed(4) || 'none'}</code>)\n\n`;
    }

    return `🚨 <b>ALERT TRIGGERED: ${escapeHTML(alert.name)}</b>\n\n` +
           `<b>Timeframe:</b> <code>${escapeHTML(alert.timeframe || '1m')}</code>\n` +
           modeText +
           `<b>Condition:</b> ${conditionText}\n` +
           stateText +
           `\n` +
           `<b>Price:</b> $${snapshot.price?.toFixed(4) || '--'}\n` +
           `<b>Timestamp:</b> ${new Date(snapshot.timestamp).toLocaleString()}`;
  }
}

function escapeHTML(text) {
  if (typeof text !== 'string') return String(text ?? '');
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatMetricValue(field, val) {
  if (val === null || val === undefined || !Number.isFinite(val)) return '--';

  if (field === 'price') {
    return `$${val.toFixed(4)}`;
  }

  if (field.startsWith('hl_') || field.startsWith('bybit_') || field.startsWith('twap') || field.startsWith('diff_')) {
    if (Math.abs(val) >= 1_000_000) {
      return `$${(val / 1_000_000).toFixed(2)}M`;
    }
    if (Math.abs(val) >= 1_000) {
      return `$${(val / 1_000).toFixed(1)}k`;
    }
    return `$${val.toFixed(2)}`;
  }

  return String(val);
}

function getMetricLabelsMap() {
  const map = {
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
    map[`hl_bid_${suffix}`] = `HL Bid ${d}%`;
    map[`hl_ask_${suffix}`] = `HL Ask ${d}%`;
    map[`bybit_bid_${suffix}`] = `Bybit Bid ${d}%`;
    map[`bybit_ask_${suffix}`] = `Bybit Ask ${d}%`;
  });

  const customDiffKeys = {
    diff_3B_8A: 'DIFF 3B-8A',
    diff_8B_3A: 'DIFF 8B-3A',
    diff_8A_3B: 'DIFF 8A-3B',
    diff_8B_30A: 'DIFF 8B-30A',
    diff_5B_15A: 'DIFF 5B-15A',
    diff_15B_5A: 'DIFF 15B-5A',
    diff_8B_15A: 'DIFF 8B-15A',
    diff_15B_8A: 'DIFF 15B-8A',
    diff_15B_30A: 'DIFF 15B-30A',
    diff_30B_15A: 'DIFF 30B-15A',
    diff_30_15: 'DIFF 30-15',
    diff_30_8: 'DIFF 30-8',
    diff_15_8: 'DIFF 15-8',
    diff_8_5: 'DIFF 8-5'
  };
  Object.assign(map, customDiffKeys);

  return map;
}

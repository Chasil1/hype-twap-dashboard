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

  async checkAlerts(snapshot, previousSnapshot) {
    try {
      const { token, chatId } = await this.getTelegramConfig();
      if (!token || !chatId) {
        return; // Telegram bot not fully configured, silent return
      }

      const alerts = await this.alertsStore.readAll();
      const activeAlerts = alerts.filter(a => a.active);

      for (const alert of activeAlerts) {
        try {
          const isTriggered = this.evaluate(snapshot, alert.expression);
          if (!isTriggered) continue;

          const trendMode = alert.trend_mode || 'none';

          if (trendMode === 'long' || trendMode === 'short') {
            // Check crossover condition: must have been false in the previous snapshot
            const wasTriggeredPrev = previousSnapshot ? this.evaluate(previousSnapshot, alert.expression) : false;

            if (wasTriggeredPrev) {
              // Not a crossover transition from false to true, so skip
              continue;
            }

            // A crossover has occurred! Now verify the price direction
            const currentPrice = snapshot.price;
            if (currentPrice === null || currentPrice === undefined) {
              continue;
            }

            const lastCrossoverPrice = alert.last_crossover_price;

            if (trendMode === 'long') {
              if (lastCrossoverPrice !== null && lastCrossoverPrice !== undefined && currentPrice <= lastCrossoverPrice) {
                // Current crossover price is NOT higher than the last crossover price, update price but skip alert
                alert.last_crossover_price = currentPrice;
                await this.alertsStore.save(alert);
                continue;
              }
            } else if (trendMode === 'short') {
              if (lastCrossoverPrice !== null && lastCrossoverPrice !== undefined && currentPrice >= lastCrossoverPrice) {
                // Current crossover price is NOT lower than the last crossover price, update price but skip alert
                alert.last_crossover_price = currentPrice;
                await this.alertsStore.save(alert);
                continue;
              }
            }

            // Crossover price matches direction criteria (or baseline case). Trigger the alert!
            const now = Date.now();
            const lastTriggered = alert.last_triggered_at ? new Date(alert.last_triggered_at).getTime() : 0;
            const cooldownMs = (alert.frequency_minutes || 0) * 60 * 1000;

            if (now - lastTriggered >= cooldownMs) {
              await this.sendTelegramNotification(token, chatId, alert, snapshot);
              alert.last_triggered_at = new Date(now).toISOString();
            }

            alert.last_crossover_price = currentPrice;
            await this.alertsStore.save(alert);

          } else {
            // Standard (Static Threshold Alert)
            const now = Date.now();
            const lastTriggered = alert.last_triggered_at ? new Date(alert.last_triggered_at).getTime() : 0;
            const cooldownMs = (alert.frequency_minutes || 0) * 60 * 1000;

            if (now - lastTriggered >= cooldownMs) {
              await this.sendTelegramNotification(token, chatId, alert, snapshot);

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
    if (!expr || !expr.field1 || !expr.operator) return false;

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
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Telegram server replied: ${response.status} - ${errText}`);
      }
      console.log(`Telegram alert successfully sent: "${alert.name}"`);
    } catch (error) {
      console.error(`Failed to dispatch Telegram message for alert "${alert.name}":`, error);
    }
  }

  formatAlertMessage(alert, snapshot) {
    const expr = alert.expression;
    const v1 = snapshot[expr.field1];
    let v2;
    if (expr.compareType === 'value') {
      v2 = expr.value;
    } else {
      v2 = snapshot[expr.field2];
    }

    const metricLabels = getMetricLabelsMap();
    const name1 = metricLabels[expr.field1] || expr.field1;
    const name2 = expr.compareType === 'value' ? formatMetricValue(expr.field1, v2) : (metricLabels[expr.field2] || expr.field2);

    const formattedV1 = formatMetricValue(expr.field1, v1);
    const formattedV2 = expr.compareType === 'value' ? name2 : formatMetricValue(expr.field2, v2);

    const opSymbol = { gt: '>', lt: '<', gte: '>=', lte: '<=' }[expr.operator] || expr.operator;

    let modeText = '';
    if (alert.trend_mode === 'long') {
      modeText = `📈 <b>Long Crossover Mode</b>\n(Triggered because HYPE price <code>$${snapshot.price?.toFixed(4)}</code> > last crossover price <code>$${alert.last_crossover_price?.toFixed(4) || 'none'}</code>)\n\n`;
    } else if (alert.trend_mode === 'short') {
      modeText = `📉 <b>Short Crossover Mode</b>\n(Triggered because HYPE price <code>$${snapshot.price?.toFixed(4)}</code> < last crossover price <code>$${alert.last_crossover_price?.toFixed(4) || 'none'}</code>)\n\n`;
    }

    return `🚨 <b>ALERT TRIGGERED: ${alert.name}</b>\n\n` +
           modeText +
           `<b>Condition:</b> ${name1} ${opSymbol} ${expr.compareType === 'value' ? formattedV2 : name2}\n` +
           `<b>Current State:</b>\n` +
           `• ${name1}: <code>${formattedV1}</code>\n` +
           (expr.compareType === 'metric' ? `• ${name2}: <code>${formattedV2}</code>\n` : '') +
           `\n` +
           `<b>Price:</b> $${snapshot.price?.toFixed(4) || '--'}\n` +
           `<b>Timestamp:</b> ${new Date(snapshot.timestamp).toLocaleString()}`;
  }
}

function formatMetricValue(field, val) {
  if (val === null || val === undefined || !Number.isFinite(val)) return '--';

  if (field === 'price') {
    return `$${val.toFixed(4)}`;
  }

  if (field.startsWith('hl_') || field.startsWith('bybit_') || field.startsWith('twap')) {
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

  return map;
}

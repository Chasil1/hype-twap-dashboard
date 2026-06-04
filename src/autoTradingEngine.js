import crypto from 'node:crypto';

export class AutoTradingEngine {
  constructor({ autoTradeStore, configStore }) {
    this.autoTradeStore = autoTradeStore;
    this.configStore = configStore;
    this.lastCheckedTimestamp = null;
  }

  async update(snapshots, alertsList, alertEngineInstance) {
    const config = await this.autoTradeStore.getConfig();
    if (!config || !config.enabled || !config.alertId) {
      return;
    }

    const latestSnapshot = snapshots.at(-1);
    if (!latestSnapshot) return;

    // Prevent running multiple times for the exact same snapshot timestamp
    if (this.lastCheckedTimestamp === latestSnapshot.timestamp) {
      return;
    }
    this.lastCheckedTimestamp = latestSnapshot.timestamp;

    const prevSnapshot = snapshots.length > 1 ? snapshots.at(-2) : null;
    const state = await this.autoTradeStore.getState();

    // Ensure state collections are initialized
    state.activePositions = state.activePositions || [];
    state.logs = state.logs || [];
    state.tradeHistory = state.tradeHistory || [];

    const logMsg = (text) => {
      const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const fullText = `[${timeStr}] ${text}`;
      console.log(`[AutoTradingBot] ${fullText}`);
      state.logs.unshift(fullText);
      if (state.logs.length > 200) {
        state.logs = state.logs.slice(0, 200);
      }
      this.sendTelegramMessage(text).catch(err => console.error('Telegram autotrade send failed:', err));
    };

    const alert = alertsList.find(a => a.id === config.alertId);
    if (!alert) {
      // Configured alert no longer exists
      return;
    }

    // 1. Evaluate Trigger Crossover
    const isTriggered = alertEngineInstance.evaluate(latestSnapshot, alert.expression);
    let triggerOccurred = false;
    let crossoverDirection = 'long';

    if (isTriggered && prevSnapshot) {
      const directionOverride = config.direction || 'auto';
      const trendMode = (directionOverride !== 'auto') ? directionOverride : (alert.trend_mode || 'none');
      crossoverDirection = trendMode === 'short' ? 'short' : 'long';

      if (trendMode === 'long' || trendMode === 'short') {
        const wasTriggeredPrev = alertEngineInstance.evaluate(prevSnapshot, alert.expression);
        if (!wasTriggeredPrev) {
          const lastCrossoverPrice = alert.last_crossover_price;
          const currentPrice = latestSnapshot.price;

          if (trendMode === 'long') {
            if (lastCrossoverPrice === null || lastCrossoverPrice === undefined || currentPrice > lastCrossoverPrice) {
              triggerOccurred = true;
            }
          } else if (trendMode === 'short') {
            if (lastCrossoverPrice === null || lastCrossoverPrice === undefined || currentPrice < lastCrossoverPrice) {
              triggerOccurred = true;
            }
          }
        }
      } else {
        triggerOccurred = true;
      }
    }

    // 2. Open New Position if Crossover Occurs
    if (triggerOccurred) {
      const hasActive = state.activePositions.some(p => p.alertId === alert.id && p.status === 'active');
      if (!hasActive) {
        const triggerPrice = latestSnapshot.price;
        const cooldownMinutes = Number(alert.frequency_minutes || 0);
        const cooldownMs = cooldownMinutes * 60_000;
        
        let onCooldown = false;
        if (state.tradeHistory.length > 0) {
          const lastTrade = state.tradeHistory[0];
          const lastTime = new Date(lastTrade.timestamp).getTime();
          const currTime = new Date(latestSnapshot.timestamp).getTime();
          if (currTime - lastTime < cooldownMs) {
            onCooldown = true;
          }
        }

        if (!onCooldown) {
          // Open position
          const positionId = crypto.randomUUID();
          
          // Generate order grid
          const count = Number(config.orderCount || 3);
          const limitOrders = [];
          
          for (let index = 1; index <= count; index++) {
            const legOffset = parseFloat(config[`legOffset${index}`] ?? (index === 1 ? -0.3 : index === 2 ? -1.0 : -2.0));
            const legAmount = parseFloat(config[`legAmount${index}`] ?? (index === 1 ? 10 : index === 2 ? 20 : 30));
            
            let finalAmount = legAmount;
            if (config.tradeAmount) {
              finalAmount = parseFloat(config.tradeAmount) / count;
            }
            
            const limitPrice = triggerPrice * (1 + legOffset / 100);
            const qty = finalAmount / limitPrice;
            
            limitOrders.push({
              index,
              limitPrice,
              amount: finalAmount,
              qty,
              filled: false,
              filledAt: null
            });
          }

          const newPosition = {
            id: positionId,
            alertId: alert.id,
            alertName: alert.name,
            timestamp: latestSnapshot.timestamp,
            triggerPrice,
            direction: crossoverDirection,
            qty: 0,
            avgPrice: 0,
            filledPositions: [],
            limitOrders,
            status: 'active',
            exchange: config.exchange || 'hl'
          };

          state.activePositions.push(newPosition);
          logMsg(`🤖 [OPEN] Live order grid initialized on crossover! Exchange: ${newPosition.exchange.toUpperCase()}, Direction: ${crossoverDirection.toUpperCase()}, Trigger Price: $${triggerPrice.toFixed(4)}`);
        }
      }
    }

    // 3. Update Existing Active Positions
    const activePositions = state.activePositions.filter(p => p.status === 'active');
    for (const pos of activePositions) {
      let stateChanged = false;
      const triggerPrice = pos.triggerPrice;
      const isShort = (pos.direction === 'short');
      
      const sLow = Number.isFinite(latestSnapshot.low) ? latestSnapshot.low : latestSnapshot.price;
      const sHigh = Number.isFinite(latestSnapshot.high) ? latestSnapshot.high : latestSnapshot.price;
      const currentPrice = latestSnapshot.price;

      // check limit orders
      for (const order of pos.limitOrders) {
        if (!order.filled) {
          let isFilled = false;
          if (isShort) {
            if (sHigh >= order.limitPrice) isFilled = true;
          } else {
            if (sLow <= order.limitPrice) isFilled = true;
          }

          if (isFilled) {
            order.filled = true;
            order.filledAt = latestSnapshot.timestamp;
            pos.filledPositions.push(order);
            
            // Recalculate avgPrice and qty
            let totalQty = 0;
            let totalCost = 0;
            pos.filledPositions.forEach(fp => {
              totalQty += fp.qty;
              totalCost += fp.qty * fp.limitPrice;
            });
            pos.qty = totalQty;
            pos.avgPrice = totalCost / totalQty;
            stateChanged = true;
            
            logMsg(`🤖 [FILL] Grid leg ${order.index} order filled at limit $${order.limitPrice.toFixed(4)}. Position Size: ${pos.qty.toFixed(4)}, Avg Price: $${pos.avgPrice.toFixed(4)}`);
          }
        }
      }

      if (pos.filledPositions.length > 0) {
        // Exits logic
        const tpPercent = parseFloat(config.tpPercent || 1.5);
        const slPercent = parseFloat(config.slPercent || 2.0);
        const tpAnchor = config.tpAnchor || 'avg';
        
        let tpAnchorPrice = pos.avgPrice;
        if (tpAnchor === 'order1' && pos.limitOrders[0]?.filled) tpAnchorPrice = pos.limitOrders[0].limitPrice;
        if (tpAnchor === 'order2' && pos.limitOrders[1]?.filled) tpAnchorPrice = pos.limitOrders[1].limitPrice;
        if (tpAnchor === 'order3' && pos.limitOrders[2]?.filled) tpAnchorPrice = pos.limitOrders[2].limitPrice;

        const tpPrice = isShort 
          ? tpAnchorPrice * (1 - tpPercent / 100) 
          : tpAnchorPrice * (1 + tpPercent / 100);
          
        const slPrice = isShort 
          ? pos.avgPrice * (1 + slPercent / 100) 
          : pos.avgPrice * (1 - slPercent / 100);

        let exitTriggered = false;
        let exitPrice = currentPrice;
        let exitReason = '';

        // Check TP Percent
        if (config.tpMode === 'percent') {
          if (isShort) {
            if (sLow <= tpPrice) {
              exitTriggered = true;
              exitPrice = tpPrice;
              exitReason = 'Take Profit Percent Hit';
            }
          } else {
            if (sHigh >= tpPrice) {
              exitTriggered = true;
              exitPrice = tpPrice;
              exitReason = 'Take Profit Percent Hit';
            }
          }
        }

        // Check SL Percent
        if (!exitTriggered && config.slMode === 'percent') {
          if (isShort) {
            if (sHigh >= slPrice) {
              exitTriggered = true;
              exitPrice = slPrice;
              exitReason = 'Stop Loss Percent Hit';
            }
          } else {
            if (sLow <= slPrice) {
              exitTriggered = true;
              exitPrice = slPrice;
              exitReason = 'Stop Loss Percent Hit';
            }
          }
        }

        // Check Metric crossover exits
        if (!exitTriggered) {
          if (config.tpMode === 'metric') {
            const exitAlertId = config.tpCloseSelect || 'same';
            let triggeredExit = false;
            if (exitAlertId === 'same') {
              triggeredExit = isTriggered;
            } else if (exitAlertId === 'custom' && config.tpCustomExpr) {
              triggeredExit = alertEngineInstance.evaluate(latestSnapshot, config.tpCustomExpr);
            } else {
              const ea = alertsList.find(a => a.id === exitAlertId);
              if (ea) triggeredExit = alertEngineInstance.evaluate(latestSnapshot, ea.expression);
            }

            if (triggeredExit) {
              exitTriggered = true;
              exitPrice = currentPrice;
              exitReason = 'Take Profit Metric Exit';
            }
          }
        }

        if (!exitTriggered && config.slMode === 'metric') {
          const exitAlertId = config.slCloseSelect || 'same';
          let triggeredExit = false;
          if (exitAlertId === 'same') {
            triggeredExit = isTriggered;
          } else if (exitAlertId === 'custom' && config.slCustomExpr) {
            triggeredExit = alertEngineInstance.evaluate(latestSnapshot, config.slCustomExpr);
          } else {
            const ea = alertsList.find(a => a.id === exitAlertId);
            if (ea) triggeredExit = alertEngineInstance.evaluate(latestSnapshot, ea.expression);
          }

          if (triggeredExit) {
            exitTriggered = true;
            exitPrice = currentPrice;
            exitReason = 'Stop Loss Metric Exit';
          }
        }

        if (exitTriggered) {
          // Close position
          const profit = isShort 
            ? pos.qty * (pos.avgPrice - exitPrice)
            : pos.qty * (exitPrice - pos.avgPrice);
          
          pos.status = 'closed';
          pos.exitPrice = exitPrice;
          pos.exitTimestamp = latestSnapshot.timestamp;
          pos.profit = profit;
          pos.exitReason = exitReason;

          state.tradeHistory.unshift(pos);
          if (state.tradeHistory.length > 100) {
            state.tradeHistory = state.tradeHistory.slice(0, 100);
          }

          state.activePositions = state.activePositions.filter(p => p.id !== pos.id);
          logMsg(`🤖 [CLOSED] Live position closed by ${exitReason.toUpperCase()} at price $${exitPrice.toFixed(4)}. Realized PnL: $${profit.toFixed(2)}`);
          stateChanged = true;
        }
      } else {
        // No filled orders yet. Check TP cancel threshold
        const tpPercent = parseFloat(config.tpPercent || 1.5);
        const cancelPrice = isShort 
          ? triggerPrice * (1 - tpPercent / 100)
          : triggerPrice * (1 + tpPercent / 100);

        let cancelTriggered = false;
        if (isShort) {
          if (sLow <= cancelPrice) cancelTriggered = true;
        } else {
          if (sHigh >= cancelPrice) cancelTriggered = true;
        }

        if (cancelTriggered) {
          pos.status = 'canceled';
          state.activePositions = state.activePositions.filter(p => p.id !== pos.id);
          logMsg(`🤖 [CANCEL] Grid canceled without fills. Price reached TP threshold before any order was filled.`);
          stateChanged = true;
        }
      }
    }

    await this.autoTradeStore.saveState(state);
  }

  async closePosition(positionId, closePrice) {
    const state = await this.autoTradeStore.getState();
    const posIndex = state.activePositions.findIndex(p => p.id === positionId && p.status === 'active');
    if (posIndex === -1) return false;

    const pos = state.activePositions[posIndex];
    const isShort = (pos.direction === 'short');
    const actualPrice = Number.isFinite(closePrice) ? closePrice : pos.triggerPrice;
    
    const profit = isShort 
      ? pos.qty * (pos.avgPrice - actualPrice)
      : pos.qty * (actualPrice - pos.avgPrice);

    pos.status = 'closed';
    pos.exitPrice = actualPrice;
    pos.exitTimestamp = new Date().toISOString();
    pos.profit = profit;
    pos.exitReason = 'Manual Close';

    state.tradeHistory.unshift(pos);
    state.activePositions.splice(posIndex, 1);

    const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const fullText = `[${timeStr}] 🤖 [MANUAL CLOSE] Live position force-closed manually at $${actualPrice.toFixed(4)}. Realized PnL: $${profit.toFixed(2)}`;
    state.logs.unshift(fullText);

    await this.autoTradeStore.saveState(state);
    this.sendTelegramMessage(fullText).catch(err => console.error('Telegram autotrade send failed:', err));
    return true;
  }

  async sendTelegramMessage(text) {
    try {
      let token = await this.configStore.get('telegram_bot_token');
      if (!token) token = process.env.TELEGRAM_BOT_TOKEN;
      let chatId = await this.configStore.get('telegram_chat_id');
      if (!chatId) chatId = process.env.TELEGRAM_CHAT_ID;

      if (!token || !chatId) return;

      const url = `https://api.telegram.org/bot${token.trim()}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId.trim(),
          text,
          parse_mode: 'HTML'
        })
      });
    } catch (err) {
      console.error('Error sending telegram message from autotrade bot:', err);
    }
  }
}

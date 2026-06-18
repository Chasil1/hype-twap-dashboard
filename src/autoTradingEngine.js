import crypto from 'node:crypto';
import { Nord, NordUser, Side, FillMode } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
import { createNordUserHelper } from "./nordHelper.js";
import { HibachiCcxtAdapter } from "./hibachiCcxtAdapter.js";

export function resolveStrategyCredentials(strategy, wallets = []) {
  if (!strategy) return null;
  const clone = { ...strategy };
  if (strategy.walletId) {
    const wallet = wallets.find(w => w.id === strategy.walletId);
    if (wallet) {
      clone.wallet = wallet.address || wallet.walletAddress || '';
      clone.privateKey = wallet.privateKey || '';
      clone.apiKey = wallet.apiKey || '';
      clone.apiSecret = wallet.apiSecret || '';
      clone.accountId = wallet.accountId || '';
    }
  }
  return clone;
}

async function get01User(config) {
  const isTestnet = !!config.testnet;
  const solanaUrl = isTestnet ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com';
  const webServerUrl = isTestnet ? 'https://zo-devnet.n1.xyz' : 'https://zo-mainnet.n1.xyz';
  const appKey = 'zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5';

  const connection = new Connection(solanaUrl);
  const nord = await Nord.new({
    app: appKey,
    solanaConnection: connection,
    webServerUrl,
  });

  const user = await createNordUserHelper(nord, config.wallet, config.privateKey);
  
  await user.updateAccountId();
  await user.refreshSession();
  await user.fetchInfo();
  return { nord, user };
}

async function close01Position(pos, config, logMsg) {
  try {
    const isTestnet = !!config.testnet;
    const solanaUrl = isTestnet ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com';
    const webServerUrl = isTestnet ? 'https://zo-devnet.n1.xyz' : 'https://zo-mainnet.n1.xyz';
    const appKey = 'zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5';

    const connection = new Connection(solanaUrl);
    const nord = await Nord.new({
      app: appKey,
      solanaConnection: connection,
      webServerUrl,
    });

    const user = await createNordUserHelper(nord, config.wallet, config.privateKey);
    
    await user.updateAccountId();
    await user.refreshSession();
    await user.fetchInfo();

    const subaccountIndex = parseInt(pos.subaccountIndex ?? config.subaccountIndex ?? 0, 10);
    const accountId = user.accountIds[subaccountIndex] || user.accountIds[0];
    if (!accountId) {
      throw new Error('No subaccount ID resolved for 01 Exchange.');
    }

    // 1. Cancel open limit orders
    const openOrders = user.orders[accountId] || [];
    for (const order of pos.limitOrders) {
      if (!order.filled && order.orderId) {
        const isOpen = openOrders.some(o => o.orderId.toString() === order.orderId.toString());
        if (isOpen) {
          try {
            await user.cancelOrder(BigInt(order.orderId), accountId);
            logMsg(`🤖 [CANCEL] Canceled open limit order ${order.orderId} on 01 Exchange before closing.`);
          } catch (e) {
            console.error(`Failed to cancel order ${order.orderId}:`, e.message);
          }
        }
      }
    }

    // 2. Place market close order
    if (pos.qty > 0) {
      const info = await nord.getInfo();
      const market = info.markets.find(m => m.symbol === 'HYPEUSD');
      if (!market) throw new Error('HYPEUSD market not found');
      
      const side = pos.direction === 'long' ? Side.Ask : Side.Bid; // opposite side
      const size = parseFloat(pos.qty.toFixed(market.sizeDecimals));

      logMsg(`🤖 [EXITING] Placing market order to close position of size ${size} on 01 Exchange (subaccount index: ${subaccountIndex}).`);
      const closeResult = await user.placeOrder({
        marketId: market.marketId,
        side,
        fillMode: FillMode.FillOrKill, // FOK is standard for market order on 01 Exchange
        isReduceOnly: true,
        size,
        accountId
      });
      logMsg(`🤖 [EXITED] Market order placed on 01 Exchange. Action ID: ${closeResult.actionId}`);
    }
  } catch (err) {
    console.error('Error closing 01 Exchange position:', err);
    const detailedMessage = err.cause ? `${err.message} (Cause: ${err.cause.message})` : err.message;
    logMsg(`⚠️ [ERROR] Failed to close position on 01 Exchange: ${detailedMessage}`);
  }
}

export class AutoTradingEngine {
  constructor({ autoTradeStore, configStore, hibachiAdapter = new HibachiCcxtAdapter() }) {
    this.autoTradeStore = autoTradeStore;
    this.configStore = configStore;
    this.hibachiAdapter = hibachiAdapter;
    this.lastCheckedTimestamp = null;
    this.cachedUser = null;
    this.cachedUserConfigHash = null;
  }

  async getCachedUser(config) {
    const configHash = `${config.exchange}-${config.testnet}-${config.privateKey}`;
    if (this.cachedUser && this.cachedUserConfigHash === configHash) {
      try {
        await this.cachedUser.fetchInfo();
        return this.cachedUser;
      } catch (e) {
        console.warn('Cached user fetchInfo failed, reinitializing...', e.message);
        this.cachedUser = null;
      }
    }
    
    const { user } = await get01User(config);
    this.cachedUser = user;
    this.cachedUserConfigHash = configHash;
    return user;
  }

  async update(snapshots, alertsList, alertEngineInstance) {
    const config = await this.autoTradeStore.getConfig();
    if (!config || !config.strategies || config.strategies.length === 0) {
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

    let stateChanged = false;

    const logMsgForStrategy = (strategyName, text) => {
      const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const fullText = `[${timeStr}] [${strategyName}] ${text}`;
      console.log(`[AutoTradingBot] ${fullText}`);
      state.logs.unshift(fullText);
      if (state.logs.length > 200) {
        state.logs = state.logs.slice(0, 200);
      }
      this.sendTelegramMessage(`[${strategyName}] ${text}`).catch(err => console.error('Telegram autotrade send failed:', err));
    };

    // 1. Process each strategy for opening new positions
    for (const rawStrategy of config.strategies) {
      if (!rawStrategy.enabled) continue;
      const strategy = resolveStrategyCredentials(rawStrategy, config.wallets);

      const alert = alertsList.find(a => a.id === strategy.alertId);
      if (!alert) continue;

      const isTriggered = alertEngineInstance.evaluate(latestSnapshot, alert.expression);
      let triggerOccurred = false;
      let crossoverDirection = 'long';

      if (isTriggered && prevSnapshot) {
        const wasTriggeredPrev = alertEngineInstance.evaluate(prevSnapshot, alert.expression);
        const currentPrice = latestSnapshot.price;
        const dirMode = strategy.direction || 'auto';

        if (dirMode === 'long') {
          if (!wasTriggeredPrev) {
            triggerOccurred = true;
          }
          crossoverDirection = 'long';
        } else if (dirMode === 'short') {
          if (!wasTriggeredPrev) {
            triggerOccurred = true;
          }
          crossoverDirection = 'short';
        } else if (dirMode === 'trend_long') {
          if (!wasTriggeredPrev) {
            const lastCrossoverPrice = alert.last_crossover_price;
            if (lastCrossoverPrice === null || lastCrossoverPrice === undefined || currentPrice > lastCrossoverPrice) {
              triggerOccurred = true;
            }
          }
          crossoverDirection = 'long';
        } else if (dirMode === 'trend_short') {
          if (!wasTriggeredPrev) {
            const lastCrossoverPrice = alert.last_crossover_price;
            if (lastCrossoverPrice === null || lastCrossoverPrice === undefined || currentPrice < lastCrossoverPrice) {
              triggerOccurred = true;
            }
          }
          crossoverDirection = 'short';
        } else { // 'auto'
          const alertTrendMode = alert.trend_mode || 'none';
          if (alertTrendMode === 'long') {
            if (!wasTriggeredPrev) {
              const lastCrossoverPrice = alert.last_crossover_price;
              if (lastCrossoverPrice === null || lastCrossoverPrice === undefined || currentPrice > lastCrossoverPrice) {
                triggerOccurred = true;
              }
            }
            crossoverDirection = 'long';
          } else if (alertTrendMode === 'short') {
            if (!wasTriggeredPrev) {
              const lastCrossoverPrice = alert.last_crossover_price;
              if (lastCrossoverPrice === null || lastCrossoverPrice === undefined || currentPrice < lastCrossoverPrice) {
                triggerOccurred = true;
              }
            }
            crossoverDirection = 'short';
          } else { // 'none'
            triggerOccurred = true;
            crossoverDirection = 'long';
          }
        }
      }

      if (triggerOccurred) {
        const hasActive = state.activePositions.some(p => p.strategyId === strategy.id && p.status === 'active');
        if (!hasActive) {
          const triggerPrice = latestSnapshot.price;
          const cooldownMinutes = Number(alert.frequency_minutes || 0);
          const cooldownMs = cooldownMinutes * 60_000;
          
          let onCooldown = false;
          const strategyHistory = state.tradeHistory.filter(h => h.strategyId === strategy.id);
          if (strategyHistory.length > 0) {
            const lastTrade = strategyHistory[0];
            const lastTime = new Date(lastTrade.timestamp).getTime();
            const currTime = new Date(latestSnapshot.timestamp).getTime();
            if (currTime - lastTime < cooldownMs) {
              onCooldown = true;
            }
          }

          if (!onCooldown) {
            const positionId = crypto.randomUUID();
            const count = Number(strategy.orderCount || 3);
            const limitOrders = [];
            
            for (let index = 1; index <= count; index++) {
              const legOffset = parseFloat(strategy[`legOffset${index}`] ?? (index === 1 ? -0.3 : index === 2 ? -1.0 : -2.0));
              const legAmount = parseFloat(strategy[`legAmount${index}`] ?? (index === 1 ? 10 : index === 2 ? 20 : 30));
              
              let finalAmount = legAmount;
              if (strategy.tradeAmount) {
                finalAmount = parseFloat(strategy.tradeAmount) / count;
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
              strategyId: strategy.id,
              strategyName: strategy.name,
              subaccountIndex: strategy.subaccountIndex ?? 0,
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
              exchange: strategy.exchange || 'hl'
            };

            const logMsg = (text) => logMsgForStrategy(strategy.name, text);

            if (newPosition.exchange === '01_exchange') {
              try {
                logMsg(`🤖 [OPENING] Connecting to 01 Exchange to place limit order grid...`);
                const { nord, user } = await get01User(strategy);
                const info = await nord.getInfo();
                const market = info.markets.find(m => m.symbol === 'HYPEUSD');
                if (!market) throw new Error('HYPEUSD market not found on 01 Exchange');
                const marketId = market.marketId;

                const subaccountIndex = parseInt(strategy.subaccountIndex ?? 0, 10);
                const accountId = user.accountIds[subaccountIndex] || user.accountIds[0];
                if (!accountId) {
                  throw new Error('No subaccount ID resolved for 01 Exchange.');
                }

                for (const order of newPosition.limitOrders) {
                  const side = crossoverDirection === 'long' ? Side.Bid : Side.Ask;
                  const size = parseFloat(order.qty.toFixed(market.sizeDecimals));
                  const price = parseFloat(order.limitPrice.toFixed(market.priceDecimals));
                  
                  logMsg(`🤖 [PLACE ORDER] Placing order: ${side.toUpperCase()} size=${size} price=$${price} on 01 Exchange (subaccount index: ${subaccountIndex})...`);
                  const res = await user.placeOrder({
                    marketId,
                    side,
                    fillMode: FillMode.Limit,
                    isReduceOnly: false,
                    size,
                    price,
                    accountId
                  });
                  order.orderId = res.orderId.toString();
                  order.actionId = res.actionId.toString();
                  logMsg(`🤖 [PLACED] Order ID: ${order.orderId} (Action ID: ${order.actionId})`);
                }
                
                state.activePositions.push(newPosition);
                logMsg(`🤖 [OPEN] Live 01 Exchange order grid placed successfully! Direction: ${crossoverDirection.toUpperCase()}, Trigger Price: $${triggerPrice.toFixed(4)}`);
                stateChanged = true;
              } catch (err) {
                const detailedMessage = err.cause ? `${err.message} (Cause: ${err.cause.message})` : err.message;
                logMsg(`⚠️ [ERROR] Failed to open position on 01 Exchange: ${detailedMessage}`);
                console.error(err);
              }
            } else if (newPosition.exchange === 'hibachi') {
              try {
                logMsg(`🤖 [OPENING] Connecting to Hibachi via CCXT to place limit order grid...`);
                await this.hibachiAdapter.placeLimitGrid(newPosition, strategy);
                state.activePositions.push(newPosition);
                logMsg(`🤖 [OPEN] Live Hibachi order grid placed successfully! Account ID: ${strategy.accountId || strategy.subaccountIndex || 'default'}, Direction: ${crossoverDirection.toUpperCase()}, Trigger Price: $${triggerPrice.toFixed(4)}`);
                stateChanged = true;
              } catch (err) {
                const detailedMessage = err.cause ? `${err.message} (Cause: ${err.cause.message})` : err.message;
                logMsg(`⚠️ [ERROR] Failed to open position on Hibachi: ${detailedMessage}`);
                console.error(err);
              }
            } else {
              state.activePositions.push(newPosition);
              logMsg(`🤖 [OPEN] Live order grid initialized on crossover! Exchange: ${newPosition.exchange.toUpperCase()}, Direction: ${crossoverDirection.toUpperCase()}, Trigger Price: $${triggerPrice.toFixed(4)}`);
              stateChanged = true;
            }
          }
        }
      }
    }

    // 2. Update Existing Active Positions
    const activePositions = state.activePositions.filter(p => p.status === 'active');
    for (const pos of activePositions) {
      const rawStrategy = config.strategies.find(s => s.id === pos.strategyId);
      const strategy = resolveStrategyCredentials(rawStrategy, config.wallets);
      const strategyName = pos.strategyName || 'Unknown Strategy';
      const logMsg = (text) => logMsgForStrategy(strategyName, text);

      const currentStrategyConfig = strategy || {
        exchange: pos.exchange,
        wallet: config.wallet,
        privateKey: config.privateKey,
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        tpMode: 'percent',
        tpPercent: 1.5,
        tpAnchor: 'avg',
        slMode: 'percent',
        slPercent: 2.0
      };

      const triggerPrice = pos.triggerPrice;
      const isShort = (pos.direction === 'short');
      
      const sLow = Number.isFinite(latestSnapshot.low) ? latestSnapshot.low : latestSnapshot.price;
      const sHigh = Number.isFinite(latestSnapshot.high) ? latestSnapshot.high : latestSnapshot.price;
      const currentPrice = latestSnapshot.price;

      // check limit orders
      if (pos.exchange === '01_exchange') {
        try {
          const user = await this.getCachedUser(currentStrategyConfig);
          const subaccountIndex = parseInt(pos.subaccountIndex ?? currentStrategyConfig.subaccountIndex ?? 0, 10);
          const accountId = user.accountIds[subaccountIndex] || user.accountIds[0];
          const openOrders = accountId ? (user.orders[accountId] || []) : [];
          
          for (const order of pos.limitOrders) {
            if (!order.filled && order.orderId) {
              const isStillOpen = openOrders.some(o => o.orderId.toString() === order.orderId.toString());
              if (!isStillOpen) {
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
                
                logMsg(`🤖 [FILL] 01 Exchange order filled for leg ${order.index} at limit $${order.limitPrice.toFixed(4)}. Position Size: ${pos.qty.toFixed(4)}, Avg Price: $${pos.avgPrice.toFixed(4)}`);
              }
            }
          }
        } catch (err) {
          console.error('Error updating 01 Exchange position status:', err);
        }
      } else if (pos.exchange === 'hibachi') {
        try {
          const changed = await this.hibachiAdapter.syncFills(pos, currentStrategyConfig, latestSnapshot.timestamp);
          if (changed) {
            stateChanged = true;
            const latestFilled = pos.filledPositions.at(-1);
            if (latestFilled) {
              const fillPrice = latestFilled.fillPrice ?? latestFilled.limitPrice;
              logMsg(`🤖 [FILL] Hibachi order filled for leg ${latestFilled.index} at $${Number(fillPrice).toFixed(4)}. Position Size: ${pos.qty.toFixed(4)}, Avg Price: $${pos.avgPrice.toFixed(4)}`);
            }
          }
        } catch (err) {
          console.error('Error updating Hibachi position status:', err);
          const detailedMessage = err.cause ? `${err.message} (Cause: ${err.cause.message})` : err.message;
          logMsg(`⚠️ [ERROR] Failed to sync Hibachi orders: ${detailedMessage}`);
        }
      } else {
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
      }

      if (pos.filledPositions.length > 0) {
        // Exits logic
        const tpPercent = parseFloat(currentStrategyConfig.tpPercent || 1.5);
        const slPercent = parseFloat(currentStrategyConfig.slPercent || 2.0);
        const tpAnchor = currentStrategyConfig.tpAnchor || 'avg';
        
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
        if (currentStrategyConfig.tpMode === 'percent') {
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
        if (!exitTriggered && currentStrategyConfig.slMode === 'percent') {
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
          if (currentStrategyConfig.tpMode === 'metric') {
            const exitAlertId = currentStrategyConfig.tpCloseSelect || 'same';
            let triggeredExit = false;
            if (exitAlertId === 'same') {
              const strategyAlert = alertsList.find(a => a.id === currentStrategyConfig.alertId);
              if (strategyAlert) {
                triggeredExit = alertEngineInstance.evaluate(latestSnapshot, strategyAlert.expression);
              }
            } else if (exitAlertId === 'custom' && currentStrategyConfig.tpCustomExpr) {
              triggeredExit = alertEngineInstance.evaluate(latestSnapshot, currentStrategyConfig.tpCustomExpr);
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

        if (!exitTriggered && currentStrategyConfig.slMode === 'metric') {
          const exitAlertId = currentStrategyConfig.slCloseSelect || 'same';
          let triggeredExit = false;
          if (exitAlertId === 'same') {
            const strategyAlert = alertsList.find(a => a.id === currentStrategyConfig.alertId);
            if (strategyAlert) {
              triggeredExit = alertEngineInstance.evaluate(latestSnapshot, strategyAlert.expression);
            }
          } else if (exitAlertId === 'custom' && currentStrategyConfig.slCustomExpr) {
            triggeredExit = alertEngineInstance.evaluate(latestSnapshot, currentStrategyConfig.slCustomExpr);
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
          if (pos.exchange === '01_exchange') {
            await close01Position(pos, currentStrategyConfig, logMsg);
          } else if (pos.exchange === 'hibachi') {
            await this.hibachiAdapter.closePosition(pos, currentStrategyConfig);
          }
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
        // No filled orders yet. Check TP cancel threshold and timeout
        const tpPercent = parseFloat(currentStrategyConfig.tpPercent || 1.5);
        const cancelPrice = isShort 
          ? triggerPrice * (1 - tpPercent / 100)
          : triggerPrice * (1 + tpPercent / 100);

        let cancelTriggered = false;
        if (isShort) {
          if (sLow <= cancelPrice) cancelTriggered = true;
        } else {
          if (sHigh >= cancelPrice) cancelTriggered = true;
        }

        const cancelMins = parseFloat(currentStrategyConfig.unfilledCancelMinutes ?? 30);
        const elapsedMs = new Date(latestSnapshot.timestamp).getTime() - new Date(pos.timestamp).getTime();
        const elapsedMins = elapsedMs / (60 * 1000);
        const timeoutTriggered = elapsedMins >= cancelMins;

        if (cancelTriggered || timeoutTriggered) {
          if (pos.exchange === '01_exchange') {
            await close01Position(pos, currentStrategyConfig, logMsg);
          } else if (pos.exchange === 'hibachi') {
            await this.hibachiAdapter.cancelOpenOrders(pos, currentStrategyConfig);
          }
          pos.status = 'canceled';
          state.activePositions = state.activePositions.filter(p => p.id !== pos.id);
          
          if (timeoutTriggered) {
            logMsg(`🤖 [CANCEL] Grid canceled without fills. Unfilled cancel timeout reached (${cancelMins} min).`);
          } else {
            logMsg(`🤖 [CANCEL] Grid canceled without fills. Price reached TP threshold before any order was filled.`);
          }
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
    const config = await this.autoTradeStore.getConfig();
    const rawStrategy = config.strategies.find(s => s.id === pos.strategyId);
    const strategy = resolveStrategyCredentials(rawStrategy, config.wallets);
    const currentStrategyConfig = strategy || {
      exchange: pos.exchange,
      wallet: config.wallet,
      privateKey: config.privateKey,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret
    };

    const strategyName = pos.strategyName || 'Unknown Strategy';

    if (pos.exchange === '01_exchange') {
      await close01Position(pos, currentStrategyConfig, (text) => {
        const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
        state.logs.unshift(`[${timeStr}] [${strategyName}] ${text}`);
        this.sendTelegramMessage(`[${strategyName}] ${text}`).catch(err => console.error('Telegram autotrade send failed:', err));
      });
    } else if (pos.exchange === 'hibachi') {
      await this.hibachiAdapter.closePosition(pos, currentStrategyConfig);
    }

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
    const fullText = `[${timeStr}] [${strategyName}] 🤖 [MANUAL CLOSE] Live position force-closed manually at $${actualPrice.toFixed(4)}. Realized PnL: $${profit.toFixed(2)}`;
    state.logs.unshift(fullText);

    await this.autoTradeStore.saveState(state);
    this.sendTelegramMessage(fullText).catch(err => console.error('Telegram autotrade send failed:', err));
    return true;
  }

  async sendTelegramMessage(text) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
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
        }),
        signal: controller.signal
      });
    } catch (err) {
      console.error('Error sending telegram message from autotrade bot:', err);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

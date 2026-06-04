import ccxt from 'ccxt';

export const HIBACHI_SYMBOL = 'HYPE/USDT:USDT';
const HIBACHI_PRICE_TICK_SIZE = 0.0001;

export function resolveHibachiAccountId(config = {}) {
  if (config.accountId !== undefined && config.accountId !== null && String(config.accountId).trim()) {
    return String(config.accountId).trim();
  }
  if (config.subaccountIndex !== undefined && config.subaccountIndex !== null) {
    return String(config.subaccountIndex);
  }
  return '';
}

export function createHibachiCcxtExchange(config = {}, CcxtHibachi = ccxt.hibachi) {
  const accountId = resolveHibachiAccountId(config);
  if (!config.apiKey) {
    throw new Error('Hibachi API key is required.');
  }
  if (!accountId) {
    throw new Error('Hibachi account ID is required.');
  }
  if (!config.privateKey) {
    throw new Error('Hibachi private key is required.');
  }

  return new CcxtHibachi({
    apiKey: config.apiKey,
    accountId,
    privateKey: config.privateKey,
    enableRateLimit: true
  });
}

function getOrderId(order) {
  if (order?.id !== undefined && order?.id !== null) return String(order.id);
  if (order?.info?.orderId !== undefined && order?.info?.orderId !== null) return String(order.info.orderId);
  return '';
}

function getOrderAverage(order, fallbackPrice) {
  const average = Number(order?.average);
  if (Number.isFinite(average) && average > 0) return average;
  const price = Number(order?.price);
  if (Number.isFinite(price) && price > 0) return price;
  return fallbackPrice;
}

function getOrderFilled(order, fallbackQty) {
  const filled = Number(order?.filled);
  if (Number.isFinite(filled) && filled > 0) return filled;
  return fallbackQty;
}

function recalculatePositionFromFills(position) {
  let totalQty = 0;
  let totalCost = 0;
  for (const fill of position.filledPositions || []) {
    const qty = Number(fill.filledQty ?? fill.qty);
    const price = Number(fill.fillPrice ?? fill.limitPrice);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;
    totalQty += qty;
    totalCost += qty * price;
  }
  position.qty = totalQty;
  position.avgPrice = totalQty > 0 ? totalCost / totalQty : 0;
}

function roundToTick(value, tickSize) {
  return Math.round((Number(value) + Number.EPSILON) / tickSize) * tickSize;
}

export class HibachiCcxtAdapter {
  constructor({ exchangeFactory = createHibachiCcxtExchange, symbol = HIBACHI_SYMBOL } = {}) {
    this.exchangeFactory = exchangeFactory;
    this.symbol = symbol;
  }

  async getExchange(config) {
    const exchange = this.exchangeFactory(config);
    if (typeof exchange.loadMarkets === 'function') {
      await exchange.loadMarkets();
    }
    return exchange;
  }

  toAmount(exchange, amount) {
    if (typeof exchange.amountToPrecision === 'function') {
      return Number(exchange.amountToPrecision(this.symbol, amount));
    }
    return Number(amount);
  }

  toPrice(exchange, price) {
    let precisePrice = price;
    if (typeof exchange.priceToPrecision === 'function') {
      precisePrice = exchange.priceToPrecision(this.symbol, price);
    }
    return Number(roundToTick(precisePrice, HIBACHI_PRICE_TICK_SIZE).toFixed(4));
  }

  async placeLimitGrid(position, config) {
    const exchange = await this.getExchange(config);
    const side = position.direction === 'short' ? 'sell' : 'buy';

    for (const order of position.limitOrders) {
      const amount = this.toAmount(exchange, order.qty);
      const price = this.toPrice(exchange, order.limitPrice);
      const result = await exchange.createOrder(this.symbol, 'limit', side, amount, price, {
        reduceOnly: false
      });
      order.orderId = getOrderId(result);
      if (result?.clientOrderId) order.clientOrderId = result.clientOrderId;
    }
  }

  async syncFills(position, config, timestamp) {
    const exchange = await this.getExchange(config);
    const openOrders = await exchange.fetchOpenOrders(this.symbol);
    const openOrderIds = new Set((openOrders || []).map(order => getOrderId(order)).filter(Boolean));
    let changed = false;

    position.filledPositions = position.filledPositions || [];
    for (const order of position.limitOrders || []) {
      if (order.filled || !order.orderId) continue;
      if (openOrderIds.has(String(order.orderId))) continue;

      let details = null;
      try {
        details = await exchange.fetchOrder(String(order.orderId), this.symbol);
      } catch (err) {
        details = null;
      }

      const status = String(details?.status || '').toLowerCase();
      if (status === 'canceled' || status === 'rejected' || status === 'expired') {
        order.canceled = true;
        changed = true;
        continue;
      }

      order.filled = true;
      order.filledAt = timestamp;
      order.fillPrice = getOrderAverage(details, order.limitPrice);
      order.filledQty = getOrderFilled(details, order.qty);
      position.filledPositions.push(order);
      changed = true;
    }

    if (changed) {
      recalculatePositionFromFills(position);
    }
    return changed;
  }

  async cancelOpenOrders(position, config) {
    const exchange = await this.getExchange(config);
    const openOrders = await exchange.fetchOpenOrders(this.symbol);
    const openOrderIds = new Set((openOrders || []).map(order => getOrderId(order)).filter(Boolean));

    for (const order of position.limitOrders || []) {
      if (order.filled || !order.orderId || !openOrderIds.has(String(order.orderId))) continue;
      await exchange.cancelOrder(String(order.orderId), this.symbol);
      order.canceled = true;
    }
  }

  async closePosition(position, config) {
    const exchange = await this.getExchange(config);
    const openOrders = await exchange.fetchOpenOrders(this.symbol);
    const openOrderIds = new Set((openOrders || []).map(order => getOrderId(order)).filter(Boolean));

    for (const order of position.limitOrders || []) {
      if (order.filled || !order.orderId || !openOrderIds.has(String(order.orderId))) continue;
      await exchange.cancelOrder(String(order.orderId), this.symbol);
      order.canceled = true;
    }

    const qty = this.toAmount(exchange, position.qty);
    if (qty > 0) {
      const side = position.direction === 'short' ? 'buy' : 'sell';
      await exchange.createOrder(this.symbol, 'market', side, qty, undefined, {
        reduceOnly: true
      });
    }
  }

  async fetchSubaccounts(config) {
    const exchange = await this.getExchange(config);
    const balance = typeof exchange.fetchBalance === 'function' ? await exchange.fetchBalance() : {};
    const accountId = resolveHibachiAccountId(config);
    const usdt = balance?.USDT || {};
    return [{
      index: Number(accountId),
      id: accountId,
      balance: Number(usdt.free ?? usdt.total ?? 0)
    }];
  }

  async fetchPositions(config) {
    const exchange = await this.getExchange(config);
    if (typeof exchange.fetchPositions !== 'function') return [];
    return exchange.fetchPositions([this.symbol]);
  }
}

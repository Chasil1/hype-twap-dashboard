import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AutoTradingEngine
} from '../src/autoTradingEngine.js';
import {
  HibachiCcxtAdapter,
  createHibachiCcxtExchange,
  resolveHibachiAccountId,
  HIBACHI_SYMBOL
} from '../src/hibachiCcxtAdapter.js';

class FakeHibachiExchange {
  constructor({ openOrderIds = [], orderDetails = {}, balance = {}, positions = [], pricePrecisionMode = 'twoDecimals' } = {}) {
    this.marketsLoaded = false;
    this.createdOrders = [];
    this.canceledOrders = [];
    this.openOrderIds = openOrderIds.map(String);
    this.orderDetails = orderDetails;
    this.balance = balance;
    this.positions = positions;
    this.pricePrecisionMode = pricePrecisionMode;
  }

  async loadMarkets() {
    this.marketsLoaded = true;
  }

  amountToPrecision(_symbol, amount) {
    return Number(amount).toFixed(4);
  }

  priceToPrecision(_symbol, price) {
    if (this.pricePrecisionMode === 'passthrough') {
      return String(price);
    }
    return Number(price).toFixed(2);
  }

  async createOrder(symbol, type, side, amount, price, params = {}) {
    const id = `order-${this.createdOrders.length + 1}`;
    const order = { id, symbol, type, side, amount, price, params, status: 'open' };
    this.createdOrders.push(order);
    this.openOrderIds.push(id);
    return order;
  }

  async fetchOpenOrders() {
    return this.openOrderIds.map(id => ({ id, status: 'open' }));
  }

  async fetchOrder(id) {
    return this.orderDetails[id] || { id, status: 'closed', filled: 1, average: 99 };
  }

  async cancelOrder(id) {
    this.canceledOrders.push(String(id));
    this.openOrderIds = this.openOrderIds.filter(openId => openId !== String(id));
    return { id, status: 'canceled' };
  }

  async fetchBalance() {
    return this.balance;
  }

  async fetchPositions() {
    return this.positions;
  }
}

test('resolveHibachiAccountId accepts explicit accountId before subaccountIndex', () => {
  assert.equal(resolveHibachiAccountId({ accountId: '77', subaccountIndex: 12 }), '77');
  assert.equal(resolveHibachiAccountId({ subaccountIndex: 12 }), '12');
});

test('createHibachiCcxtExchange passes Hibachi credentials to CCXT constructor', () => {
  const created = [];
  const exchange = createHibachiCcxtExchange(
    { apiKey: 'api', accountId: '42', privateKey: 'pk' },
    function FakeCcxtHibachi(options) {
      created.push(options);
      this.options = options;
    }
  );

  assert.equal(exchange.options.apiKey, 'api');
  assert.equal(exchange.options.accountId, '42');
  assert.equal(exchange.options.privateKey, 'pk');
  assert.equal(exchange.options.enableRateLimit, true);
  assert.equal(created.length, 1);
});

test('HibachiCcxtAdapter places a reduce-disabled limit grid using CCXT unified orders', async () => {
  const fake = new FakeHibachiExchange();
  const adapter = new HibachiCcxtAdapter({ exchangeFactory: () => fake });
  const position = {
    direction: 'long',
    limitOrders: [
      { index: 1, qty: 0.123456, limitPrice: 20.9876 },
      { index: 2, qty: 0.234567, limitPrice: 20.1234 }
    ]
  };

  await adapter.placeLimitGrid(position, { apiKey: 'api', accountId: '42', privateKey: 'pk' });

  assert.equal(fake.marketsLoaded, true);
  assert.equal(fake.createdOrders.length, 2);
  assert.equal(fake.createdOrders[0].symbol, HIBACHI_SYMBOL);
  assert.equal(fake.createdOrders[0].type, 'limit');
  assert.equal(fake.createdOrders[0].side, 'buy');
  assert.equal(fake.createdOrders[0].amount, 0.1235);
  assert.equal(fake.createdOrders[0].price, 20.99);
  assert.equal(fake.createdOrders[0].params.reduceOnly, false);
  assert.equal(position.limitOrders[0].orderId, 'order-1');
  assert.equal(position.limitOrders[1].orderId, 'order-2');
});

test('HibachiCcxtAdapter rounds limit prices to Hibachi 0.0001 tick size', async () => {
  const fake = new FakeHibachiExchange({ pricePrecisionMode: 'passthrough' });
  const adapter = new HibachiCcxtAdapter({ exchangeFactory: () => fake });
  const position = {
    direction: 'long',
    limitOrders: [
      { index: 1, qty: 1, limitPrice: 65.06422 }
    ]
  };

  await adapter.placeLimitGrid(position, { apiKey: 'api', accountId: '42', privateKey: 'pk' });

  assert.equal(fake.createdOrders[0].price, 65.0642);
});

test('HibachiCcxtAdapter marks a limit leg filled when it disappears from open orders', async () => {
  const fake = new FakeHibachiExchange({
    openOrderIds: ['open-leg'],
    orderDetails: {
      'filled-leg': { id: 'filled-leg', status: 'closed', filled: 0.5, average: 19.5 }
    }
  });
  const adapter = new HibachiCcxtAdapter({ exchangeFactory: () => fake });
  const position = {
    direction: 'long',
    qty: 0,
    avgPrice: 0,
    filledPositions: [],
    limitOrders: [
      { index: 1, orderId: 'filled-leg', qty: 0.5, limitPrice: 20, filled: false },
      { index: 2, orderId: 'open-leg', qty: 0.5, limitPrice: 19, filled: false }
    ]
  };

  const changed = await adapter.syncFills(position, {}, '2026-06-05T00:00:00.000Z');

  assert.equal(changed, true);
  assert.equal(position.limitOrders[0].filled, true);
  assert.equal(position.limitOrders[0].filledAt, '2026-06-05T00:00:00.000Z');
  assert.equal(position.limitOrders[0].fillPrice, 19.5);
  assert.equal(position.limitOrders[1].filled, false);
  assert.equal(position.qty, 0.5);
  assert.equal(position.avgPrice, 19.5);
});

test('HibachiCcxtAdapter cancels open orders and sends reduce-only market close order', async () => {
  const fake = new FakeHibachiExchange({ openOrderIds: ['open-leg'] });
  const adapter = new HibachiCcxtAdapter({ exchangeFactory: () => fake });
  const position = {
    direction: 'short',
    qty: 0.75,
    limitOrders: [
      { index: 1, orderId: 'open-leg', filled: false },
      { index: 2, orderId: 'filled-leg', filled: true }
    ]
  };

  await adapter.closePosition(position, {});

  assert.deepEqual(fake.canceledOrders, ['open-leg']);
  const closeOrder = fake.createdOrders.at(-1);
  assert.equal(closeOrder.symbol, HIBACHI_SYMBOL);
  assert.equal(closeOrder.type, 'market');
  assert.equal(closeOrder.side, 'buy');
  assert.equal(closeOrder.amount, 0.75);
  assert.equal(closeOrder.params.reduceOnly, true);
});

test('AutoTradingEngine opens Hibachi positions through the CCXT adapter', async () => {
  const state = { activePositions: [], logs: [], tradeHistory: [] };
  const config = {
    wallets: [
      { id: 'wallet-hib', exchangeType: 'hibachi_ccxt', apiKey: 'api', accountId: '42', privateKey: 'pk' }
    ],
    strategies: [
      {
        id: 'strategy-hib',
        name: 'Hibachi Strategy',
        enabled: true,
        exchange: 'hibachi',
        walletId: 'wallet-hib',
        alertId: 'alert-1',
        direction: 'long',
        orderCount: 1,
        tradeAmount: 10,
        legOffset1: -1,
        legAmount1: 10,
        tpMode: 'none',
        slMode: 'none'
      }
    ]
  };
  const adapterCalls = [];
  const engine = new AutoTradingEngine({
    autoTradeStore: {
      async getConfig() {
        return config;
      },
      async getState() {
        return state;
      },
      async saveState(nextState) {
        Object.assign(state, nextState);
      }
    },
    configStore: {
      async get() {
        return null;
      }
    },
    hibachiAdapter: {
      async placeLimitGrid(position, strategy) {
        adapterCalls.push({ position, strategy });
        position.limitOrders[0].orderId = 'hib-order-1';
      },
      async syncFills() {
        return false;
      }
    }
  });

  await engine.update(
    [
      { timestamp: '2026-06-05T00:00:00.000Z', price: 100, high: 100, low: 100 },
      { timestamp: '2026-06-05T00:01:00.000Z', price: 101, high: 101, low: 101 }
    ],
    [
      { id: 'alert-1', name: 'Always', expression: { field1: 'price', operator: 'gt', compareType: 'value', value: 0 }, trend_mode: 'long' }
    ],
    {
      evaluate(snapshot) {
        return snapshot.price > 100;
      }
    }
  );

  assert.equal(adapterCalls.length, 1);
  assert.equal(adapterCalls[0].strategy.accountId, '42');
  assert.equal(state.activePositions.length, 1);
  assert.equal(state.activePositions[0].exchange, 'hibachi');
  assert.equal(state.activePositions[0].limitOrders[0].orderId, 'hib-order-1');
});

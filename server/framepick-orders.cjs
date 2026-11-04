'use strict';
// Framepick demo orders: the purchase flow from PRD PAY-01..06 with a SIMULATED
// payment outcome instead of a payment channel. Nothing here charges money.
//
// - Amounts, sale status and rights versions come from the server catalogue
//   (PAY-02): whatever the browser sends is ignored except filmId/requestId.
// - Rights are granted only on the simulated 'paid' callback, and repeated
//   callbacks grant exactly one right and one event (PAY-03/04).
// - Orders belong to a signed-in account and survive restarts, so a device
//   change can find them again (PAY-06). Data lives outside the repository.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileStore } = require('./framepick-store.cjs');

// Isolated demo goods. Real catalogue films must never be sellable here: the
// demo catalogue is keyed `demo-` so a film id can never collide by accident.
const DEMO_CATALOGUE = [
  {
    id: 'demo-film-3',
    title: '演示影片 · 3 元档',
    amountCents: 300,
    currency: 'CNY',
    rightsVersion: 'demo-rights-2026-3',
    authorizationDays: 30,
    demo: true,
    saleStatus: 'available',
  },
  {
    id: 'demo-film-5',
    title: '演示影片 · 5 元档',
    amountCents: 500,
    currency: 'CNY',
    rightsVersion: 'demo-rights-2026-5',
    authorizationDays: 30,
    demo: true,
    saleStatus: 'available',
  },
];

const ACTIVE_STATES = ['unpaid', 'confirming', 'paid'];
// 模拟回调：支付链路（confirming/paid/failed）与购后状态（refunding/refunded/
// expired/unavailable）。全部是模拟事件，没有支付渠道，也不扣款。
const SIMULATION_OUTCOMES = new Set(['confirming', 'paid', 'failed', 'refunding', 'refunded', 'expired', 'unavailable']);
// 有观影权益的状态：已购、退款处理中（权益保留）、下架（权益暂停但记录保留）。
const RIGHTS_STATES = ['paid', 'refunding', 'unavailable'];

class OrderError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'OrderError';
    this.status = status;
  }
}

function failure(status, message) {
  return new OrderError(status, message);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 64 * 1024) reject(failure(413, '请求内容过大。'));
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(failure(400, '请求内容不是合法 JSON。'));
      }
    });
  });
}

function createOrderHandler({
  accounts,
  dataDir = process.env.FRAMEPICK_ORDERS_DATA_DIR || path.join(os.homedir(), '.framepick', 'orders'),
  allowedOrigin = process.env.FRAMEPICK_REVIEWS_ALLOWED_ORIGIN || '',
  clock = Date.now,
  store: providedStore = null,
} = {}) {
  if (!accounts || typeof accounts.resolveAccount !== 'function') throw new Error('createOrderHandler 需要 accounts.resolveAccount');
  const store = providedStore || createFileStore({ dir: dataDir });

  let db = { version: 1, orders: [], entitlements: [], simulationEvents: [] };
  let ready = null;

  async function persist() {
    await store.write('orders.json', `${JSON.stringify(db, null, 2)}\n`);
  }

  async function initialize() {
    const text = await store.read('orders.json');
    if (text === null) {
      db = { version: 1, orders: [], entitlements: [], simulationEvents: [] };
      await persist();
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.orders) || !Array.isArray(parsed.entitlements) || !Array.isArray(parsed.simulationEvents)) {
        throw new Error('bad shape');
      }
      db = parsed;
    } catch (error) {
      throw new Error(`订单数据无法读取，已拒绝覆盖：${error.message}`);
    }
  }

  function entitlementFor(order) {
    const record = db.entitlements.find((entry) => entry.orderId === order.id);
    if (!record) return { active: false };
    const live = RIGHTS_STATES.includes(order.state) && record.endsAt > new Date(clock()).toISOString();
    return { active: live, endsAt: record.endsAt };
  }

  function clientOrder(order) {
    return { ...order, entitlement: entitlementFor(order) };
  }

  function findProduct(filmId) {
    return DEMO_CATALOGUE.find((item) => item.id === filmId) || null;
  }

  async function createOrReturnOrder(account, body) {
    const filmId = typeof body?.filmId === 'string' ? body.filmId : '';
    const requestId = typeof body?.requestId === 'string' ? body.requestId.trim() : '';
    if (!requestId) throw failure(400, '缺少 requestId。');
    const product = findProduct(filmId);
    // 未知商品与真实片库作品一律不卖：防演示商品接口被当成真实售卖入口。
    if (!product) throw failure(404, '该作品不在演示商品清单中。');
    const byRequest = db.orders.find((order) => order.accountId === account.id && order.requestId === requestId);
    if (byRequest) {
      // 同一 requestId 只认第一次的订单；换了作品就是调用方传错，明确拒绝。
      if (byRequest.filmId !== filmId) throw failure(409, 'requestId 已用于其他商品的订单。');
      return { order: byRequest, created: false };
    }
    const active = db.orders.find((order) => order.accountId === account.id
      && order.filmId === filmId && ACTIVE_STATES.includes(order.state));
    // 同作品已有进行中订单：直接返回，不重复下单（PAY-05 避免误导重复购买）。
    if (active) return { order: active, created: false };
    const now = new Date(clock()).toISOString();
    const order = {
      id: `ord_${crypto.randomBytes(12).toString('hex')}`,
      accountId: account.id,
      filmId,
      requestId,
      amountCents: product.amountCents,
      currency: product.currency,
      rightsVersion: product.rightsVersion,
      authorizationDays: product.authorizationDays,
      state: 'unpaid',
      simulation: true,
      realPayment: false,
      createdAt: now,
      updatedAt: now,
      paidAt: null,
    };
    db.orders.push(order);
    await persist();
    return { order, created: true };
  }

  // 模拟支付回调：状态未推进的过期回调一律不改状态、不重复发权益（PAY-03/04）。
  // 权益每笔订单只发一次：下架后恢复（unavailable→paid）拿回原权益，不补发。
  async function applySimulation(order, outcome) {
    const now = clock();
    const iso = new Date(now).toISOString();
    if (order.state === 'canceled') return order;
    if (outcome === 'confirming') {
      if (order.state === 'unpaid') {
        order.state = 'confirming';
        order.updatedAt = iso;
        await persist();
      }
      return order;
    }
    if (outcome === 'paid') {
      // paid 幂等；退款中/已退款/已到期的订单不能靠过期回调复活。
      if (order.state === 'paid' || order.state === 'refunding' || order.state === 'refunded' || order.state === 'expired') return order;
      order.state = 'paid';
      order.paidAt = order.paidAt || iso;
      order.updatedAt = iso;
      const existing = db.entitlements.find((entry) => entry.orderId === order.id);
      if (!existing) {
        db.entitlements.push({
          orderId: order.id,
          accountId: order.accountId,
          filmId: order.filmId,
          rightsVersion: order.rightsVersion,
          grantedAt: iso,
          endsAt: new Date(now + order.authorizationDays * 24 * 3600 * 1000).toISOString(),
        });
        db.simulationEvents.push({
          kind: 'simulated-paid',
          orderId: order.id,
          accountId: order.accountId,
          amountCents: order.amountCents,
          at: iso,
        });
      }
      await persist();
      return order;
    }
    if (outcome === 'failed') {
      // 已支付及之后的状态不能被失败回调降级。
      if (RIGHTS_STATES.includes(order.state) || order.state === 'refunded' || order.state === 'expired') return order;
      order.state = 'failed';
      order.updatedAt = iso;
      await persist();
      return order;
    }
    if (outcome === 'refunding') {
      if (order.state === 'paid') {
        order.state = 'refunding';
        order.updatedAt = iso;
        await persist();
      }
      return order;
    }
    if (outcome === 'refunded') {
      if (order.state === 'refunding') {
        order.state = 'refunded';
        order.updatedAt = iso;
        await persist();
      }
      return order;
    }
    if (outcome === 'expired') {
      if (order.state === 'paid') {
        order.state = 'expired';
        order.updatedAt = iso;
        await persist();
      }
      return order;
    }
    // outcome === 'unavailable'：影片下架，订单与权益记录保留（暂停放映）。
    if (order.state === 'paid') {
      order.state = 'unavailable';
      order.updatedAt = iso;
      await persist();
    }
    return order;
  }

  async function cancelOrder(order) {
    // 只有未进入支付后状态的订单能取消；已购走退款流程。
    if (!['unpaid', 'confirming', 'failed'].includes(order.state)) throw failure(409, '当前状态不能取消订单。');
    order.state = 'canceled';
    order.updatedAt = new Date(clock()).toISOString();
    await persist();
    return order;
  }

  return {
    DEMO_CATALOGUE,

    async handle(req, res, url) {
      const pathname = url.pathname;
      if (pathname !== '/api/framepick/orders' && !pathname.startsWith('/api/framepick/orders/')) return false;
      res.setHeader('Vary', 'Origin');
      try {
        ready = ready || initialize();
        await ready;
        const origin = req.headers.origin;
        const ownOrigin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
        if (origin && origin !== ownOrigin && origin !== allowedOrigin) throw failure(403, '请求来源不受信任。');
        if (origin && origin === allowedOrigin) res.setHeader('Access-Control-Allow-Origin', origin);
        if (req.method !== 'GET' && req.headers['sec-fetch-site'] === 'cross-site' && (!origin || origin !== allowedOrigin)) {
          throw failure(403, '不允许跨站提交。');
        }

        // 演示商品清单公开可读：没登录也能先看清价格与权益说明（PAY-01）。
        if (req.method === 'GET' && pathname === '/api/framepick/orders/catalogue') {
          sendJson(res, 200, {
            demo: true,
            simulation: true,
            disclaimer: '演示商品与模拟支付：不会产生真实订单，不会扣款。',
            products: DEMO_CATALOGUE,
          });
          return true;
        }

        const account = await accounts.resolveAccount(req);
        if (!account) throw failure(401, '请先登录后再操作订单。');

        if (req.method === 'POST' && pathname === '/api/framepick/orders') {
          const body = await readJsonBody(req);
          const { order, created } = await createOrReturnOrder(account, body);
          sendJson(res, created ? 201 : 200, { order: clientOrder(order) });
          return true;
        }

        if (req.method === 'GET' && pathname === '/api/framepick/orders') {
          const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
          const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 20));
          const mine = db.orders.filter((order) => order.accountId === account.id)
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
          sendJson(res, 200, {
            total: mine.length,
            orders: mine.slice((page - 1) * pageSize, page * pageSize).map(clientOrder),
          });
          return true;
        }

        const idMatch = pathname.match(/^\/api\/framepick\/orders\/([^/]+)(?:\/(simulate|cancel))?$/);
        if (!idMatch) {
          sendJson(res, 404, { error: 'Not found' });
          return true;
        }
        const [, orderId, action] = idMatch;
        const order = db.orders.find((item) => item.id === orderId && item.accountId === account.id);
        // 跨账号一律当不存在：不泄露他人订单是否存在。
        if (!order) throw failure(404, '找不到该订单。');

        if (req.method === 'GET' && !action) {
          sendJson(res, 200, { order: clientOrder(order) });
          return true;
        }

        if (req.method === 'POST' && action === 'simulate') {
          const body = await readJsonBody(req);
          const outcome = typeof body?.outcome === 'string' ? body.outcome : '';
          if (!SIMULATION_OUTCOMES.has(outcome)) throw failure(400, 'outcome 不是受支持的模拟事件（confirming / paid / failed / refunding / refunded / expired / unavailable）；模拟支付不会产生真实扣款。');
          await applySimulation(order, outcome);
          sendJson(res, 200, { order: clientOrder(order) });
          return true;
        }

        if (req.method === 'POST' && action === 'cancel') {
          await readJsonBody(req);
          await cancelOrder(order);
          sendJson(res, 200, { order: clientOrder(order) });
          return true;
        }

        sendJson(res, 404, { error: 'Not found' });
        return true;
      } catch (error) {
        const status = error instanceof OrderError ? error.status : 500;
        sendJson(res, status, { error: status === 500 ? '服务暂时不可用。' : error.message });
        if (status === 500) console.error(error);
        return true;
      }
    },
  };
}

module.exports = { createOrderHandler, DEMO_CATALOGUE, OrderError };

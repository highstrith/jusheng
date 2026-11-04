import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createAccountHandler } = require('../server/framepick-accounts.cjs');
const { createOrderHandler, DEMO_CATALOGUE } = require('../server/framepick-orders.cjs');
const PASSWORD = 'correct-horse-battery';

async function service(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'framepick-orders-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const accounts = createAccountHandler({ dataDir: path.join(root, 'accounts') });
  let orders = createOrderHandler({ accounts, dataDir: path.join(root, 'orders'), ...options });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (await accounts.handle(req, res, url)) return;
    if (await orders.handle(req, res, url)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"Not found"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    const jar = new Map();
    const request = async (route, { method = 'GET', body, headers = {} } = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await fetch(base + route, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) {
        const [pair] = setCookie.split(';');
        const index = pair.indexOf('=');
        if (pair.slice(index + 1)) jar.set(pair.slice(0, index), pair.slice(index + 1));
        else jar.delete(pair.slice(0, index));
      }
      return { status: response.status, json: await response.json().catch(() => null), headers: response.headers };
    };
    const register = async (email = 'viewer@example.com') => {
      const response = await request('/api/framepick/accounts/register', { method: 'POST', body: { email, password: PASSWORD, nickname: '观众' } });
      assert.equal(response.status, 201);
      return response;
    };
    return { request, register };
  }

  return {
    base,
    root,
    accounts,
    client,
    get orders() { return orders; },
    restartOrders() { orders = createOrderHandler({ accounts, dataDir: path.join(root, 'orders'), ...options }); },
  };
}

async function createOrder(client, overrides = {}) {
  return client.request('/api/framepick/orders', {
    method: 'POST',
    body: { filmId: 'demo-film-3', requestId: 'request-1', ...overrides },
  });
}

test('catalogue is public and contains only isolated demo products with server prices', async (t) => {
  const { client } = await service(t);
  const response = await client().request('/api/framepick/orders/catalogue');
  assert.equal(response.status, 200);
  assert.equal(response.json.demo, true);
  assert.equal(response.json.products.length, 2);
  assert.deepEqual(response.json.products.map((item) => item.amountCents), [300, 500]);
  assert.ok(response.json.products.every((item) => item.demo && item.saleStatus === 'available'));
  assert.ok(response.json.products.every((item) => item.rightsVersion && item.authorizationDays > 0));
  assert.ok(DEMO_CATALOGUE.every((item) => item.id.startsWith('demo-')));
  assert.ok(response.json.products.every((item) => !['xianggu', 'jinhaitang', 'yanran'].includes(item.id)));
});

test('order reads and writes require an account; anonymous browsing catalogue still works', async (t) => {
  const { client } = await service(t);
  const anonymous = client();
  assert.equal((await anonymous.request('/api/framepick/orders')).status, 401);
  assert.equal((await createOrder(anonymous)).status, 401);
  assert.equal((await anonymous.request('/api/framepick/orders/catalogue')).status, 200);
});

test('server determines amount and sale status even when the browser tampers with price', async (t) => {
  const { client, root } = await service(t);
  const viewer = client();
  await viewer.register();
  const response = await createOrder(viewer, { amountCents: 1, saleStatus: 'available', rightsVersion: 'forged' });
  assert.equal(response.status, 201);
  assert.equal(response.json.order.amountCents, 300);
  assert.equal(response.json.order.currency, 'CNY');
  assert.equal(response.json.order.state, 'unpaid');
  assert.equal(response.json.order.rightsVersion, DEMO_CATALOGUE[0].rightsVersion);
  assert.equal(response.json.order.simulation, true);
  assert.equal(response.json.order.entitlement.active, false);
  const stored = JSON.parse(await readFile(path.join(root, 'orders', 'orders.json'), 'utf8'));
  assert.equal(stored.orders[0].amountCents, 300);
  assert.equal(stored.orders[0].accountId, response.json.order.accountId);
  assert.equal(stored.orders[0].realPayment, false);
});

test('real free catalogue films and unknown products cannot be sold as demo goods', async (t) => {
  const { client } = await service(t);
  const viewer = client();
  await viewer.register();
  for (const filmId of ['xianggu', 'jinhaitang', 'unknown']) {
    const response = await createOrder(viewer, { filmId });
    assert.equal(response.status, 404);
  }
});

test('request ids and repeat purchases are idempotent; cancelled orders can be recreated', async (t) => {
  const { client } = await service(t);
  const viewer = client();
  await viewer.register();
  const first = await createOrder(viewer);
  const repeated = await createOrder(viewer, { amountCents: 1 });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.json.order.id, first.json.order.id);
  const conflict = await createOrder(viewer, { filmId: 'demo-film-5' });
  assert.equal(conflict.status, 409);
  const sameFilmAnotherKey = await createOrder(viewer, { requestId: 'request-2' });
  assert.equal(sameFilmAnotherKey.status, 200);
  assert.equal(sameFilmAnotherKey.json.order.id, first.json.order.id);
  assert.equal((await viewer.request('/api/framepick/orders')).json.total, 1);

  const cancelled = await viewer.request(`/api/framepick/orders/${first.json.order.id}/cancel`, { method: 'POST', body: {} });
  assert.equal(cancelled.json.order.state, 'canceled');
  const recreated = await createOrder(viewer, { requestId: 'request-3' });
  assert.equal(recreated.status, 201);
  assert.notEqual(recreated.json.order.id, first.json.order.id);
});

test('confirming and paid simulation are recoverable and repeated callbacks grant only one right and event', async (t) => {
  const { client, root } = await service(t);
  const viewer = client();
  await viewer.register();
  const created = await createOrder(viewer);
  const id = created.json.order.id;
  const confirming = await viewer.request(`/api/framepick/orders/${id}/simulate`, { method: 'POST', body: { outcome: 'confirming' } });
  assert.equal(confirming.json.order.state, 'confirming');
  assert.equal(confirming.json.order.entitlement.active, false);
  const fetched = await viewer.request(`/api/framepick/orders/${id}`);
  assert.equal(fetched.json.order.state, 'confirming');

  for (let index = 0; index < 3; index += 1) {
    const paid = await viewer.request(`/api/framepick/orders/${id}/simulate`, { method: 'POST', body: { outcome: 'paid' } });
    assert.equal(paid.status, 200);
    assert.equal(paid.json.order.state, 'paid');
    assert.equal(paid.json.order.entitlement.active, true);
    assert.ok(paid.json.order.entitlement.endsAt);
  }
  const stored = JSON.parse(await readFile(path.join(root, 'orders', 'orders.json'), 'utf8'));
  assert.equal(stored.entitlements.length, 1);
  assert.equal(stored.simulationEvents.length, 1);
  assert.equal(stored.simulationEvents[0].kind, 'simulated-paid');
  assert.equal(stored.simulationEvents[0].amountCents, 300);
});

test('failed and cancelled orders have no rights and stale callbacks cannot downgrade or revive them', async (t) => {
  const { client, root } = await service(t);
  const viewer = client();
  await viewer.register();
  const first = await createOrder(viewer);
  const failed = await viewer.request(`/api/framepick/orders/${first.json.order.id}/simulate`, { method: 'POST', body: { outcome: 'failed' } });
  assert.equal(failed.json.order.state, 'failed');
  assert.equal(failed.json.order.entitlement.active, false);
  const paid = await viewer.request(`/api/framepick/orders/${first.json.order.id}/simulate`, { method: 'POST', body: { outcome: 'paid' } });
  assert.equal(paid.json.order.state, 'paid');
  const staleFailure = await viewer.request(`/api/framepick/orders/${first.json.order.id}/simulate`, { method: 'POST', body: { outcome: 'failed' } });
  assert.equal(staleFailure.json.order.state, 'paid');
  assert.equal(staleFailure.json.order.entitlement.active, true);
  assert.equal((await viewer.request(`/api/framepick/orders/${first.json.order.id}/cancel`, { method: 'POST', body: {} })).status, 409);

  const second = await createOrder(viewer, { filmId: 'demo-film-5', requestId: 'request-cancel' });
  await viewer.request(`/api/framepick/orders/${second.json.order.id}/cancel`, { method: 'POST', body: {} });
  const latePaid = await viewer.request(`/api/framepick/orders/${second.json.order.id}/simulate`, { method: 'POST', body: { outcome: 'paid' } });
  assert.equal(latePaid.json.order.state, 'canceled');
  assert.equal(latePaid.json.order.entitlement.active, false);
  const stored = JSON.parse(await readFile(path.join(root, 'orders', 'orders.json'), 'utf8'));
  assert.equal(stored.entitlements.length, 1);
  assert.equal(stored.simulationEvents.length, 1);
});

test('refund, expiry and delisting move rights without granting them twice', async (t) => {
  const { client, root } = await service(t);
  const viewer = client();
  await viewer.register();

  // 退款：退款中权益保留，退款完成后收回；之后可以重新下单（新订单）。
  const first = await createOrder(viewer);
  const firstId = first.json.order.id;
  await viewer.request(`/api/framepick/orders/${firstId}/simulate`, { method: 'POST', body: { outcome: 'paid' } });
  const refunding = await viewer.request(`/api/framepick/orders/${firstId}/simulate`, { method: 'POST', body: { outcome: 'refunding' } });
  assert.equal(refunding.json.order.state, 'refunding');
  assert.equal(refunding.json.order.entitlement.active, true);
  const refunded = await viewer.request(`/api/framepick/orders/${firstId}/simulate`, { method: 'POST', body: { outcome: 'refunded' } });
  assert.equal(refunded.json.order.state, 'refunded');
  assert.equal(refunded.json.order.entitlement.active, false);
  const again = await createOrder(viewer, { requestId: 'repurchase-after-refund' });
  assert.equal(again.status, 201);
  assert.notEqual(again.json.order.id, firstId);

  // 授权到期：权益收回，到期回调不能复活旧权益。
  await viewer.request(`/api/framepick/orders/${again.json.order.id}/simulate`, { method: 'POST', body: { outcome: 'paid' } });
  const expired = await viewer.request(`/api/framepick/orders/${again.json.order.id}/simulate`, { method: 'POST', body: { outcome: 'expired' } });
  assert.equal(expired.json.order.state, 'expired');
  assert.equal(expired.json.order.entitlement.active, false);

  // 下架：订单保留、权益暂停；恢复后回到已购，且不重复发权益或事件。
  const third = await createOrder(viewer, { requestId: 'after-expiry' });
  await viewer.request(`/api/framepick/orders/${third.json.order.id}/simulate`, { method: 'POST', body: { outcome: 'paid' } });
  const gone = await viewer.request(`/api/framepick/orders/${third.json.order.id}/simulate`, { method: 'POST', body: { outcome: 'unavailable' } });
  assert.equal(gone.json.order.state, 'unavailable');
  assert.equal(gone.json.order.entitlement.active, true);
  const back = await viewer.request(`/api/framepick/orders/${third.json.order.id}/simulate`, { method: 'POST', body: { outcome: 'paid' } });
  assert.equal(back.json.order.state, 'paid');
  assert.equal(back.json.order.entitlement.active, true);

  const stored = JSON.parse(await readFile(path.join(root, 'orders', 'orders.json'), 'utf8'));
  assert.equal(stored.entitlements.length, 3);
  assert.equal(stored.simulationEvents.length, 3);
});

test('one account cannot read or mutate another account order', async (t) => {
  const { client } = await service(t);
  const owner = client();
  const other = client();
  await owner.register('owner@example.com');
  await other.register('other@example.com');
  const created = await createOrder(owner);
  const id = created.json.order.id;
  assert.equal((await other.request(`/api/framepick/orders/${id}`)).status, 404);
  assert.equal((await other.request(`/api/framepick/orders/${id}/simulate`, { method: 'POST', body: { outcome: 'paid' } })).status, 404);
  assert.equal((await other.request(`/api/framepick/orders/${id}/cancel`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await other.request('/api/framepick/orders')).json.total, 0);
});

test('orders survive a backend restart and a fresh login session', async (t) => {
  const { client, restartOrders } = await service(t);
  const firstDevice = client();
  await firstDevice.register();
  const created = await createOrder(firstDevice);
  await firstDevice.request(`/api/framepick/orders/${created.json.order.id}/simulate`, { method: 'POST', body: { outcome: 'paid' } });
  restartOrders();

  const secondDevice = client();
  const login = await secondDevice.request('/api/framepick/accounts/login', { method: 'POST', body: { email: 'viewer@example.com', password: PASSWORD } });
  assert.equal(login.status, 200);
  const list = await secondDevice.request('/api/framepick/orders?page=1&pageSize=10');
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 1);
  assert.equal(list.json.orders[0].id, created.json.order.id);
  assert.equal(list.json.orders[0].state, 'paid');
  assert.equal(list.json.orders[0].entitlement.active, true);
  assert.equal(list.json.orders[0].simulation, true);
});

test('order writes reject cross-site requests and invalid transitions or input', async (t) => {
  const { client, base } = await service(t);
  const viewer = client();
  await viewer.register();
  assert.equal((await createOrder(viewer, { requestId: '' })).status, 400);
  const created = await createOrder(viewer, { requestId: 'valid-request' });
  assert.equal((await viewer.request(`/api/framepick/orders/${created.json.order.id}/simulate`, { method: 'POST', body: { outcome: 'real-payment-success' } })).status, 400);
  const crossSite = await fetch(`${base}/api/framepick/orders/${created.json.order.id}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    body: '{}',
  });
  assert.equal(crossSite.status, 403);
});

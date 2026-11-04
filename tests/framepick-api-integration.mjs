import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createApi } = require('../server/framepick-api.cjs');
const { createAccountHandler } = require('../server/framepick-accounts.cjs');
const { createOrderHandler } = require('../server/framepick-orders.cjs');
const { createViewingHandler } = require('../server/framepick-viewing.cjs');
const { createFileStore } = require('../server/framepick-store.cjs');

const ORIGIN = 'https://highstrith.github.io';
const GOOD = 'correct-horse-battery';

async function service(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'framepick-api-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeFor = (area) => createFileStore({ dir: path.join(root, area) });
  const accounts = createAccountHandler({ store: storeFor('accounts'), allowedOrigin: ORIGIN });
  const orders = createOrderHandler({ accounts, store: storeFor('orders'), allowedOrigin: ORIGIN });
  const viewing = createViewingHandler({ accounts, store: storeFor('viewing'), allowedOrigin: ORIGIN });
  const api = createApi({ accounts, orders, viewing, allowedOrigin: ORIGIN });
  const server = http.createServer(async (req, res) => {
    if (!await api.handle(req, res)) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { method = 'GET', body, headers = {}, token } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, headers: response.headers, json: await response.json().catch(() => null) };
  };
  return { request };
}

test('preflight from the site origin is answered with the allowed headers', async (t) => {
  const { request } = await service(t);
  const response = await request('/api/framepick/accounts/session', {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(response.headers.get('access-control-allow-methods'), /POST/);
  assert.match(response.headers.get('access-control-allow-headers'), /authorization/);
});

test('preflight from any other origin is refused', async (t) => {
  const { request } = await service(t);
  const response = await request('/api/framepick/accounts/session', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('a bearer token signs in without any cookie', async (t) => {
  const { request } = await service(t);
  const registered = await request('/api/framepick/accounts/register', {
    method: 'POST', headers: { Origin: ORIGIN }, body: { email: 'a@example.com', password: GOOD, nickname: '阿甲' },
  });
  assert.equal(registered.status, 201);
  assert.match(registered.json.token, /^[a-f0-9]{32}\.[a-f0-9]{64}$/);

  const session = await request('/api/framepick/accounts/session', { headers: { Origin: ORIGIN }, token: registered.json.token });
  assert.equal(session.status, 200);
  assert.equal(session.json.signedIn, true);
  assert.equal(session.json.account.nickname, '阿甲');
  assert.equal(session.headers.get('access-control-allow-origin'), ORIGIN);
});

test('a tampered token is treated as signed out instead of a server error', async (t) => {
  const { request } = await service(t);
  const registered = await request('/api/framepick/accounts/register', {
    method: 'POST', headers: { Origin: ORIGIN }, body: { email: 'b@example.com', password: GOOD, nickname: '阿乙' },
  });
  const [id, signature] = registered.json.token.split('.');
  const forged = `${id}.${signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))}`;
  const session = await request('/api/framepick/accounts/session', { token: forged });
  assert.equal(session.status, 200);
  assert.equal(session.json.signedIn, false);
});

test('the same token authorises viewing records and orders', async (t) => {
  const { request } = await service(t);
  const registered = await request('/api/framepick/accounts/register', {
    method: 'POST', headers: { Origin: ORIGIN }, body: { email: 'c@example.com', password: GOOD, nickname: '阿丙' },
  });
  const token = registered.json.token;
  const viewing = await request('/api/framepick/viewing', { token, headers: { Origin: ORIGIN } });
  assert.equal(viewing.status, 200);
  const orders = await request('/api/framepick/orders', { token, headers: { Origin: ORIGIN } });
  assert.equal(orders.status, 200);
  const anonymous = await request('/api/framepick/orders', { headers: { Origin: ORIGIN } });
  assert.equal(anonymous.status, 401);
});

test('healthz reports the store without leaking credentials', async (t) => {
  const { request } = await service(t);
  const response = await request('/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, store: 'file', origin: ORIGIN });
});

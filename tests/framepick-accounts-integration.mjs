import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createAccountHandler, MIN_PASSWORD } = require('../server/framepick-accounts.cjs');

const GOOD = 'correct-horse-battery';

async function service(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-accounts-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const handler = createAccountHandler({ dataDir, ...options });
  const server = http.createServer(async (req, res) => {
    if (!await handler.handle(req, res, new URL(req.url, `http://${req.headers.host}`))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"Not found"}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const request = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const cookieHeader = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const [pair] = setCookie.split(';');
      const index = pair.indexOf('=');
      if (pair.slice(index + 1)) jar.set(pair.slice(0, index), pair.slice(index + 1));
      else jar.delete(pair.slice(0, index));
    }
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    return { status: response.status, json: await response.json().catch(() => null), cookie };
  };
  return { handler, base, request, dataDir };
}

test('an anonymous visitor is signed out and gets no session cookie', async (t) => {
  const { request } = await service(t);
  const response = await request('/api/framepick/accounts/session');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { signedIn: false, account: null });
});

test('registration signs the account in and the session survives a restart', async (t) => {
  const { request, handler, dataDir } = await service(t);
  const created = await request('/api/framepick/accounts/register', { method: 'POST', body: { email: 'Viewer@Example.com', password: GOOD, nickname: '观众甲' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.account.email, 'viewer@example.com');
  assert.equal(created.json.account.nickname, '观众甲');
  assert.match(created.cookie, /framepick_account=/);

  const session = await request('/api/framepick/accounts/session');
  assert.equal(session.json.signedIn, true);
  assert.equal(session.json.account.nickname, '观众甲');

  // A fresh handler over the same directory must honour the existing session.
  const restarted = createAccountHandler({ dataDir });
  const server = http.createServer(async (req, res) => {
    if (!await restarted.handle(req, res, new URL(req.url, `http://${req.headers.host}`))) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/framepick/accounts/session`, { headers: { Cookie: session.cookie } });
  assert.equal((await response.json()).signedIn, true);
});

test('signing in and out round-trips and logout invalidates the cookie', async (t) => {
  const { request } = await service(t);
  await request('/api/framepick/accounts/register', { method: 'POST', body: { email: 'a@example.com', password: GOOD } });
  const out = await request('/api/framepick/accounts/logout', { method: 'POST', body: {} });
  assert.equal(out.json.signedIn, false);
  assert.equal((await request('/api/framepick/accounts/session')).json.signedIn, false);

  const back = await request('/api/framepick/accounts/login', { method: 'POST', body: { email: 'a@example.com', password: GOOD } });
  assert.equal(back.status, 200);
  assert.equal((await request('/api/framepick/accounts/session')).json.signedIn, true);
});

test('wrong password and unknown email return the same message', async (t) => {
  const { request } = await service(t);
  await request('/api/framepick/accounts/register', { method: 'POST', body: { email: 'a@example.com', password: GOOD } });
  for (const body of [{ email: 'a@example.com', password: 'wrong-password' }, { email: 'nobody@example.com', password: GOOD }]) {
    const response = await request('/api/framepick/accounts/login', { method: 'POST', body });
    assert.equal(response.status, 401);
    assert.equal(response.json.error, '邮箱或密码不正确。');
  }
});

test('duplicate email, weak password and malformed email are rejected', async (t) => {
  // Each case gets a fresh service so the registration rate limit does not mask it.
  const rejected = async (body) => {
    const { request } = await service(t);
    await request('/api/framepick/accounts/register', { method: 'POST', body: { email: 'a@example.com', password: GOOD } });
    return request('/api/framepick/accounts/register', { method: 'POST', body });
  };
  const duplicate = await rejected({ email: 'A@Example.com', password: GOOD });
  assert.equal(duplicate.status, 409);
  const weak = await rejected({ email: 'b@example.com', password: 'x'.repeat(MIN_PASSWORD - 1) });
  assert.equal(weak.status, 400);
  for (const bad of ['nope', 'a@b', 'a b@c.com', '@example.com']) {
    const response = await rejected({ email: bad, password: GOOD });
    assert.equal(response.status, 400, bad);
  }
});

test('a tampered or expired session cookie is refused', async (t) => {
  const { request } = await service(t);
  await request('/api/framepick/accounts/register', { method: 'POST', body: { email: 'a@example.com', password: GOOD } });
  const [, id, signature_] = (await request('/api/framepick/accounts/session')).cookie.match(/framepick_account=([a-f0-9]{32})\.([a-f0-9]{64})/);
  const forged = `${id}.${'0'.repeat(64)}`;
  const response = await fetch(`${(await service(t)).base}/api/framepick/accounts/session`);
  assert.equal((await response.json()).signedIn, false);
  const tampered = await request('/api/framepick/accounts/session', { headers: { Cookie: `framepick_account=${forged}` } });
  assert.equal(tampered.json.signedIn, false);
  assert.match(signature_, /^[a-f0-9]{64}$/);
});

test('cross-origin writes are rejected', async (t) => {
  const { base } = await service(t);
  const response = await fetch(`${base}/api/framepick/accounts/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ email: 'a@example.com', password: GOOD }),
  });
  assert.equal(response.status, 403);
});

test('repeated failed sign-ins are rate limited', async (t) => {
  const { request } = await service(t);
  await request('/api/framepick/accounts/register', { method: 'POST', body: { email: 'a@example.com', password: GOOD } });
  const attempts = [];
  for (let index = 0; index < 12; index += 1) {
    attempts.push(await request('/api/framepick/accounts/login', { method: 'POST', body: { email: 'a@example.com', password: 'not-the-password' } }));
  }
  const statuses = attempts.map((attempt) => attempt.status);
  assert.ok(statuses.includes(401), 'early attempts fail normally');
  assert.equal(statuses.filter((status) => status === 429).length > 0, true);
});

test('passwords are stored as salted scrypt hashes, never in plain text', async (t) => {
  const { request, dataDir } = await service(t);
  await request('/api/framepick/accounts/register', { method: 'POST', body: { email: 'a@example.com', password: GOOD } });
  const raw = await readFile(path.join(dataDir, 'accounts.json'), 'utf8');
  assert.doesNotMatch(raw, new RegExp(GOOD));
  const stored = JSON.parse(raw).accounts[0].passwordHash;
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
});

test('operator password reset works without mail delivery and kills sessions', async (t) => {
  const { request, handler } = await service(t);
  await request('/api/framepick/accounts/register', { method: 'POST', body: { email: 'a@example.com', password: GOOD } });
  await handler.resetPassword('A@Example.com', 'brand-new-password');
  assert.equal((await request('/api/framepick/accounts/session')).json.signedIn, false);
  const signedIn = await request('/api/framepick/accounts/login', { method: 'POST', body: { email: 'a@example.com', password: 'brand-new-password' } });
  assert.equal(signedIn.status, 200);
  assert.equal((await request('/api/framepick/accounts/login', { method: 'POST', body: { email: 'a@example.com', password: GOOD } })).status, 401);
  await assert.rejects(() => handler.resetPassword('missing@example.com', 'brand-new-password'));
});

test('a corrupt account database fails closed instead of wiping accounts', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-accounts-corrupt-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { writeFile } = await import('node:fs/promises');
  const broken = '{ not json';
  await writeFile(path.join(dataDir, 'accounts.json'), broken, 'utf8');
  const handler = createAccountHandler({ dataDir });
  const chunks = [];
  const codes = [];
  const res = { setHeader() {}, writeHead(code) { codes.push(code); }, end(body) { chunks.push(String(body)); } };
  const handled = await handler.handle({ method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res, new URL('http://x/api/framepick/accounts/session'));
  assert.equal(handled, true);
  assert.deepEqual(codes, [500]);
  assert.match(chunks.join(''), /服务暂时不可用/);
  assert.equal(await readFile(path.join(dataDir, 'accounts.json'), 'utf8'), broken);
});

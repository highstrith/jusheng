import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createAccountHandler } = require('../server/framepick-accounts.cjs');
const { createCreatorHandler } = require('../server/framepick-creators.cjs');

const GOOD = 'correct-horse-battery';

async function service(t) {
  const accountsDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-creator-accounts-'));
  const creatorsDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-creator-store-'));
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-creator-library-'));
  t.after(() => Promise.all([
    rm(accountsDir, { recursive: true, force: true }),
    rm(creatorsDir, { recursive: true, force: true }),
    rm(libraryDir, { recursive: true, force: true }),
  ]));

  const accounts = createAccountHandler({ dataDir: accountsDir });
  const creators = createCreatorHandler({ dataDir: creatorsDir, libraryDataDir: libraryDir, accounts });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // Same order as the real servers: accounts, then creators, then 404.
    if (await accounts.handle(req, res, url)) return;
    if (await creators.handle(req, res, url)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"Not found"}');
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
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  const register = async (email) => {
    const response = await request('/api/framepick/accounts/register', { method: 'POST', body: { email, password: GOOD, nickname: email.split('@')[0] } });
    assert.equal(response.status, 201);
    return response.json.account;
  };
  const signOut = () => { jar.delete('framepick_account'); };

  return { creators, base, request, register, signOut };
}

const apply = (overrides = {}) => ({
  name: '张小千',
  contact: 'https://www.douyin.com/user/abc',
  intro: '一人包办导演、编剧与后期的 AI 影像作者。',
  aiUsage: '画面由自训练模型生成。',
  samples: ['https://www.douyin.com/video/7675665548755176758'],
  ...overrides,
});

const submit = (overrides = {}) => ({
  title: '归渊',
  author: '张小千',
  source: 'bilibili',
  sourceUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
  category: 'film',
  genres: ['scifi'],
  runtime: '42:10',
  synopsis: '深海观测站失联第 41 天。',
  materials: { completeFilm: true, previewUrl: 'https://www.bilibili.com/video/BV1xx411c7mD', aiUsage: '画面由自训练模型生成。', rightsEvidence: '授权确认邮件已存档。' },
  ...overrides,
});

test('an anonymous visitor is told to sign in before applying', async (t) => {
  const { request } = await service(t);
  const me = await request('/api/framepick/creators/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.json, { signedIn: false, account: null, application: null, isCreator: false });
  const applyResponse = await request('/api/framepick/creators/applications', { method: 'POST', body: apply() });
  assert.equal(applyResponse.status, 401);
  assert.match(applyResponse.json.error, /请先登录/);
});

test('a signed-in account can apply and then see its own application', async (t) => {
  const { request, register } = await service(t);
  await register('creator@example.com');
  const created = await request('/api/framepick/creators/applications', { method: 'POST', body: apply() });
  assert.equal(created.status, 201);
  assert.equal(created.json.application.status, 'submitted');
  assert.equal(created.json.application.name, '张小千');

  const mine = await request('/api/framepick/creators/applications/mine');
  assert.equal(mine.json.application.id, created.json.application.id);
  // The private review trail is not part of the creator's own view until written.
  assert.equal(mine.json.application.reviewNote, '');

  const me = await request('/api/framepick/creators/me');
  assert.equal(me.json.isCreator, false);
});

test('CRE-01: an unapproved creator cannot submit, and the reason is actionable', async (t) => {
  const { request, register, creators } = await service(t);
  const account = await register('creator@example.com');
  const created = await request('/api/framepick/creators/applications', { method: 'POST', body: apply() });
  const blocked = await request('/api/framepick/creators/submissions', { method: 'POST', body: submit() });
  assert.equal(blocked.status, 403);
  assert.match(blocked.json.error, /还在审核中/);

  // The operator approves, and the same account can now submit.
  creators.store.setApplicationStatus(created.json.application.id, 'reviewing', { actor: 'operator' });
  creators.store.setApplicationStatus(created.json.application.id, 'approved', { actor: 'operator' });
  const accepted = await request('/api/framepick/creators/submissions', { method: 'POST', body: submit() });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.json.submission.status, 'submitted');
  assert.equal(accepted.json.submission.title, '归渊');

  const list = await request('/api/framepick/creators/submissions/mine');
  assert.equal(list.json.submissions.length, 1);
  assert.equal(list.json.submissions[0].id, accepted.json.submission.id);
  const me = await request('/api/framepick/creators/me');
  assert.equal(me.json.isCreator, true);
  assert.equal(me.json.account.id, account.id);
});

test('a second account cannot see or use another creator\'s application', async (t) => {
  const { request, register, signOut } = await service(t);
  await register('one@example.com');
  await request('/api/framepick/creators/applications', { method: 'POST', body: apply() });
  signOut();
  await register('two@example.com');
  const mine = await request('/api/framepick/creators/applications/mine');
  assert.equal(mine.json.application, null);
  const submissions = await request('/api/framepick/creators/submissions/mine');
  assert.deepEqual(submissions.json.submissions, []);
});

test('CRE-02 / CRE-05: bad submissions are rejected with the field at fault', async (t) => {
  const { request, register, creators } = await service(t);
  await register('creator@example.com');
  const created = await request('/api/framepick/creators/applications', { method: 'POST', body: apply() });
  creators.store.setApplicationStatus(created.json.application.id, 'reviewing');
  creators.store.setApplicationStatus(created.json.application.id, 'approved');

  assert.equal((await request('/api/framepick/creators/submissions', { method: 'POST', body: submit({ materials: {} }) })).status, 400);
  const paid = await request('/api/framepick/creators/submissions', { method: 'POST', body: submit({ access: 'paid' }) });
  assert.equal(paid.status, 400);
  assert.match(paid.json.error, /必须先确认授权/);
});

test('applying is rate limited per account', async (t) => {
  const { request, register, creators } = await service(t);
  await register('creator@example.com');
  let last = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    last = await request('/api/framepick/creators/applications', { method: 'POST', body: apply() });
    // Reject each application so the account is free to apply again and the
    // limit is what eventually stops it.
    if (last.status === 201) creators.store.setApplicationStatus(last.json.application.id, 'rejected', { actor: 'test' });
  }
  assert.equal(last.status, 429);
  assert.match(last.json.error, /过于频繁/);
});

test('cross-site writes are refused', async (t) => {
  const { request, register } = await service(t);
  await register('creator@example.com');
  const crossSite = await request('/api/framepick/creators/applications', {
    method: 'POST',
    body: apply(),
    headers: { Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  assert.match(crossSite.json.error, /来源不受信任|不允许跨站/);
});

test('unknown creator routes are a clean 404, not a crash', async (t) => {
  const { request } = await service(t);
  const response = await request('/api/framepick/creators/nope');
  assert.equal(response.status, 404);
  assert.equal(response.json.error, 'Not found');
});

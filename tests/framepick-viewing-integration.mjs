import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createAccountHandler } = require('../server/framepick-accounts.cjs');
const { createViewingHandler } = require('../server/framepick-viewing.cjs');
const PASSWORD = 'correct-horse-battery';

const SNAPSHOT = { title: '糖果', poster: 'img/tangguo-640w.webp', author: 'DiDi_OK', kind: '科幻', source: 'bilibili' };

async function service(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'framepick-viewing-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const accounts = createAccountHandler({ dataDir: path.join(root, 'accounts') });
  let viewing = createViewingHandler({ accounts, dataDir: path.join(root, 'viewing') });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (await accounts.handle(req, res, url)) return;
    if (await viewing.handle(req, res, url)) return;
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
      return { status: response.status, json: await response.json().catch(() => null) };
    };
    const register = async (email = 'viewer@example.com') => {
      const response = await request('/api/framepick/accounts/register', { method: 'POST', body: { email, password: PASSWORD, nickname: '观众' } });
      assert.equal(response.status, 201);
    };
    return { request, register };
  }

  return {
    base,
    root,
    client,
    restartViewing() { viewing = createViewingHandler({ accounts, dataDir: path.join(root, 'viewing') }); },
  };
}

test('viewing reads and writes require an account', async (t) => {
  const { client } = await service(t);
  const anonymous = client();
  assert.equal((await anonymous.request('/api/framepick/viewing')).status, 401);
  assert.equal((await anonymous.request('/api/framepick/viewing/watched', { method: 'POST', body: { filmId: 'tangguo', watched: true } })).status, 401);
  assert.equal((await anonymous.request('/api/framepick/viewing/history', { method: 'POST', body: { filmId: 'tangguo', action: 'open' } })).status, 401);
});

test('watched flags set, clear and snapshot into history', async (t) => {
  const { client } = await service(t);
  const viewer = client();
  await viewer.register();
  const set = await viewer.request('/api/framepick/viewing/watched', { method: 'POST', body: { filmId: 'tangguo', watched: true, snapshot: SNAPSHOT } });
  assert.equal(set.status, 200);
  assert.equal(set.json.watched.length, 1);
  assert.equal(set.json.watched[0].filmId, 'tangguo');
  assert.equal(set.json.history.length, 1);
  assert.equal(set.json.history[0].title, '糖果');
  assert.equal(set.json.history[0].watched, true);

  const clear = await viewer.request('/api/framepick/viewing/watched', { method: 'POST', body: { filmId: 'tangguo', watched: false } });
  assert.equal(clear.json.watched.length, 0);
  assert.equal(clear.json.history[0].watched, false);
});

test('history keeps one row per film with open counts, and watch marks watched', async (t) => {
  const { client } = await service(t);
  const viewer = client();
  await viewer.register();
  await viewer.request('/api/framepick/viewing/history', { method: 'POST', body: { filmId: 'tangguo', action: 'open', snapshot: SNAPSHOT } });
  await viewer.request('/api/framepick/viewing/history', { method: 'POST', body: { filmId: 'tangguo', action: 'open', snapshot: SNAPSHOT } });
  const watch = await viewer.request('/api/framepick/viewing/history', { method: 'POST', body: { filmId: 'tangguo', action: 'watch', snapshot: SNAPSHOT } });
  assert.equal(watch.json.entry.opens, 3);
  assert.equal(watch.json.entry.watched, true);
  assert.equal(watch.json.watched.length, 1);
  assert.equal(watch.json.history.length, 1);
  assert.equal(watch.json.events.length, 3);
  assert.equal(watch.json.events[0].action, 'watch');
});

test('guest data merges once per film and later snapshots do not duplicate rows', async (t) => {
  const { client } = await service(t);
  const viewer = client();
  await viewer.register();
  const merged = await viewer.request('/api/framepick/viewing/merge', {
    method: 'POST',
    body: {
      watched: ['tangguo', 'lajizhan', 'not-a-valid-id!', 'tangguo'],
      history: [
        { filmId: 'tangguo', ...SNAPSHOT, firstAt: '2026-11-03T09:00:00.000Z', lastAt: '2026-11-03T09:05:00.000Z', opens: 2 },
        { filmId: 'lajizhan', title: '垃圾站', poster: 'img/lajizhan-640w.webp', author: 'DiDi_OK', kind: '科幻', source: 'bilibili', firstAt: '2026-11-03T08:00:00.000Z', lastAt: '2026-11-03T08:10:00.000Z', opens: 1 },
        { filmId: 'javascript:alert(1)', title: 'x' },
      ],
    },
  });
  assert.equal(merged.json.merged, 4);
  assert.equal(merged.json.watched.length, 2);
  assert.equal(merged.json.history.length, 2);
  const tangguo = merged.json.history.find((row) => row.filmId === 'tangguo');
  assert.equal(tangguo.opens, 2);

  const again = await viewer.request('/api/framepick/viewing/merge', {
    method: 'POST',
    body: { watched: ['tangguo'], history: [{ filmId: 'tangguo', ...SNAPSHOT, lastAt: '2026-11-03T10:00:00.000Z', opens: 1 }] },
  });
  assert.equal(again.json.merged, 0);
  assert.equal(again.json.history.length, 2);
  assert.equal(again.json.history.find((row) => row.filmId === 'tangguo').opens, 3);
});

test('history rows delete individually and in bulk; watched flags survive a bulk clear', async (t) => {
  const { client } = await service(t);
  const viewer = client();
  await viewer.register();
  await viewer.request('/api/framepick/viewing/history', { method: 'POST', body: { filmId: 'tangguo', action: 'watch', snapshot: SNAPSHOT } });
  await viewer.request('/api/framepick/viewing/history', { method: 'POST', body: { filmId: 'lajizhan', action: 'open', snapshot: { title: '垃圾站' } } });
  assert.equal((await viewer.request('/api/framepick/viewing')).json.watched.length, 1);
  const one = await viewer.request('/api/framepick/viewing/history/tangguo', { method: 'DELETE' });
  assert.equal(one.json.history.length, 1);
  // 单条移除同时清掉该作品的已看标记（与批量清空保留已看区分）。
  assert.equal(one.json.watched.length, 0);
  assert.equal(one.json.events.length, 1);
  // 给剩下的 lajizhan 打上已看，供批量清空用例验证「清历史、留标记」。
  await viewer.request('/api/framepick/viewing/watched', { method: 'POST', body: { filmId: 'lajizhan', watched: true, snapshot: { title: '垃圾站' } } });

  const all = await viewer.request('/api/framepick/viewing/history', { method: 'DELETE' });
  assert.equal(all.json.history.length, 0);
  assert.equal(all.json.events.length, 0);
  // 批量清空只清历史，保留已看标记。
  assert.equal(all.json.watched.length, 1);
  assert.equal(all.json.watched[0].filmId, 'lajizhan');
});

test('snapshots are sanitized: poster must be local img/ or http(s), control chars stripped', async (t) => {
  const { client, root } = await service(t);
  const viewer = client();
  await viewer.register();
  const response = await viewer.request('/api/framepick/viewing/history', {
    method: 'POST',
    body: {
      filmId: 'tangguo',
      action: 'open',
      snapshot: { title: '糖\u0007果<script>', poster: 'javascript:alert(1)', author: 'DiDi_OK', kind: '科幻'.repeat(50), source: 'vimeo' },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.entry.title, '糖果<script>');
  assert.equal(response.json.entry.poster, '');
  assert.equal(response.json.entry.kind.length, 60);
  assert.equal(response.json.entry.source, '');
  const stored = JSON.parse(await readFile(path.join(root, 'viewing', 'viewing.json'), 'utf8'));
  const record = Object.values(stored.accounts)[0];
  assert.equal(record.history.tangguo.poster, '');
});

test('invalid film ids and actions are rejected', async (t) => {
  const { client } = await service(t);
  const viewer = client();
  await viewer.register();
  assert.equal((await viewer.request('/api/framepick/viewing/watched', { method: 'POST', body: { filmId: 'Bad Id!', watched: true } })).status, 400);
  assert.equal((await viewer.request('/api/framepick/viewing/watched', { method: 'POST', body: { watched: true } })).status, 400);
  assert.equal((await viewer.request('/api/framepick/viewing/history', { method: 'POST', body: { filmId: 'tangguo', action: 'rewind' } })).status, 400);
});

test('one account cannot read another account viewing records', async (t) => {
  const { client } = await service(t);
  const owner = client();
  const other = client();
  await owner.register('owner@example.com');
  await other.register('other@example.com');
  await owner.request('/api/framepick/viewing/history', { method: 'POST', body: { filmId: 'tangguo', action: 'watch', snapshot: SNAPSHOT } });
  const theirs = await other.request('/api/framepick/viewing');
  assert.equal(theirs.json.watched.length, 0);
  assert.equal(theirs.json.history.length, 0);
  assert.equal((await other.request('/api/framepick/viewing/history/tangguo', { method: 'DELETE' })).json.history.length, 0);
});

test('viewing records survive a restart and restore on a second device', async (t) => {
  const { client, restartViewing } = await service(t);
  const firstDevice = client();
  await firstDevice.register();
  await firstDevice.request('/api/framepick/viewing/history', { method: 'POST', body: { filmId: 'tangguo', action: 'watch', snapshot: SNAPSHOT } });
  restartViewing();

  const secondDevice = client();
  const login = await secondDevice.request('/api/framepick/accounts/login', { method: 'POST', body: { email: 'viewer@example.com', password: PASSWORD } });
  assert.equal(login.status, 200);
  const restored = await secondDevice.request('/api/framepick/viewing');
  assert.equal(restored.json.watched.length, 1);
  assert.equal(restored.json.watched[0].filmId, 'tangguo');
  assert.equal(restored.json.history[0].title, '糖果');
  assert.equal(restored.json.history[0].watched, true);
});

test('cross-site writes are rejected', async (t) => {
  const { client, base } = await service(t);
  const viewer = client();
  await viewer.register();
  const crossSite = await fetch(`${base}/api/framepick/viewing/watched`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    body: '{"filmId":"tangguo","watched":true}',
  });
  assert.equal(crossSite.status, 403);
});

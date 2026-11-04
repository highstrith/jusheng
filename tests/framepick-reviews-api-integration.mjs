import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const modulePath = fileURLToPath(new URL('../server/framepick-reviews.cjs', import.meta.url));
const route = '/api/framepick/films/xianggu/reviews';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-reviews-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { createReviewHandler } = require(modulePath);
  let server;
  let base;
  const start = async () => {
    const handler = createReviewHandler({ dataDir, cooldownMs: 0, ...options });
    server = http.createServer(async (req, res) => {
      if (!await handler(req, res, new URL(req.url, `http://${req.headers.host}`))) {
        res.writeHead(404); res.end('not found');
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await start();
  t.after(stop);
  const request = async (url, { cookie, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(base + url, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
  };
  const session = async () => {
    const result = await request('/api/framepick/session');
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ['mode', 'nickname']);
    assert.equal(result.body.mode, 'guest');
    const setCookie = result.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    return setCookie.split(';')[0];
  };
  return { request, session, dataDir, origin: () => base, restart: async () => { await stop(); await start(); } };
}

function checkPublic(result, cookies) {
  assert.equal(result.status, 200);
  for (const review of [...result.body.reviews, result.body.yourReview].filter(Boolean)) {
    assert.deepEqual(Object.keys(review).sort(), ['createdAt', 'id', 'isMine', 'nickname', 'rating', 'text', 'updatedAt']);
    assert.match(review.id, /^[\w-]+$/);
  }
  for (const cookie of cookies) {
    for (const token of cookie.split('=')[1].split('.')) assert.ok(!result.text.includes(token));
  }
  assert.doesNotMatch(result.text, /visitorId|guestId|secret|signature/);
}

test('outbound ranking counts distinct guest/film/China days, shares totals and survives restart', async t => {
  const f = await fixture(t);
  const a = await f.session(), b = await f.session();
  const outbound = '/api/framepick/films/xianggu/outbound';
  assert.equal((await f.request(outbound, { method: 'POST', body: {} })).status, 401);
  assert.deepEqual((await f.request(outbound, { cookie: a, method: 'POST', body: {} })).body, { counted: true });
  assert.deepEqual((await f.request(outbound, { cookie: a, method: 'POST', body: {} })).body, { counted: false });
  assert.equal((await f.request(outbound, { cookie: b, method: 'POST', body: {} })).status, 200);
  const summary = await f.request('/api/framepick/outbound/summary');
  assert.equal(summary.body.metric, 'outbound-clicks');
  assert.equal(summary.body.films.find(f => f.filmId === 'xianggu').outboundClicks, 2);
  assert.equal(summary.body.films.find(f => f.filmId === 'yanran').outboundClicks, 0);
  assert.doesNotMatch(summary.text, /visitorId|nickname|secret|signature/);
  await f.restart();
  assert.equal((await f.request('/api/framepick/outbound/summary')).body.films.find(f => f.filmId === 'xianggu').outboundClicks, 2);
  assert.deepEqual((await f.request(outbound, { cookie: a, method: 'POST', body: {} })).body, { counted: false });
  // Outbound activity must not consume the review rate limit or change its count.
  assert.equal((await f.request(route, { cookie: a, method: 'POST', body: { rating: 9 } })).status, 200);
  assert.equal((await f.request('/api/framepick/summary')).body.films.find(f => f.filmId === 'xianggu').ratingCount, 1);
  assert.equal((await f.request('/api/framepick/outbound/summary')).body.films.find(f => f.filmId === 'xianggu').outboundClicks, 2);
});

test('outbound window is ten China calendar days with midnight dedupe reset and old/future days excluded', async t => {
  let time = Date.parse('2026-10-23T15:59:00Z'); // China October 23.
  const f = await fixture(t, { clock: () => time });
  const cookie = await f.session();
  const outbound = '/api/framepick/films/xianggu/outbound';
  const click = () => f.request(outbound, { cookie, method: 'POST', body: {} });
  assert.equal((await click()).body.counted, true);
  time = Date.parse('2026-10-23T16:01:00Z'); // China October 24.
  assert.equal((await click()).body.counted, true);
  time = Date.parse('2026-11-01T16:01:00Z'); // China November 2.
  assert.equal((await click()).body.counted, true);
  let summary = (await f.request('/api/framepick/outbound/summary')).body;
  assert.equal(summary.windowStart, '2026-10-24');
  assert.equal(summary.windowEnd, '2026-11-02');
  assert.equal(summary.films.find(f => f.filmId === 'xianggu').outboundClicks, 2);
  time = Date.parse('2026-11-02T16:01:00Z'); // China November 3, oldest falls out.
  summary = (await f.request('/api/framepick/outbound/summary')).body;
  assert.equal(summary.films.find(f => f.filmId === 'xianggu').outboundClicks, 1);
  time = Date.parse('2026-10-23T16:01:00Z'); // Clock correction must not count future records.
  summary = (await f.request('/api/framepick/outbound/summary')).body;
  assert.equal(summary.films.find(f => f.filmId === 'xianggu').outboundClicks, 1);
});

test('outbound endpoint rejects untrusted origins, unknown films, methods and oversized input', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  const outbound = '/api/framepick/films/xianggu/outbound';
  assert.equal((await f.request(outbound, { cookie, method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.request('/api/framepick/films/unknown/outbound', { cookie, method: 'POST', body: {} })).status, 404);
  assert.equal((await f.request(outbound, { cookie })).status, 405);
  assert.equal((await f.request(outbound, { cookie, method: 'POST', body: 'x'.repeat(20000) })).status, 413);
  assert.equal((await f.request('/api/framepick/outbound/summary')).body.films.find(f => f.filmId === 'xianggu').outboundClicks, 0);
});

test('legacy review database upgrades without losing identity and concurrent outbound writes deduplicate atomically', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  assert.equal((await f.request(route, { cookie, method: 'POST', body: { text: '原有评价', rating: 8 } })).status, 200);
  const file = path.join(f.dataDir, 'reviews.json');
  const legacy = JSON.parse(await readFile(file, 'utf8'));
  delete legacy.outbound;
  await writeFile(file, JSON.stringify(legacy));
  await f.restart();
  assert.equal((await f.request(route, { cookie })).body.yourReview.text, '原有评价');
  const outbound = '/api/framepick/films/xianggu/outbound';
  const results = await Promise.all(Array.from({ length: 8 }, () => f.request(outbound, { cookie, method: 'POST', body: {} })));
  assert.ok(results.every(result => result.status === 200));
  assert.equal(results.filter(result => result.body.counted).length, 1);
  const other = await f.session();
  await Promise.all([
    f.request(outbound, { cookie: other, method: 'POST', body: {} }),
    f.request(route, { cookie, method: 'POST', body: { text: '并发更新评价', rating: 9 } }),
  ]);
  await f.restart();
  assert.equal((await f.request(route, { cookie })).body.yourReview.text, '并发更新评价');
  assert.equal((await f.request('/api/framepick/outbound/summary')).body.films.find(f => f.filmId === 'xianggu').outboundClicks, 2);
});

test('independent guest sessions share reviews and aggregate only ratings; updates and deletes own one review', async t => {
  const f = await fixture(t);
  const a = await f.session(), b = await f.session();
  assert.notEqual(a, b);
  assert.equal((await f.request(route)).body.yourReview, null);
  let result = await f.request(route, { cookie: a, method: 'POST', body: { nickname: '阿甲', text: '镜头很好', rating: 8 } });
  checkPublic(result, [a, b]);
  const id = result.body.yourReview.id, createdAt = result.body.yourReview.createdAt;
  assert.equal(result.body.total, 1);
  assert.equal(result.body.averageRating, 8);
  assert.equal(result.body.yourReview.isMine, true);
  result = await f.request(route, { cookie: b });
  assert.equal(result.body.reviews[0].isMine, false);
  assert.equal(result.body.yourReview, null);
  await f.request(route, { cookie: b, method: 'POST', body: { nickname: '阿乙', text: '只写评论', rating: null } });
  result = await f.request(route, { cookie: a, method: 'POST', body: { nickname: '新昵称', text: '', rating: 10 } });
  assert.equal(result.body.total, 2);
  assert.equal(result.body.ratingCount, 1);
  assert.equal(result.body.averageRating, 10);
  assert.equal(result.body.yourReview.id, id);
  assert.equal(result.body.yourReview.createdAt, createdAt);
  assert.equal((await f.request('/api/framepick/session', { cookie: a })).body.nickname, '新昵称');
  await f.request('/api/framepick/films/yanran/reviews', { cookie: a, method: 'POST', body: { rating: 4 } });
  const summary = (await f.request('/api/framepick/summary')).body.films;
  assert.deepEqual(summary.find(film => film.filmId === 'xianggu'), { filmId: 'xianggu', averageRating: 10, ratingCount: 1, commentCount: 1 });
  assert.equal(summary.find(film => film.filmId === 'yanran').averageRating, 4);
  assert.equal(summary.find(film => film.filmId === 'jinhaitang').averageRating, null);
  result = await f.request(route, { cookie: a, method: 'DELETE' });
  assert.equal(result.body.yourReview, null);
  assert.equal(result.body.total, 1);
  assert.equal(result.body.averageRating, null);
  assert.equal(result.body.reviews[0].nickname, '阿乙');
  assert.equal((await f.request(route, { cookie: a, method: 'DELETE' })).body.total, 1);
});

test('reviews and signed identity survive handler restart; data files are private', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  await f.request(route, { cookie, method: 'POST', body: { nickname: '持久', text: '重启还在', rating: 7 } });
  await f.restart();
  const result = await f.request(route, { cookie });
  assert.equal(result.body.yourReview.text, '重启还在');
  assert.equal(result.body.ratingCount, 1);
  assert.equal((await f.request('/api/framepick/session', { cookie })).body.nickname, '持久');
  assert.equal((await stat(path.join(f.dataDir, 'reviews.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(f.dataDir, 'cookie-key'))).mode & 0o777, 0o600);
  assert.equal((await f.request('/api/works')).status, 404);
  assert.equal((await f.request('/server/framepick-reviews.cjs')).status, 404);
});

test('invalid inputs, unknown films, absent/tampered cookies and oversized bodies cannot alter stored reviews', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  const badCookie = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  assert.equal((await f.request(route, { method: 'POST', body: { rating: 8 } })).status, 401);
  assert.equal((await f.request(route, { cookie: badCookie, method: 'POST', body: { rating: 8 } })).status, 401);
  assert.equal((await f.request(route, { cookie: 'framepick_guest=%invalid', method: 'DELETE' })).status, 401);
  assert.equal((await f.request(route, { cookie: `${cookie}; ${cookie}`, method: 'DELETE' })).status, 401);
  const recovered = await f.request('/api/framepick/session', { cookie: badCookie });
  assert.equal(recovered.status, 200);
  assert.notEqual(recovered.headers.get('set-cookie').split(';')[0], cookie);
  for (const body of [{}, [], null, { rating: 0 }, { rating: 11 }, { rating: 2.5 }, { rating: '8' },
    { rating: true }, { text: 3 }, { text: ' '.repeat(5) }, { text: 'a'.repeat(1001) },
    { nickname: '名'.repeat(25), rating: 8 }, { nickname: {}, rating: 8 }, '{bad json']) {
    const result = await f.request(route, { cookie, method: 'POST', body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(typeof result.body.error, 'string');
  }
  assert.equal((await f.request(route, { cookie, method: 'POST', body: 'a'.repeat(17000) })).status, 413);
  assert.equal((await f.request(route, { cookie, method: 'POST', body: '{"rating":8}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/framepick/films/missing/reviews')).status, 404);
  assert.equal((await f.request(route + '?offset=-1')).status, 400);
  assert.equal((await f.request(route + '?offset=1.1')).status, 400);
  assert.equal((await f.request(route, { method: 'PUT' })).status, 405);
  assert.equal((await f.request(route)).body.total, 0);
});

test('cross-origin requests are denied by default and one explicitly allowed origin receives credentialed CORS', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'null' }]) {
    const result = await f.request(route, { cookie, method: 'POST', body: { rating: 8 }, headers });
    assert.equal(result.status, 403);
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await f.request('/api/framepick/session', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.request(route, { cookie, method: 'POST', body: { rating: 8 }, headers: { Origin: f.origin(), 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  const g = await fixture(t, { allowedOrigin: 'https://frontend.example' });
  const preflight = await g.request(route, { method: 'OPTIONS', headers: {
    Origin: 'https://frontend.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://frontend.example');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  const gc = await g.session();
  assert.equal((await g.request(route, { cookie: gc, method: 'POST', body: { rating: 8 }, headers: { Origin: 'https://frontend.example' } })).status, 200);
  assert.equal((await g.request(route, { cookie: gc, method: 'DELETE', headers: { Origin: 'https://other.example' } })).status, 403);
});

test('serialized concurrent writes retain every guest, paginate 20 and keep yourReview outside current page', async t => {
  const f = await fixture(t);
  const cookies = await Promise.all(Array.from({ length: 26 }, () => f.session()));
  const results = await Promise.all(cookies.map((cookie, i) => f.request(route, { cookie, method: 'POST', body: { nickname: `客${i}`, rating: 6, text: `评价${i}` } })));
  results.forEach(result => assert.equal(result.status, 200));
  const first = await f.request(route);
  assert.equal(first.body.total, 26);
  assert.equal(first.body.reviews.length, 20);
  const last = await f.request(route + '?offset=20', { cookie: cookies[0] });
  assert.equal(last.body.reviews.length, 6);
  assert.equal(last.body.yourReview.nickname, '客0');
  assert.equal(last.body.ratingCount, 26);
  await Promise.all(Array.from({ length: 8 }, (_, i) => f.request(route, { cookie: cookies[0], method: 'POST', body: { rating: 9, text: `更新${i}` } })));
  await f.restart();
  const persisted = await f.request(route, { cookie: cookies[0] });
  assert.equal(persisted.body.total, 26);
  assert.equal(persisted.body.ratingCount, 26);
  assert.equal(persisted.body.yourReview.rating, 9);
});

test('short per-guest cooldown applies to writes without blocking other guests or reads', async t => {
  const f = await fixture(t, { cooldownMs: 1000 });
  const a = await f.session(), b = await f.session();
  assert.equal((await f.request(route, { cookie: a, method: 'POST', body: { rating: 8 } })).status, 200);
  const result = await f.request(route, { cookie: a, method: 'DELETE' });
  assert.equal(result.status, 429);
  assert.ok(Number(result.headers.get('retry-after')) >= 1);
  assert.equal((await f.request(route, { cookie: b, method: 'POST', body: { rating: 4 } })).status, 200);
  assert.equal((await f.request(route, { cookie: a })).status, 200);
});

test('a corrupt persisted database fails closed and is never overwritten with an empty database', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  await f.request(route, { cookie, method: 'POST', body: { rating: 8 } });
  assert.ok((await readdir(f.dataDir)).includes('reviews.json'));
  const corrupt = '{"version":1,"reviews":"corrupt"}';
  await writeFile(path.join(f.dataDir, 'reviews.json'), corrupt);
  await f.restart();
  assert.equal((await f.request(route)).status, 503);
  assert.equal((await f.request(route, { cookie, method: 'POST', body: { rating: 4 } })).status, 503);
  assert.equal(await readFile(path.join(f.dataDir, 'reviews.json'), 'utf8'), corrupt);
});

test('a corrupt signing key does not silently rotate identity or rewrite durable reviews', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  await f.request(route, { cookie, method: 'POST', body: { rating: 8 } });
  const before = await readFile(path.join(f.dataDir, 'reviews.json'), 'utf8');
  await writeFile(path.join(f.dataDir, 'cookie-key'), 'bad-key');
  await f.restart();
  assert.equal((await f.request('/api/framepick/session', { cookie })).status, 503);
  assert.equal(await readFile(path.join(f.dataDir, 'cookie-key'), 'utf8'), 'bad-key');
  assert.equal(await readFile(path.join(f.dataDir, 'reviews.json'), 'utf8'), before);
});

test('chunked requests are bounded even without a Content-Length header', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  const result = await new Promise((resolve, reject) => {
    const req = http.request(f.origin() + route, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.write('a'.repeat(9000));
    req.end('b'.repeat(9000));
  });
  assert.equal(result.status, 413);
  assert.equal(typeof result.body.error, 'string');
  assert.equal((await f.request(route)).body.total, 0);
});

test('standalone process only serves API on loopback with an isolated external data directory', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-standalone-test-'));
  const child = spawn(process.execPath, [modulePath], { env: { ...process.env, PORT: '0', FRAMEPICK_REVIEWS_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } await rm(dataDir, { recursive: true, force: true }); });
  const output = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('standalone did not start')), 5000);
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; if (/http:\/\/127\.0\.0\.1:\d+/.test(text)) { clearTimeout(timer); resolve(text); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`standalone exited ${code}`)); });
  });
  const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  assert.equal((await fetch(base + '/api/framepick/summary')).status, 200);
  assert.equal((await fetch(base + '/')).status, 404);
  assert.equal((await fetch(base + '/api/works')).status, 404);
});

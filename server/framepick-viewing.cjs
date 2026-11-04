'use strict';
// Framepick viewing records: which films an account has watched, and when it
// opened them. Guests keep everything in the browser (localStorage); signing in
// moves the same data behind the account so a device change can restore it —
// the same split the demo orders use.
//
// - 'watched' is a per-film flag the visitor sets (or that a jump to the
//   original platform sets automatically); it drives 已看 badges and the
//   hide-watched filter on the library page.
// - 'history' keeps one row per film (first seen, last seen, open count), plus
//   a capped event log. It powers the personal page's 观看历史.
// - Snapshots (title/poster/author/kind/source) are stored as sent so the
//   personal page can render rows without the catalogue; every field is
//   sanitized and size-capped first.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileStore } = require('./framepick-store.cjs');

const FILM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACTIONS = new Set(['open', 'watch']);
const SOURCES = new Set(['douyin', 'xiaohongshu', 'bilibili']);
const MAX_WATCHED = 200;
const MAX_HISTORY = 100;
const MAX_EVENTS = 200;
const POSTER = /^(?:img\/[A-Za-z0-9._-]{1,120}|https?:\/\/[^\s"'<>]{1,280})$/;

class ViewingError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ViewingError';
    this.status = status;
  }
}

function failure(status, message) {
  return new ViewingError(status, message);
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

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function cleanSnapshot(raw) {
  const poster = String(raw?.poster ?? '').trim();
  return {
    title: cleanText(raw?.title, 120),
    poster: POSTER.test(poster) ? poster : '',
    author: cleanText(raw?.author, 80),
    kind: cleanText(raw?.kind, 60),
    source: SOURCES.has(raw?.source) ? raw.source : '',
  };
}

function isoNow(clock) {
  return new Date(clock()).toISOString();
}

function createViewingHandler({
  accounts,
  dataDir = process.env.FRAMEPICK_VIEWING_DATA_DIR || path.join(os.homedir(), '.framepick', 'viewing'),
  allowedOrigin = process.env.FRAMEPICK_REVIEWS_ALLOWED_ORIGIN || '',
  clock = Date.now,
  store: providedStore = null,
} = {}) {
  if (!accounts || typeof accounts.resolveAccount !== 'function') throw new Error('createViewingHandler 需要 accounts.resolveAccount');
  const store = providedStore || createFileStore({ dir: dataDir });

  let db = { version: 1, accounts: {} };
  let ready = null;

  async function persist() {
    await store.write('viewing.json', `${JSON.stringify(db, null, 2)}\n`);
  }

  async function initialize() {
    const text = await store.read('viewing.json');
    if (text === null) {
      db = { version: 1, accounts: {} };
      await persist();
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.accounts !== 'object') throw new Error('bad shape');
      db = parsed;
    } catch (error) {
      throw new Error(`观看记录无法读取，已拒绝覆盖：${error.message}`);
    }
  }

  function recordOf(accountId) {
    if (!db.accounts[accountId]) db.accounts[accountId] = { watched: {}, history: {}, events: [] };
    const record = db.accounts[accountId];
    if (!record.watched) record.watched = {};
    if (!record.history) record.history = {};
    if (!Array.isArray(record.events)) record.events = [];
    return record;
  }

  function summarize(record) {
    const watched = Object.entries(record.watched)
      .map(([filmId, at]) => ({ filmId, at }))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    const history = Object.values(record.history)
      .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    return { watched, history, events: record.events.slice().reverse() };
  }

  function requireFilmId(value) {
    const filmId = typeof value === 'string' ? value.trim() : '';
    if (!FILM_ID.test(filmId)) throw failure(400, 'filmId 不合法。');
    return filmId;
  }

  function capCollections(record) {
    const watchedIds = Object.keys(record.watched)
      .sort((a, b) => (record.watched[a] < record.watched[b] ? 1 : -1));
    for (const id of watchedIds.slice(MAX_WATCHED)) delete record.watched[id];
    const historyIds = Object.keys(record.history)
      .sort((a, b) => (record.history[a].lastAt < record.history[b].lastAt ? 1 : -1));
    for (const id of historyIds.slice(MAX_HISTORY)) delete record.history[id];
    if (record.events.length > MAX_EVENTS) record.events = record.events.slice(-MAX_EVENTS);
  }

  async function setWatched(record, filmId, watched, snapshot) {
    const at = isoNow(clock);
    if (watched) record.watched[filmId] = at;
    else delete record.watched[filmId];
    const entry = record.history[filmId];
    if (entry) entry.watched = Boolean(watched);
    else if (watched && snapshot && snapshot.title) {
      record.history[filmId] = {
        filmId, ...snapshot, firstAt: at, lastAt: at, opens: 0, watched: true,
      };
    }
    capCollections(record);
    await persist();
  }

  async function recordEvent(record, filmId, action, snapshot) {
    const at = isoNow(clock);
    const entry = record.history[filmId] || {
      filmId, ...(snapshot || { title: '', poster: '', author: '', kind: '', source: '' }),
      firstAt: at, lastAt: at, opens: 0, watched: false,
    };
    if (snapshot && snapshot.title) {
      entry.title = snapshot.title || entry.title;
      entry.poster = snapshot.poster || entry.poster;
      entry.author = snapshot.author || entry.author;
      entry.kind = snapshot.kind || entry.kind;
      entry.source = snapshot.source || entry.source;
    }
    entry.lastAt = at;
    entry.opens += 1;
    if (action === 'watch') {
      entry.watched = true;
      record.watched[filmId] = at;
    }
    record.history[filmId] = entry;
    record.events.push({ id: `evt_${filmId}_${at}`, filmId, action, at });
    capCollections(record);
    await persist();
    return entry;
  }

  async function mergeGuestData(record, body) {
    const watchedIds = Array.isArray(body?.watched) ? body.watched : [];
    const historyEntries = Array.isArray(body?.history) ? body.history : [];
    let merged = 0;
    for (const value of watchedIds.slice(0, MAX_WATCHED)) {
      if (typeof value !== 'string' || !FILM_ID.test(value) || record.watched[value]) continue;
      record.watched[value] = isoNow(clock);
      merged += 1;
    }
    for (const raw of historyEntries.slice(0, MAX_HISTORY)) {
      if (!raw || typeof raw !== 'object') continue;
      const filmId = typeof raw.filmId === 'string' ? raw.filmId : '';
      if (!FILM_ID.test(filmId)) continue;
      const snapshot = cleanSnapshot(raw);
      const existing = record.history[filmId];
      if (!existing && snapshot.title) {
        record.history[filmId] = {
          filmId, ...snapshot,
          firstAt: cleanText(raw.firstAt, 40) || isoNow(clock),
          lastAt: cleanText(raw.lastAt, 40) || isoNow(clock),
          opens: Number.isSafeInteger(raw.opens) && raw.opens > 0 ? Math.min(raw.opens, 99) : 1,
          watched: Boolean(record.watched[filmId]),
        };
        merged += 1;
      } else if (existing) {
        existing.opens = Math.min(99, existing.opens + (Number.isSafeInteger(raw.opens) && raw.opens > 0 ? raw.opens : 1));
        const lastAt = cleanText(raw.lastAt, 40);
        if (lastAt && lastAt > existing.lastAt) existing.lastAt = lastAt;
      }
    }
    capCollections(record);
    await persist();
    return merged;
  }

  return {
    async handle(req, res, url) {
      const pathname = url.pathname;
      if (pathname !== '/api/framepick/viewing' && !pathname.startsWith('/api/framepick/viewing/')) return false;
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

        const account = await accounts.resolveAccount(req);
        if (!account) throw failure(401, '登录后才能在服务端保存观看记录；访客记录保存在本浏览器。');
        const record = recordOf(account.id);

        if (req.method === 'GET' && pathname === '/api/framepick/viewing') {
          sendJson(res, 200, summarize(record));
          return true;
        }

        if (req.method === 'POST' && pathname === '/api/framepick/viewing/watched') {
          const body = await readJsonBody(req);
          const filmId = requireFilmId(body.filmId);
          await setWatched(record, filmId, body.watched !== false, cleanSnapshot(body.snapshot));
          sendJson(res, 200, summarize(record));
          return true;
        }

        if (req.method === 'POST' && pathname === '/api/framepick/viewing/history') {
          const body = await readJsonBody(req);
          const filmId = requireFilmId(body.filmId);
          const action = body.action === 'watch' ? 'watch' : 'open';
          if (body.action !== undefined && !ACTIONS.has(body.action)) throw failure(400, 'action 只支持 open / watch。');
          const entry = await recordEvent(record, filmId, action, cleanSnapshot(body.snapshot));
          sendJson(res, 200, { entry, ...summarize(record) });
          return true;
        }

        if (req.method === 'POST' && pathname === '/api/framepick/viewing/merge') {
          const body = await readJsonBody(req);
          const merged = await mergeGuestData(record, body);
          sendJson(res, 200, { merged, ...summarize(record) });
          return true;
        }

        const single = pathname.match(/^\/api\/framepick\/viewing\/history\/([^/]+)$/);
        if (req.method === 'DELETE' && single) {
          const filmId = requireFilmId(decodeURIComponent(single[1]));
          // 移除单条 = 抹掉该作品的全部观看痕迹（含已看标记）；
          // 与「清空历史」区分——批量清空保留已看标记。
          delete record.history[filmId];
          delete record.watched[filmId];
          record.events = record.events.filter((event) => event.filmId !== filmId);
          capCollections(record);
          await persist();
          sendJson(res, 200, summarize(record));
          return true;
        }

        if (req.method === 'DELETE' && pathname === '/api/framepick/viewing/history') {
          record.history = {};
          record.events = [];
          capCollections(record);
          await persist();
          sendJson(res, 200, summarize(record));
          return true;
        }

        sendJson(res, 404, { error: 'Not found' });
        return true;
      } catch (error) {
        const status = error instanceof ViewingError ? error.status : 500;
        sendJson(res, status, { error: status === 500 ? '服务暂时不可用。' : error.message });
        if (status === 500) console.error(error);
        return true;
      }
    },
  };
}

module.exports = { createViewingHandler, ViewingError };

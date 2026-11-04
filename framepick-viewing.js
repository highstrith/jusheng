// Framepick viewing records (client): watched flags + open history.
//
// Guests keep everything in localStorage (this browser only). When the account
// service is reachable and the visitor signs in, the same data is merged into
// the account once and then read back from the server, so a device change can
// restore it. On GitHub Pages / file:// the module never fires a request and
// the localStorage copy is all there is — same gating as accounts and orders.
//
// Other modules integrate through window.FramepickViewing and the
// 'framepick:viewing' event (fired after every state change).
(() => {
  'use strict';

  const configured = String(window.FRAMEPICK_ACCOUNT_API || window.FRAMEPICK_REVIEW_API || '').trim();
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  let api = configured || (loopback && /^https?:$/.test(location.protocol) ? '/api/framepick' : '');
  try {
    if (api && !/^https?:$/.test(new URL(api, location.href).protocol)) api = '';
  } catch { api = ''; }
  api = api.replace(/\/+$/, '');
  // 会话 token 与账号模块共用同一个键：跨站请求带 Bearer，浏览器不再依赖第三方 Cookie。
  const SESSION_KEY = 'framepick:session:v1';
  function viewingAuthHeader() {
    try { const token = localStorage.getItem(SESSION_KEY); return token ? { Authorization: `Bearer ${token}` } : {}; } catch { return {}; }
  }


  const WATCHED_KEY = 'framepick:watched:v1';
  const HISTORY_KEY = 'framepick:history:v1';
  const MAX_HISTORY = 100;

  let watched = new Map();     // filmId -> at (ISO string)
  let history = new Map();     // filmId -> { filmId, title, poster, author, kind, source, firstAt, lastAt, opens, watched }
  let signedIn = false;
  let syncing = false;

  function emit() {
    window.dispatchEvent(new CustomEvent('framepick:viewing', { detail: state() }));
  }

  function state() {
    return {
      signedIn,
      online: Boolean(api),
      watched: [...watched.entries()].map(([filmId, at]) => ({ filmId, at })),
      history: [...history.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)),
    };
  }

  function readLocal() {
    try {
      const ids = JSON.parse(localStorage.getItem(WATCHED_KEY) || '[]');
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string' && !watched.has(id)) watched.set(id, '');
    } catch { /* private mode: keep what we have */ }
    try {
      const rows = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (Array.isArray(rows)) {
        for (const row of rows.slice(0, MAX_HISTORY)) {
          if (row && typeof row.filmId === 'string' && row.title && !history.has(row.filmId)) {
            history.set(row.filmId, sanitizeRow(row));
          }
        }
      }
    } catch { /* private mode */ }
  }

  function sanitizeRow(row) {
    return {
      filmId: String(row.filmId || '').slice(0, 64),
      title: String(row.title || '').slice(0, 120),
      poster: String(row.poster || '').slice(0, 300),
      author: String(row.author || '').slice(0, 80),
      kind: String(row.kind || '').slice(0, 60),
      source: ['douyin', 'xiaohongshu', 'bilibili'].includes(row.source) ? row.source : '',
      firstAt: String(row.firstAt || ''),
      lastAt: String(row.lastAt || ''),
      opens: Number.isSafeInteger(row.opens) && row.opens > 0 ? Math.min(row.opens, 99) : 1,
      watched: Boolean(row.watched),
    };
  }

  function writeLocal() {
    try {
      localStorage.setItem(WATCHED_KEY, JSON.stringify([...watched.keys()]));
      localStorage.setItem(HISTORY_KEY, JSON.stringify([...history.values()].slice(0, MAX_HISTORY)));
    } catch { /* private mode: memory only for this visit */ }
  }

  async function call(path, options = {}) {
    const response = await fetch(`${api}${path}`, {
      credentials: 'same-origin',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...viewingAuthHeader() },
      ...options,
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON error */ }
    if (!response.ok) {
      const error = new Error(payload?.error || '服务暂时不可用。');
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function adoptServer(data) {
    if (!data || typeof data !== 'object') return;
    const serverWatched = new Map();
    for (const row of Array.isArray(data.watched) ? data.watched : []) {
      if (row && typeof row.filmId === 'string') serverWatched.set(row.filmId, row.at || '');
    }
    const serverHistory = new Map();
    for (const row of Array.isArray(data.history) ? data.history : []) {
      if (row && typeof row.filmId === 'string' && row.title) serverHistory.set(row.filmId, sanitizeRow(row));
    }
    // Server is the source of truth while signed in; keep local-only rows too
    // (they merge back on the next sign-in) but never resurrect cleared flags.
    watched = new Map([...serverWatched, ...[...watched].filter(([id]) => !serverWatched.has(id) && !clearedRemotely.has(id))]);
    history = new Map([...serverHistory, ...[...history].filter(([id]) => !serverHistory.has(id))]);
  }

  // Flags cleared while signed in must not come back from a stale local copy.
  const clearedRemotely = new Set();

  async function sync(reason = 'load') {
    if (!api || syncing) return;
    syncing = true;
    try {
      if (!signedIn) {
        // 访客：记录只在本浏览器，无事可同步。
      } else if (reason === 'login' && (watched.size || history.size)) {
        // 刚登录：把访客副本一次性合并进账号，再以服务端为准。
        const data = await call('/viewing/merge', {
          method: 'POST',
          body: JSON.stringify({
            watched: [...watched.keys()],
            history: [...history.values()],
          }),
        });
        adoptServer(data);
      } else {
        const data = await call('/viewing');
        adoptServer(data);
      }
      writeLocal();
      emit();
    } catch { /* offline: local copy stays authoritative */ }
    syncing = false;
  }

  function snapshotOf(film) {
    if (!film) return {};
    return {
      title: film.title || '',
      poster: film.poster || '',
      author: film.author || '',
      kind: film.kind || '',
      source: film.source || '',
    };
  }

  function notifyServer(path, body) {
    if (!api || !signedIn) return;
    call(path, { method: 'POST', body: JSON.stringify(body) })
      .then((data) => { adoptServer(data); writeLocal(); emit(); })
      .catch(() => { /* local state already applied; server catches up next sync */ });
  }

  const FramepickViewing = {
    isWatched(id) { return watched.has(id); },
    watchCount() { return watched.size; },
    historyList() { return [...history.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)); },
    historyFor(id) { return history.get(id) || null; },

    markWatched(id, snapshot) {
      if (!id) return;
      const now = new Date().toISOString();
      watched.set(id, now);
      const row = history.get(id);
      if (row) row.watched = true;
      else if (snapshot && snapshot.title) {
        history.set(id, sanitizeRow({ ...snapshot, filmId: id, firstAt: now, lastAt: now, opens: 0, watched: true }));
      }
      clearedRemotely.delete(id);
      writeLocal();
      notifyServer('/viewing/watched', { filmId: id, watched: true, snapshot });
      emit();
    },

    unmarkWatched(id) {
      if (!id) return;
      watched.delete(id);
      clearedRemotely.add(id);
      const row = history.get(id);
      if (row) row.watched = false;
      writeLocal();
      notifyServer('/viewing/watched', { filmId: id, watched: false });
      emit();
    },

    // action: 'open' (detail dialog) or 'watch' (jump to the original platform).
    record(id, action, snapshot) {
      if (!id) return;
      const now = new Date().toISOString();
      const row = history.get(id) || sanitizeRow({ ...snapshot, filmId: id, firstAt: now, lastAt: now, opens: 0, watched: false });
      if (snapshot) {
        row.title = snapshot.title || row.title;
        row.poster = snapshot.poster || row.poster;
        row.author = snapshot.author || row.author;
        row.kind = snapshot.kind || row.kind;
        row.source = snapshot.source || row.source;
      }
      row.lastAt = now;
      row.opens += 1;
      if (action === 'watch') {
        row.watched = true;
        watched.set(id, now);
        clearedRemotely.delete(id);
      }
      history.set(id, row);
      if (history.size > MAX_HISTORY) {
        const oldest = [...history.values()].sort((a, b) => (a.lastAt < b.lastAt ? -1 : 1))[0];
        history.delete(oldest.filmId);
      }
      writeLocal();
      notifyServer('/viewing/history', { filmId: id, action: action === 'watch' ? 'watch' : 'open', snapshot });
      emit();
    },

    removeHistory(id) {
      if (!id) return;
      // 移除单条记录 = 抹掉该作品的观看痕迹，含已看标记。
      history.delete(id);
      watched.delete(id);
      clearedRemotely.add(id);
      writeLocal();
      if (api && signedIn) {
        call(`/viewing/history/${encodeURIComponent(id)}`, { method: 'DELETE' })
          .then((data) => { adoptServer(data); writeLocal(); emit(); })
          .catch(() => {});
      }
      emit();
    },

    clearHistory() {
      history.clear();
      writeLocal();
      if (api && signedIn) {
        call('/viewing/history', { method: 'DELETE' })
          .then((data) => { adoptServer(data); writeLocal(); emit(); })
          .catch(() => {});
      }
      emit();
    },

    snapshotOf,
    online() { return Boolean(api); },
    signedInAccount: () => signedIn,
    state,
  };

  window.FramepickViewing = FramepickViewing;

  readLocal();

  window.addEventListener('framepick:account', ({ detail }) => {
    const was = signedIn;
    signedIn = Boolean(detail?.signedIn);
    if (signedIn && !was) sync('login');
    else if (signedIn) sync('refresh');
    else emit();
  });

  if (api && !document.documentElement.dataset.framepickAccountReady) {
    // The account module may have dispatched its event before this script ran.
    fetch(`${api}/accounts/session`, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        signedIn = Boolean(data?.account);
        if (signedIn) sync('refresh');
        else emit();
      })
      .catch(() => emit());
  } else {
    emit();
  }
})();

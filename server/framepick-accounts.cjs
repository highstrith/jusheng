'use strict';
// Framepick accounts: registration, sign-in and sessions for the future purchase
// flow. PRD 7.2 leaves the sign-in channel open; this implements email + password
// because it needs no SMS or third-party provider and survives a device change.
// Password recovery is deliberately NOT implemented: no mail delivery is wired up,
// so the page points at the contact address and the operator resets via CLI.
//
// Accounts live outside the repository (default ~/.framepick/accounts) and are
// never published. Nothing here is shared with the visitor review cookie: a signed
// -in account does not claim or merge existing guest reviews (PRD 7.2, undecided).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileStore } = require('./framepick-store.cjs');

const COOKIE_NAME = 'framepick_account';
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const RATE_LIMITS = {
  login: { windowMs: 10 * 60 * 1000, limit: 8 },
  register: { windowMs: 60 * 60 * 1000, limit: 5 },
};

class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
  }
}

function failure(status, message) {
  return new AccountError(status, message);
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (error, key) => (error ? reject(error) : resolve(key)));
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(N), r: Number(r), p: Number(p) }, (error, key) => (error ? reject(error) : resolve(key)));
  });
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function createAccountHandler({
  dataDir = process.env.FRAMEPICK_ACCOUNTS_DATA_DIR || path.join(os.homedir(), '.framepick', 'accounts'),
  allowedOrigin = process.env.FRAMEPICK_REVIEWS_ALLOWED_ORIGIN || '',
  sessionDays = SESSION_DAYS,
  clock = Date.now,
  store: providedStore = null,
} = {}) {
  if (allowedOrigin) {
    const parsed = new URL(allowedOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== allowedOrigin) throw new Error('Allowed origin must be one exact HTTP(S) origin');
  }
  const store = providedStore || createFileStore({ dir: dataDir });
  const attempts = new Map();

  let db = { version: 1, accounts: [] };
  let sessions = { version: 1, sessions: [] };
  let secret = '';
  let ready = null;

  async function persist(name, value) {
    return store.write(name, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function readJson(name, label, valid) {
    const text = await store.read(name);
    if (text === null) return null;
    try {
      const value = JSON.parse(text);
      if (!valid(value)) throw new Error('bad shape');
      return value;
    } catch (error) {
      throw new Error(`${label}无法读取，已拒绝覆盖：${error.message}`);
    }
  }

  async function initialize() {
    const storedAccounts = await readJson('accounts.json', '账号数据', (value) => Array.isArray(value?.accounts));
    if (storedAccounts) {
      db = storedAccounts;
    } else {
      db = { version: 1, accounts: [] };
      await persist('accounts.json', db);
    }
    const storedSessions = await readJson('sessions.json', '会话数据', (value) => Array.isArray(value?.sessions));
    if (storedSessions) {
      sessions = storedSessions;
    } else {
      sessions = { version: 1, sessions: [] };
      await persist('sessions.json', sessions);
    }
    secret = await store.read('session-key');
    if (secret === null) {
      secret = crypto.randomBytes(32).toString('hex');
      const { created } = await store.create('session-key', secret);
      if (!created) secret = await store.read('session-key');
    }
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid session signing key');
  }

  const signature = (sessionId) => crypto.createHmac('sha256', secret).update(sessionId).digest('hex');

  // 登录态两种载体：同源用 Cookie，跨站（GitHub Pages → 函数计算）用 Bearer。
  // 跨站 Cookie 会被 Safari／微信按第三方 Cookie 丢掉，所以线上必须走 Bearer；
  // Cookie 保留给本机预览，两边签名与过期规则完全一致。
  function sessionToken(req) {
    const header = String(req.headers.authorization || '');
    const bearer = header.match(/^Bearer\s+([a-f0-9]{32}\.[a-f0-9]{64})$/i);
    if (bearer) return bearer[1];
    const matches = String(req.headers.cookie || '').split(';').map((value) => value.trim()).filter((value) => value.startsWith(`${COOKIE_NAME}=`));
    if (matches.length !== 1) return null;
    return matches[0].slice(COOKIE_NAME.length + 1);
  }

  function readSession(req) {
    const token = sessionToken(req);
    if (!token) return null;
    const matched = token.match(/^([a-f0-9]{32})\.([a-f0-9]{64})$/);
    if (!matched) return null;
    const [, sessionId, signed] = matched;
    const expected = Buffer.from(signature(sessionId), 'hex');
    const provided = Buffer.from(signed, 'hex');
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;
    const now = clock();
    const record = sessions.sessions.find((entry) => entry.id === sessionId && entry.expiresAt > now);
    if (!record) return null;
    const account = db.accounts.find((item) => item.id === record.accountId);
    return account ? { record, account } : null;
  }

  function setSessionCookie(req, res, sessionId, maxAge) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sessionId}.${signature(sessionId)}; Path=/api/framepick; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.socket.encrypted ? '; Secure' : ''}`);
  }

  function clearSessionCookie(req, res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/api/framepick; HttpOnly; SameSite=Lax; Max-Age=0${req.socket.encrypted ? '; Secure' : ''}`);
  }

  async function issueSession(accountId) {
    const id = crypto.randomBytes(16).toString('hex');
    const now = clock();
    sessions.sessions = sessions.sessions.filter((entry) => entry.expiresAt > now);
    sessions.sessions.push({ id, accountId, createdAt: new Date(now).toISOString(), expiresAt: now + sessionDays * 24 * 3600 * 1000 });
    await persist('sessions.json', sessions);
    return id;
  }

  // 部署在函数计算/反向代理后面时，socket 地址是实例地址，所有人共用一个限流桶；
  // 只有显式打开 FRAMEPICK_TRUST_PROXY 才采信转发头，避免本机被伪造成任意 IP。
  function clientIp(req) {
    if (process.env.FRAMEPICK_TRUST_PROXY === '1') {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
      const real = String(req.headers['x-real-ip'] || '').trim();
      if (real) return real;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function rateLimit(key, kind) {
    const rule = RATE_LIMITS[kind];
    const now = clock();
    const recent = (attempts.get(key) || []).filter((at) => now - at < rule.windowMs);
    if (recent.length >= rule.limit) {
      attempts.set(key, recent);
      throw failure(429, '尝试次数过多，请稍后再试。');
    }
    recent.push(now);
    attempts.set(key, recent);
    if (attempts.size > 5000) attempts.clear();
  }

  const publicAccount = (account) => ({ id: account.id, email: account.email, nickname: account.nickname, createdAt: account.createdAt });

  async function readJsonBody(req, maxBytes = 8192) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) throw failure(413, '请求内容过大。');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_) {
      throw failure(400, '请求格式不正确。');
    }
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function validateCredentials(body) {
    const email = normalizeEmail(body?.email);
    if (!EMAIL.test(email) || email.length > 200) throw failure(400, '请填写有效的邮箱地址。');
    const password = typeof body?.password === 'string' ? body.password : '';
    if (password.length < MIN_PASSWORD) throw failure(400, `密码至少 ${MIN_PASSWORD} 位。`);
    if (password.length > MAX_PASSWORD) throw failure(400, '密码过长。');
    return { email, password };
  }

  function validateNickname(body, email) {
    const raw = typeof body?.nickname === 'string' ? body.nickname.replace(/\s+/g, ' ').trim() : '';
    if (raw.length > 24) throw failure(400, '昵称最多 24 个字符。');
    return raw || email.split('@')[0].slice(0, 24);
  }

  return {
    dataDir,

    // Admin helper: password recovery has no mail delivery, so the operator resets.
    async resetPassword(email, password) {
      await ready;
      const normalized = normalizeEmail(email);
      const account = db.accounts.find((item) => item.email === normalized);
      if (!account) throw failure(404, '找不到该邮箱对应的账号。');
      if (String(password).length < MIN_PASSWORD) throw failure(400, `密码至少 ${MIN_PASSWORD} 位。`);
      account.passwordHash = await hashPassword(String(password));
      account.updatedAt = new Date(clock()).toISOString();
      sessions.sessions = sessions.sessions.filter((entry) => entry.accountId !== account.id);
      await persist('accounts.json', db);
      await persist('sessions.json', sessions);
      return publicAccount(account);
    },

    // Shared with other Framepick handlers so they never parse the cookie twice.
    async resolveAccount(req) {
      ready = ready || initialize();
      await ready;
      const found = readSession(req);
      return found ? publicAccount(found.account) : null;
    },

    async listAccounts() {
      await ready;
      return db.accounts.map(publicAccount);
    },

    async handle(req, res, url) {
      const pathname = url.pathname;
      if (pathname !== '/api/framepick/accounts' && !pathname.startsWith('/api/framepick/accounts/')) return false;
      res.setHeader('Vary', 'Origin');
      try {
        ready = ready || initialize();
        await ready;
        const origin = req.headers.origin;
        const ownOrigin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
        if (origin && origin !== ownOrigin && origin !== allowedOrigin) throw failure(403, '请求来源不受信任。');
        if (origin && origin === allowedOrigin) res.setHeader('Access-Control-Allow-Origin', origin);
        // SameSite=Lax already blocks cross-site cookies on writes; be explicit.
        if (req.method !== 'GET' && req.headers['sec-fetch-site'] === 'cross-site' && (!origin || origin !== allowedOrigin)) {
          throw failure(403, '不允许跨站提交。');
        }
        const ip = clientIp(req);

        if (req.method === 'GET' && pathname === '/api/framepick/accounts/session') {
          const found = readSession(req);
          sendJson(res, 200, { signedIn: Boolean(found), account: found ? publicAccount(found.account) : null });
          return true;
        }

        if (req.method === 'POST' && pathname === '/api/framepick/accounts/register') {
          rateLimit(`register:${ip}`, 'register');
          const body = await readJsonBody(req);
          const { email, password } = validateCredentials(body);
          if (db.accounts.some((item) => item.email === email)) throw failure(409, '该邮箱已注册，请直接登录。');
          const nickname = validateNickname(body, email);
          const now = clock();
          const account = {
            id: `acc_${crypto.randomBytes(12).toString('hex')}`,
            email,
            nickname,
            passwordHash: await hashPassword(password),
            createdAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
          };
          db.accounts.push(account);
          await persist('accounts.json', db);
          const sessionId = await issueSession(account.id);
          setSessionCookie(req, res, sessionId, sessionDays * 24 * 3600);
          sendJson(res, 201, { signedIn: true, token: `${sessionId}.${signature(sessionId)}`, account: publicAccount(account) });
          return true;
        }

        if (req.method === 'POST' && pathname === '/api/framepick/accounts/login') {
          const body = await readJsonBody(req);
          const { email } = validateCredentials(body);
          rateLimit(`login:${ip}:${email}`, 'login');
          const account = db.accounts.find((item) => item.email === email);
          const password = typeof body?.password === 'string' ? body.password : '';
          // Same message for unknown email and wrong password: no account enumeration.
          if (!account || !(await verifyPassword(password, account.passwordHash))) throw failure(401, '邮箱或密码不正确。');
          const sessionId = await issueSession(account.id);
          setSessionCookie(req, res, sessionId, sessionDays * 24 * 3600);
          sendJson(res, 200, { signedIn: true, token: `${sessionId}.${signature(sessionId)}`, account: publicAccount(account) });
          return true;
        }

        if (req.method === 'POST' && pathname === '/api/framepick/accounts/logout') {
          const found = readSession(req);
          if (found) {
            sessions.sessions = sessions.sessions.filter((entry) => entry.id !== found.record.id);
            await persist('sessions.json', sessions);
          }
          clearSessionCookie(req, res);
          sendJson(res, 200, { signedIn: false });
          return true;
        }

        sendJson(res, 404, { error: 'Not found' });
        return true;
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 500;
        sendJson(res, status, { error: status === 500 ? '服务暂时不可用。' : error.message });
        if (status === 500) console.error(error);
        return true;
      }
    },
  };
}

module.exports = { createAccountHandler, AccountError, COOKIE_NAME, MIN_PASSWORD };

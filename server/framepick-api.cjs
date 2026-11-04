'use strict';
// 函数计算（FC）入口：把账号、订单、观影三个 API 挂在一个 HTTP 服务上。
//
// 站点本身仍在 GitHub Pages；这里只负责 /api/framepick/*。数据写 OSS，进程内存
// 只做一份缓存，语义与本地 serve.js 一致（整份 JSON 读改写），因此函数的最大实例数
// 必须固定为 1，否则两个实例会互相覆盖。详见 docs/账号上线-函数计算.md。
const http = require('node:http');
const { createAccountHandler } = require('./framepick-accounts.cjs');
const { createOrderHandler } = require('./framepick-orders.cjs');
const { createViewingHandler } = require('./framepick-viewing.cjs');
const { createFileStore, createOssStore } = require('./framepick-store.cjs');
const { createOssClient } = require('./oss-client.cjs');

const DEFAULT_ORIGIN = 'https://highstrith.github.io';

function createStore(area, env) {
  if (String(env.FRAMEPICK_STORE || '').toLowerCase() !== 'oss') {
    return createFileStore({ dir: env.FRAMEPICK_DATA_DIR || `/tmp/framepick/${area}` });
  }
  const client = createOssClient({
    endpoint: env.OSS_ENDPOINT || 'https://oss-cn-hangzhou-internal.aliyuncs.com',
    bucket: env.OSS_BUCKET,
  });
  return createOssStore({ client, prefix: `${(env.OSS_PREFIX || 'framepick').replace(/\/+$/, '')}/${area}/` });
}

function createApi({ accounts, orders, viewing, allowedOrigin = DEFAULT_ORIGIN, store = 'file' }) {
  function corsHeaders(req) {
    if (!req.headers.origin || req.headers.origin !== allowedOrigin) return null;
    return {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const cors = corsHeaders(req);

    // 预检必须在各 handler 之前：它们只认自己的路径和方法，OPTIONS 会被当成 404。
    if (req.method === 'OPTIONS') {
      if (!req.headers.origin) { res.writeHead(403).end(); return true; }
      if (!cors) { res.writeHead(403).end(); return true; }
      res.writeHead(204, cors);
      res.end();
      return true;
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(cors || {}) });
      res.end(JSON.stringify({ ok: true, store, origin: allowedOrigin }));
      return true;
    }

    if (cors) for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);

    try {
      if (await accounts.handle(req, res, url)) return true;
      if (await orders.handle(req, res, url)) return true;
      if (await viewing.handle(req, res, url)) return true;
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Internal server error.' }));
      return true;
    }
    return false;
  }

  return { handle, allowedOrigin };
}

function fromEnv(env = process.env) {
  const allowedOrigin = env.FRAMEPICK_ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  const accounts = createAccountHandler({ store: createStore('accounts', env), allowedOrigin });
  const orders = createOrderHandler({ accounts, store: createStore('orders', env), allowedOrigin });
  const viewing = createViewingHandler({ accounts, store: createStore('viewing', env), allowedOrigin });
  return { api: createApi({ accounts, orders, viewing, allowedOrigin, store: env.FRAMEPICK_STORE || 'file' }), accounts, orders, viewing };
}

if (require.main === module) {
  const { api } = fromEnv();
  const port = Number(process.env.PORT || 9000);
  const server = http.createServer(async (req, res) => {
    if (!await api.handle(req, res)) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`Framepick API on :${port} (store ${process.env.FRAMEPICK_STORE || 'file'}, origin ${api.allowedOrigin})`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

module.exports = { createApi, fromEnv, DEFAULT_ORIGIN };

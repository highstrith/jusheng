'use strict';
// 存储适配层：把“一个 JSON 文件”抽象成“一个具名对象”，本地写磁盘、线上写 OSS。
//
// 为什么需要它：账号、订单、观影、评价四个模块原来都用 fs 读写 ~/.framepick/ 下的
// JSON 文件。站点是 GitHub Pages（纯静态），要让注册/登录真正能用，就得把这段
// 服务跑在函数计算上，而函数计算的本地磁盘是临时的 —— 数据必须落在 OSS。
//
// 语义刻意保持和原来一样：整份 JSON 读进来、改完、整份写回去。这依赖“同时只有一个
// 写者”，所以函数计算侧必须把最大实例数限制为 1（见 docs/账号上线-函数计算.md）。
// 换实例时从 OSS 冷启动读取，行为与本地进程重启一致。
const fs = require('node:fs');
const path = require('node:path');

function createFileStore({ dir }) {
  if (!dir) throw new Error('文件存储需要 dir');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = (name) => path.join(dir, name);

  async function read(name) {
    try {
      return await fs.promises.readFile(at(name), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function write(name, text) {
    const temporary = `${at(name)}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, text, { mode: 0o600 });
    await fs.promises.rename(temporary, at(name));
    return { created: true };
  }

  async function create(name, text) {
    try {
      await fs.promises.writeFile(at(name), text, { flag: 'wx', mode: 0o600 });
      return { created: true };
    } catch (error) {
      if (error.code === 'EEXIST') return { created: false };
      throw error;
    }
  }

  return { kind: 'file', dir, read, write, create };
}

function createOssStore({ client, prefix = 'framepick/' }) {
  if (!client) throw new Error('OSS 存储需要 client');
  const normalized = prefix.endsWith('/') || prefix === '' ? prefix : `${prefix}/`;

  async function read(name) {
    const found = await client.getText(`${normalized}${name}`);
    return found ? found.text : null;
  }

  async function write(name, text) {
    return client.putText(`${normalized}${name}`, text);
  }

  async function create(name, text) {
    return client.putText(`${normalized}${name}`, text, { forbidOverwrite: true });
  }

  return { kind: 'oss', prefix: normalized, read, write, create };
}

/**
 * 按环境变量选后端：
 *   FRAMEPICK_STORE=oss  → OSS（需要 OSS_BUCKET / OSS_ENDPOINT / 凭据）
 *   其他                  → 本地文件
 */
function createStoreFromEnv({ dir, env = process.env } = {}) {
  if (String(env.FRAMEPICK_STORE || '').toLowerCase() !== 'oss') return createFileStore({ dir });
  const { createOssClient } = require('./oss-client.cjs');
  const client = createOssClient({
    endpoint: env.OSS_ENDPOINT || 'https://oss-cn-hangzhou.aliyuncs.com',
    bucket: env.OSS_BUCKET,
  });
  return createOssStore({ client, prefix: env.OSS_PREFIX || 'framepick/' });
}

module.exports = { createFileStore, createOssStore, createStoreFromEnv };

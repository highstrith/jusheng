'use strict';
// 最小 OSS 客户端：只用 GET / PUT / DELETE，不引入 npm 依赖。
//
// 为什么手写：这个仓库没有 package.json，服务端代码一直是零依赖的纯 Node；
// 为了把账号数据放进 OSS 就引入 ali-oss（连同它的依赖树）不划算，而且我们要的
// 只有三个动词。签名用 OSS 的 V1（HMAC-SHA1），字段少、容易核对。
//
// 凭据两种来源，按顺序：
//   1. 环境变量 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET（本机备份、测试用）
//   2. 函数计算的服务角色：从 100.100.100.200 的元数据服务取 STS 临时凭据
// 第二种更安全：长期 AccessKey 不进代码、不进环境变量。
const crypto = require('node:crypto');

const META_HOST = 'http://100.100.100.200/latest/meta-data/ram/security-credentials/';
const CREDENTIAL_TTL_MS = 10 * 60 * 1000;

function gmtDate(date = new Date()) {
  return date.toUTCString();
}

function hmacSha1Base64(secret, text) {
  return crypto.createHmac('sha1', secret).update(text, 'utf8').digest('base64');
}

function normalizeHeaderValue(value) {
  return String(value == null ? '' : value).replace(/^\s+|\s+$/g, '');
}

/**
 * OSS V1 签名。CanonicalizedOSSHeaders 是全部 x-oss-* 头，名字小写、按字典序、每行以 \n 结尾。
 */
function signV1({ method, bucket, key, contentType = '', contentMd5 = '', date, ossHeaders = {}, accessKeyId, accessKeySecret }) {
  const lower = {};
  for (const [name, value] of Object.entries(ossHeaders)) {
    if (value === undefined) continue;
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('x-oss-')) lower[lowerName] = value;
  }
  const canonicalHeaders = Object.keys(lower).sort()
    .map((name) => `${name}:${normalizeHeaderValue(lower[name])}\n`).join('');
  const resource = `/${bucket}/${key || ''}`;
  const stringToSign = [method.toUpperCase(), contentMd5, contentType, date, canonicalHeaders + resource].join('\n');
  return { authorization: `OSS ${accessKeyId}:${hmacSha1Base64(accessKeySecret, stringToSign)}`, stringToSign };
}

function encodeKey(key) {
  return String(key).split('/').map((part) => encodeURIComponent(part)).join('/');
}

function endpointParts(endpoint) {
  const url = new URL(String(endpoint));
  if (!/^https?:$/.test(url.protocol)) throw new Error('OSS endpoint 必须是 http(s) 地址');
  return { host: url.host, protocol: url.protocol };
}

function createOssClient({
  endpoint,
  bucket,
  accessKeyId = process.env.OSS_ACCESS_KEY_ID || process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
  accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET || process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
  securityToken = process.env.OSS_SECURITY_TOKEN || process.env.ALIBABA_CLOUD_SECURITY_TOKEN,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  stsRoleName = process.env.OSS_STS_ROLE || 'framepick-api',
  metadataBase = META_HOST,
} = {}) {
  if (!endpoint) throw new Error('缺少 OSS endpoint');
  if (!bucket) throw new Error('缺少 OSS bucket');
  const parts = endpointParts(endpoint);
  const envCredentials = accessKeyId && accessKeySecret
    ? { accessKeyId, accessKeySecret, securityToken, expiresAt: Infinity } : null;
  let cached = null;

  async function credentials() {
    if (envCredentials) return envCredentials;
    if (cached && cached.expiresAt > clock() + 60 * 1000) return cached;
    const response = await fetchImpl(`${metadataBase}${encodeURIComponent(stsRoleName)}`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`取不到函数计算角色的临时凭据：HTTP ${response.status}`);
    const data = await response.json();
    cached = { accessKeyId: data.AccessKeyId, accessKeySecret: data.AccessKeySecret, securityToken: data.SecurityToken, expiresAt: clock() + CREDENTIAL_TTL_MS };
    return cached;
  }

  async function request(method, key, { body, contentType, contentMd5, headers = {} } = {}) {
    const creds = await credentials();
    const date = gmtDate(new Date(clock()));
    const ossHeaders = { ...headers };
    if (creds.securityToken) ossHeaders['x-oss-security-token'] = creds.securityToken;
    const { authorization } = signV1({
      method, bucket, key,
      contentType: contentType || '', contentMd5: contentMd5 || '', date, ossHeaders,
      accessKeyId: creds.accessKeyId, accessKeySecret: creds.accessKeySecret,
    });
    const url = `${parts.protocol}//${bucket}.${parts.host}/${encodeKey(key)}`;
    return fetchImpl(url, {
      method,
      headers: { Date: date, Authorization: authorization, ...(contentType ? { 'Content-Type': contentType } : {}), ...(contentMd5 ? { 'Content-MD5': contentMd5 } : {}), ...ossHeaders },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  }

  async function errorOf(response, action) {
    const text = await response.text().catch(() => '');
    const error = new Error(`OSS ${action} 失败：HTTP ${response.status} ${text.slice(0, 200)}`);
    error.status = response.status;
    error.code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1];
    return error;
  }

  return {
    bucket,
    endpoint,

    // 读不到返回 null，和本地文件后端对齐，调用方不用区分“文件不存在”和“对象不存在”。
    async getText(key) {
      const response = await request('GET', key);
      if (response.status === 404) return null;
      if (!response.ok) throw await errorOf(response, `读取 ${key}`);
      return { text: await response.text(), etag: response.headers.get('etag') };
    },

    async putText(key, text, { forbidOverwrite = false, contentType = 'application/json; charset=utf-8' } = {}) {
      const response = await request('PUT', key, {
        body: Buffer.from(text, 'utf8'),
        contentType,
        headers: forbidOverwrite ? { 'x-oss-forbid-overwrite': 'true' } : {},
      });
      if (response.status === 409 && forbidOverwrite) return { created: false };
      if (!response.ok) throw await errorOf(response, `写入 ${key}`);
      return { created: true };
    },

    async delete(key) {
      const response = await request('DELETE', key);
      if (response.status === 404) return false;
      if (!response.ok) throw await errorOf(response, `删除 ${key}`);
      return true;
    },
  };
}

module.exports = { createOssClient, signV1, gmtDate, encodeKey };

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createOssClient } = require('../server/oss-client.cjs');

test('Debian 11 FC role credentials sign OSS requests without accessing ECS metadata', async () => {
  const names = ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_SECURITY_TOKEN',
    'ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, { ALIBABA_CLOUD_ACCESS_KEY_ID: 'test-fc-role',
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'test-only-secret', ALIBABA_CLOUD_SECURITY_TOKEN: 'test-only-sts' });
    const calls = [];
    const client = createOssClient({ endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', bucket: 'jusheng-accounts',
      fetchImpl: async (url, options) => {
        assert.match(url, /^https:\/\/jusheng-accounts\./, 'must use FC environment credentials, not ECS metadata');
        calls.push(options);
        return new Response('{"version":1}', { status: 200 });
      } });
    assert.equal((await client.getText('framepick/accounts/accounts.json')).text, '{"version":1}');
    assert.match(calls[0].headers.Authorization, /^OSS test-fc-role:/);
    assert.equal(calls[0].headers['x-oss-security-token'], 'test-only-sts');
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

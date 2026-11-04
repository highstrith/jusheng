// Framepick account administration. No mail delivery is wired up, so password
// recovery is an operator action rather than a self-service flow (PRD 7.2).
//
//   node scripts/framepick-accounts-cli.mjs list
//   node scripts/framepick-accounts-cli.mjs reset <email> <new-password>
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAccountHandler } = require('../server/framepick-accounts.cjs');

const [command, ...rest] = process.argv.slice(2);
const handler = createAccountHandler({ dataDir: process.env.FRAMEPICK_ACCOUNTS_DATA_DIR });

const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

try {
  if (command === 'list') {
    print(await handler.listAccounts());
  } else if (command === 'reset') {
    const [email, password] = rest;
    if (!email || !password) throw new Error('用法：reset <email> <新密码>');
    print(await handler.resetPassword(email, password));
    console.log('已重置密码并结束该账号的全部会话。请通过已验证的渠道告知本人。');
  } else {
    console.log(`用法：
  list                        列出账号（不含密码）
  reset <email> <新密码>       重置密码并结束该账号会话（找回流程的人工环节）`);
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

# 安全模型：橘生梦厂（jusheng）

> 2026-11-11 初稿，根据代码与 `软件架构.md`、`docs/账号上线-函数计算.md` 整理。安全扫描会读取本文件；资产重要性、攻击者范围、可接受风险尚待维护者确认（见末节）。

## 组件与信任边界

| 组件 | 代码 | 运行位置 |
|---|---|---|
| **Jusheng-API** | `server/*.cjs`，入口 `server/framepick-api.cjs`；上线文件清单见 `scripts/pack-fc.sh` 的 `FILES` | 阿里云函数计算，主站经 `https://api.orangeaistudio.com/api/framepick` 调用，公网可达 |
| **Jusheng-Site** | 三张页面、根目录 `framepick*.js` / `review-config.js` / `site-mode.js`、`img/`；构建白名单 `scripts/build-site.sh`；`.github/workflows/pages.yml` | 主站阿里云香港 OSS，备份 GitHub Pages；纯静态 |
| **Jusheng-Tooling** | `scripts/`（片源发现、上架、周榜、发布） | 维护者本机 / CI，不对外暴露 |

- 浏览器 → API：CORS 只放行 `FRAMEPICK_ALLOWED_ORIGIN`（默认 `https://highstrith.github.io`）；无 Origin 或 Origin 不符的预检返回 403。
- 会话：HMAC-SHA256 签名的会话 id，HttpOnly Cookie（`SameSite=Lax`），同时以 Bearer token 存于浏览器 `localStorage`；有效期 30 天。
- API → OSS：函数计算注入的临时凭据，角色只可读写 `jusheng-accounts/*`（见 `软件架构.md`）。
- `server/framepick-creators.cjs`、`server/framepick-reviews.cjs` 不在上线清单中，目前只在本地 `node` 服务里可达。

## 入口与访问者

- 匿名互联网访问者：`/accounts/register`、`/accounts/login`、`/orders/catalogue`、`/healthz`、静态页面。
- 已登录用户：`/accounts/session|logout`、`/orders`、`/viewing/*`（只应读写自己的数据）。
- 维护者：`scripts/` 与发布流程。

## 资产

- 高：用户邮箱、scrypt 密码哈希、会话签名密钥、观看记录、订单记录；OSS / 函数计算凭据。
- 中：线上页面完整性（被篡改会影响所有访问者）。
- 低：公开片单数据。片库 `~/.framepick/library/library.json` 不在仓库内。

## 现有控制

- 密码：`crypto.scrypt` + `timingSafeEqual`；注册/登录按 `RATE_LIMITS` 限流。
- 订单为模拟支付（`realPayment: false`），金额与在售状态以服务端目录为准，忽略浏览器提交的金额。
- 发布产物只含 `scripts/build-site.sh` 白名单文件；`public/` 不进 Git。

## 待确认

- 哪些资产最重要、是否需要考虑「注册用户越权」之外的攻击者。
- 模拟支付流程是否视为不在范围。
- 部署相关配置（函数计算、OSS、域名、`../deploy-orange.sh`）不在本仓库，安全扫描看不到。

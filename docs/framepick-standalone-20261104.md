# 橘生梦厂独立成站记录

2026-11-04

拆了两次：上午把**发布产物**拆出去，下午把**源码**也拆出去。现在两边是彻底的两个项目。

## 两个站，两个仓库，两套源码

| | 橘生梦厂 | 作品集 |
|---|---|---|
| 地址 | https://highstrith.github.io/jusheng/ | https://highstrith.github.io/highstrithstate/ |
| 仓库 | `highstrith/jusheng` | `highstrith/highstrithstate` |
| 本地 | `/Volumes/E61--/网站/jusheng`（分支 `main`） | `/Volumes/E61--/网站/site-portfolio-upgrade`（分支 `release/white-pages`） |
| 内容 | 站点源文件 + 片库脚本 + 服务端 + 测试 + 文档 | index/projects/in-progress/resume + assets/data + admin |
| 预览 | `node serve.js` → `:3200` | `node serve.js` → `:3000` |
| 测试 | `./scripts/run-tests.sh` | `./scripts/run-portfolio-tests.sh` |
| 发布 | `./scripts/ship.sh "说明"` | `git push origin HEAD:main` |

**没有共享代码、没有同步脚本、没有 rsync。** 以前 `jusheng` 里不手改文件、全靠 `framepick-ship.sh` 从主仓库同步；现在 `jusheng` 就是 source of truth，直接在里面改、直接在里面提交。作品集那边只剩下首页的一个入口链接和三张推荐封面。

## 为什么拆

1. **数据分开算。** 30 天验证要算订阅转化率，分母必须只是来看片的人。原来作品集访客和片单访客混在一个域名下，H1 的数字是糊的。
2. **品牌分开。** 橘生梦厂是产品，作品集是履历，混在一起两边都不像。
3. **能退。** 验证不成立就把独立站归档，作品集删掉一个入口链接即可，不牵动作品页。
4. **改片单不该惊动作品集。** 一天要收十几部片，每次都得在两个仓库之间同步，产物和生活都容易被对方的历史绊住。

## 作品集这边改了什么

- 首页「推荐区」三张卡与入口按钮指向 `https://highstrith.github.io/jusheng/`，`target="_blank" rel="noopener"`
- 三张封面从 `reel/img/` 复制到 `assets/film-recommendation/`，作品集不再依赖片库目录
- 产品区文案与 i18n 从「帧选 / Framepick」改为「橘生梦厂 / Jusheng Mengchang」
- `pages.yml` 不再打包片库；产物里的 `/reel/` 只留一张跳转页，早前分享出去的链接不至于 404
- 顺手修掉一个老问题：三张卡的 `srcset` 挂着 `xianggu.webp 1280w` 等三个不存在的文件（线上一直 404），改为单 640w

## 橘生梦厂这边改了什么

- 站点根目录就是仓库根目录（以前是 `reel/`），`serve.js`、测试、脚本里的 `reel/` 路径假设全部去掉
- `scripts/build-site.sh` 是发布白名单的唯一出处：CI 和本地都跑它，产出 `public/`，`public/` 不进 git
- `scripts/run-tests.sh` 合并了原来 `--standalone` 分支，默认起 `:3200`
- 服务端 `server/*.cjs`（账号/订单/观看/评论/创作者）跟着搬过来，作品集的 `serve.js` 里对应的挂载点删掉了
- `AGENTS.md` 只写这边的规矩；作品集另有一份

## 发布流程

```
scripts/ship.sh "说明文字"
```

1. 刷抖音封面（`--with-douyin`）→ 封面构建（转 640w webp）
2. 上传当前 `img/` 图片到 OSS，逐张确认 HTTP 200；重建首页与片库页，跑校验与全量测试
3. `build-site.sh` 生成 `public/`，提交并推送 `main`
4. 等 Actions 跑完，复核线上卡片数

`--no-push` 只做到本地校验；`--fast` 跳过浏览器测试。

## 踩过的坑

**封面已恢复走 OSS（11-04 用户确认）。** 独立站拆出时遗漏了发布图片地址改写，曾全部走 Pages。现由 `build-site.sh` 将产物内的封面、片库数据和分享卡地址统一指向已有 OSS；本地源码仍使用 `img/xxx.webp`。`ship.sh` 先由本机 ossutil 上传与自检，CI 再无凭据检查公开图片可用性，凭据不进仓库或前端。

**exFAT 的 `._*` 伴生文件会污染新仓库。** `rsync -a`、`git init` 都会生成，`git fsck` 会读错。`.gitignore` 里加了 `._*`，同步/上传前统一 `find -name '._*' -delete`。

**两个站的本地预览端口不能撞。** 一开始都用 `:3100`，某一侧的测试跑到了另一侧的旧服务上，改了 CSS 却不生效，排查了半天。现在作品集 `:3000`、橘生梦厂 `:3200`。

**旧 `/reel/` 已 404。** 站外没有链接指向它，所以只留跳转页，不保留内容。

## 以后

- 绑自有域名（需要买域名 + 国内加速要备案）留到 30 天验证通过之后，现在不值得为它花钱。
- 访问统计直接在 `jusheng` 的 `index.html` 里加，不经过作品集。

# 帧选独立维护

- 日期：2026-11-02
- 状态：帧选目前仍在同一仓库的 `reel/` 下，但**已经按可拆分的边界在维护**。本文是帧选自己的维护入口，个人网站的事看仓库根目录的三份固定文档。
- 拆仓方案：[framepick-repo-split-20261102.md](../framepick-repo-split-20261102.md)（**方案，未执行**）

## 1. 帧选是什么

帧选 Framepick 是独立产品：AI 影像发现平台，方向是 40 分钟内优质 AI 电影的线上影院与创作者发行。

- 现在能做：免费原作发现、片库搜索筛选、三个榜单、访客评论与评分、前往原平台观看。
- 还没做：注册登录、单片购买、已购影院、站内放映、创作者投稿、运营后台。
- 口径以 [帧选 PRD](../framepick-prd-20261102.md) 为准，**不要拿个人网站的历史需求当帧选需求**。

## 2. 目录边界

帧选只拥有下面这些文件。它**不引用**个人网站的 `assets/`、`data/`、`admin.html`、`index.html`：

```
reel/                        站点内容（发布时整目录进 Pages，排除 img/raw/）
├── index.html
├── framepick.css
├── framepick.js             片库、详情、收藏
├── framepick-reviews.js     访客评价与评分
├── framepick-rankings.js    三个榜单
├── framepick-accounts.js    可选账号的登录入口与会话状态
├── review-config.js         共享服务地址配置
└── img/                     封面（img/raw/ 是母版，不发布）
server/
├── framepick-library.cjs    作品表／候选池／审核状态机／变更日志
├── framepick-accounts.cjs   账号：注册、登录、会话（scrypt + 签名 cookie）
├── framepick-reviews.cjs    评价 + 原作跳转统计（共享服务）
└── static-site.cjs          静态文件服务（与个人站共用）
serve-framepick.js           只服务帧选的本地预览
scripts/
├── run-framepick-tests.sh   帧选测试入口
├── check-framepick-library.mjs  片库字段校验
├── framepick-library-cli.mjs    片库后台命令（候选池、审片、上下架、日志）
├── build-framepick-library.mjs  由作品表生成静态片库页面
├── framepick-accounts-cli.mjs   账号管理（找回密码的人工环节）
└── prepare-media-cdn.mjs    发布时改媒体前缀
tests/
├── framepick-layout.py       测试用的布局适配
├── framepick-library-smoke.py
├── framepick-rankings-smoke.py
├── framepick-reviews-smoke.py
├── framepick-reviews-api-integration.mjs
└── framepick-library-store-integration.mjs
docs/framepick*               帧选专项文档
```

作品表、候选池与变更日志不在这里：它们在 `~/.framepick/library/`，页面由 `scripts/build-framepick-library.mjs` 生成。

## 3. 本地启动

两种启动方式，服务的是同一份 `reel/` 内容：

```sh
# 合并布局：个人站 + 帧选一起，帧选在 /reel/（与现在的线上一致）
node serve.js                     # http://localhost:3000/reel/

# 独立布局：只服务帧选，帧选就是站点根（拆仓后的样子）
node serve-framepick.js           # http://localhost:3100/
```

独立布局是刻意的：它验证「帧选不依赖个人站任何文件」，也是拆仓前的预演。

## 4. 测试

```sh
# 合并布局（默认），需要先起 node serve.js
scripts/run-framepick-tests.sh

# 独立布局：脚本自己起 serve-framepick.js，跑完自动关掉
scripts/run-framepick-tests.sh --standalone
```

覆盖范围：片库搜索／筛选／排序／详情／URL 恢复／无脚本、三个榜单、访客评价与评分、原作跳转统计、无横向溢出、Pages 打包。

环境变量：`PORT`、`STUDIO_BASE_URL`、`FRAMEPICK_BASE_PATH`（`/reel/` 或 `/`）、`FRAMEPICK_SITE_ROOT`（`index.html` 所在目录）。

单独跑某一份：

```sh
python3 -m unittest tests/framepick-library-smoke.py
node --test tests/framepick-reviews-api-integration.mjs
```

改片库后还要跑：`node scripts/check-framepick-library.mjs`。

**片库后台**：作品写在仓库外的作品表里，页面由表生成，补片不用改 HTML。

```sh
node scripts/framepick-library-cli.mjs list            # 看作品与状态
node scripts/framepick-library-cli.mjs candidate add --json '{...}'
node scripts/framepick-library-cli.mjs status <id> published --note "审片通过"
node scripts/framepick-library-cli.mjs build           # 重新生成页面
node scripts/framepick-library-cli.mjs log -n 20       # 变更记录
```

字段规范、状态机、补片清单见 [片库运营流程](../framepick-library-operations-20261102.md)。

## 5. 发布

**现在**：帧选随个人站一起发布。`.github/workflows/pages.yml` 只监听 `main`，把 `reel/`（排除 `img/raw/`）拷进发布产物。推 `main` 才上线，推其他分支不部署。细节见 [部署说明](../部署说明.md)。

**拆仓后**（未执行）：帧选有自己的 `pages.yml`，只拷 `index.html`、几个 JS/CSS、`img/`。执行步骤见拆仓方案第 12 节。

发布前必查：

1. `node scripts/check-framepick-library.mjs` 错误为 0。
2. `scripts/run-framepick-tests.sh` 全绿。
3. 线上 HTML 有 10 分钟缓存，改完要强刷才能看到新版本。

## 6. 数据与共享服务

- 评价与跳转数据在 `~/.framepick/reviews/reviews.json`，**站点根目录之外**，不进 Git、不进发布产物。
- 作品表与候选池在 `~/.framepick/library/library.json`，同样在仓库外。
- 账号在 `~/.framepick/accounts/`，密码只存 scrypt 哈希。三个目录都可以用对应的 `FRAMEPICK_*_DATA_DIR` 临时改指做演练。
- 正式 Pages **没有部署**这些 API，线上显示「未配置」或「尚未部署」。这是已知边界，不是故障；统计、评价或账号失败时，原作跳转照常可用。
- 运维细节、备份与降级：见 [片库运营流程](../framepick-library-operations-20261102.md) 第 5 节与 [账号说明](../framepick-accounts-20261102.md)。

## 7. 补片

改 `reel/index.html` 的作品卡。字段规范、补片清单、校验脚本：[片库运营流程](../framepick-library-operations-20261102.md)。阶段 B 才有后台，现在没有。

## 8. 关联文档

| 文档 | 内容 |
| --- | --- |
| [帧选 PRD](../framepick-prd-20261102.md) | 需求口径与阶段验收（唯一业务入口） |
| [片库运营流程](../framepick-library-operations-20261102.md) | 字段规范、补片清单、共享服务运维 |
| [拆仓方案](../framepick-repo-split-20261102.md) | 双仓库迁移方案（未执行） |
| [影院路线与片库更新](../framepick-cinema-roadmap-20261102.md) | 三榜规则与后续建设顺序 |
| [访客评价](framepick-guest-reviews-20261102/README.md) | 评价与评分实现 |
| [跳转榜](framepick-outbound-20261102/README.md) | 近 10 天原作跳转统计 |
| [OSS 媒体托管说明](../oss-cdn-20261101.md) | 封面存放与 CDN 变量 |

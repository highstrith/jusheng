# 帧选拆仓方案（建议稿，尚未执行）

- 版本：V1.0
- 日期：2026-11-02
- 状态：**方案，未执行**。本轮只产出方案与影响清单，不迁移任何仓库、不改动线上地址、不推送发布。
- 依据：`docs/framepick-prd-20261102.md` 第 14 节阶段 A「独立维护与免费发现」、第 15 节待决策项「工程拆分」。

> 结论先行：**建议拆**，但拆仓是单向成本较高的操作，且有两项前置决策未定（新仓库名、是否保留 Git 历史）。因此本轮只落地方案，等用户确认后再执行。

## 1. 为什么要拆

| 现状问题 | 拆开后 |
| --- | --- |
| 帧选与个人作品集共用一个 Pages 构建产物，任一站点改动都要跑对方的发布流程 | 两站各自 `main` 触发各自工作流，互不影响 |
| 帧选的相对路径被迫带 `reel/` 前缀，`canonical`、`og:image`、媒体 CDN 对象键都被这个前缀绑住 | 帧选成为站点根，路径即产品路径 |
| 帧选的评价／跳转 API 与个人站的上传管理 API 混在同一个 `serve.js` | 帧选只需自己的静态服务 + 共享评价服务 |
| 个人站的媒体（几百 MB 视频）与帧选的运营节奏不同，回滚要连带 | 回滚粒度变成单站 |

不拆也能继续做阶段 B／C（后台、账号、支付都不依赖仓库边界）。拆仓解决的是**维护与发布**问题，不是功能阻塞项。

## 2. 目标与非目标

**目标**

1. 帧选可独立启动、独立测试、独立发布，不依赖个人站仓库里的任何文件。
2. 个人站可独立发布，不因帧选改动而重新构建。
3. 旧地址 `/reel/` 有可见的过渡入口，不出现 404。
4. 免费片库、评价、近 10 天原作跳转榜在迁移后真实可用，数据不丢。

**非目标**

- 不迁移运营主体、不申请新域名（涉及备案与合规，属 PRD 第 15 节待决策项）。
- 不重写帧选的功能范围，不做本轮 PRD 阶段 A 之外的新功能。
- 不改写历史 Git 提交（见第 6 节，推荐方案不改写）。

## 3. 目标结构

- 新仓库：`highstrith/framepick`（**仓库名待用户确认**）
- 新线上地址：`https://highstrith.github.io/framepick/`
- 新仓库内，帧选就是站点根，`reel/` 这一层消失：

```
framepick/
├── index.html              原 reel/index.html
├── framepick.css
├── framepick.js
├── framepick-reviews.js
├── framepick-rankings.js
├── review-config.js
├── img/                    原 reel/img/（img/raw/ 母版不发布）
├── server/
│   └── framepick-reviews.cjs
├── tests/
│   ├── framepick-library-smoke.py
│   ├── framepick-reviews-smoke.py
│   ├── framepick-rankings-smoke.py
│   └── framepick-reviews-api-integration.mjs
├── scripts/
│   ├── prepare-media-cdn.mjs      （改写媒体前缀白名单，见第 5 节）
│   └── check-framepick-library.mjs（本轮新增的片源校验）
├── .github/workflows/pages.yml
├── docs/                    仅帧选相关文档
└── README.md                帧选独立维护入口
```

## 4. 文件归属

| 路径 | 归属 | 说明 |
| --- | --- | --- |
| `reel/index.html`、`reel/framepick*.js`、`reel/framepick.css`、`reel/review-config.js` | 帧选 | 升为站点根 |
| `reel/img/**` | 帧选 | `img/raw/` 母版留在仓库、不发布 |
| `server/framepick-reviews.cjs` | 帧选 | 共享评价／跳转服务 |
| `tests/framepick-*` | 帧选 | 其余测试留在个人站 |
| `docs/framepick*`、`docs/ai-film-discovery-trial-20261102/` | 帧选 | 历史专项说明随产品走 |
| `index.html` 中的帧选入口区块 | 个人站 | 只改外链指向新地址，区块本身不动 |
| `assets/**`、`data/**`、`admin.html`、`projects.html`、`resume.html`、`in-progress.html` | 个人站 | 帧选不引用其中任何文件（现状已满足） |
| `scripts/optimize-*`、`sync-work-catalogue.mjs` | 个人站 | 帧选无视频转码需求 |
| `scripts/prepare-media-cdn.mjs` | 两边各一份 | 帧选版只需媒体前缀白名单 |
| 三份固定文档 `产品需求.md`／`软件架构.md`／`当前进度.md` | 个人站保留全量；帧选另起自己的进度入口 | 帧选现行口径以 `docs/framepick-prd-20261102.md` 为准 |

## 5. 路径变更的影响清单（执行前必须逐项处理）

| 项 | 现在 | 拆仓后 | 处理动作 |
| --- | --- | --- | --- |
| 页面地址 | `…/highstrithstate/reel/` | `…/framepick/` | 旧地址放跳转页（第 7 节） |
| `canonical` | `…/highstrithstate/reel/` | `…/framepick/` | 改 `index.html` 一行 |
| `og:image` | `…/highstrithstate/reel/img/xianggu.webp` | `…/framepick/img/xianggu.webp` | 同上；**已分享出去的旧卡片缩略图无法回收**，属已知代价 |
| `og:url`（如后加） | — | — | 一并写入 |
| 媒体引用 | `img/xianggu.webp` | 不变（相对路径） | 无需改 |
| OSS 对象键 | `reel/img/…` | 需与站点路径一致才命中 | **见下** |
| `scripts/prepare-media-cdn.mjs` | 白名单正则 `/^(?:assets\/\|reel\/)/` | 帧选版改为 `/^(?:img\/\|assets\/)/` | 新仓库改这一行 |
| 评价／跳转 API 路径 | `/api/framepick/...` | 不变 | 无需改 |

### 5.1 媒体 CDN 的坑（最容易漏）

`scripts/prepare-media-cdn.mjs` 用**站点内相对路径**当作 OSS 对象键。拆仓后帧选的相对路径从 `reel/img/xianggu.webp` 变成 `img/xianggu.webp`，而 OSS 桶 `highstrith-assets` 里的对象键仍是 `reel/img/…`，发布时会去取 `img/…` → 404，整站封面全丢。

**处理方式（推荐，两站互不干扰）**

1. 在 OSS 桶内新建前缀 `framepick/`，把 `reel/img/` 下的发布用对象（3 张封面 + `-640w` 变体，几十 KB）复制到 `framepick/img/…`。**不要动 `reel/img/` 原有对象**，个人站还在用。
2. 帧选仓库的 `MEDIA_CDN_BASE_URL` 设为 `https://highstrith-assets.oss-cn-hangzhou.aliyuncs.com/framepick/`。
3. 帧选版 `prepare-media-cdn.mjs` 白名单正则改为 `/^(?:img\/|assets\/)/`。

**OSS 侧无需改动的部分**：CORS 按 origin 匹配（`https://highstrith.github.io`，不含路径），Referer 防盗链白名单条目 `https://highstrith.github.io/` 是前缀匹配，新路径 `…/framepick/` 仍被覆盖。两者都不用加条目。

**回滚**：把帧选的 `MEDIA_CDN_BASE_URL` 清空即可退回同源，OSS 上的 `framepick/` 前缀留着无害。

## 6. Git 历史怎么处理

| 方案 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| **A（推荐）** | 新仓库以当前文件状态做初始提交；原仓库打 tag `archive/framepick-pre-split-20261102` 后删除帧选文件 | 不动任何历史 hash；原仓历史完整可追溯；出错容易回退 | 新仓库看不到帧选的逐次提交过程 |
| B | `git filter-repo --path reel/ --path server/framepick-reviews.cjs --path tests/framepick-* --path docs/framepick*` 提取 | 新仓库保留相关提交历史 | 重写 hash；原仓需同步重写；`reel/` 早期是个人站片单，历史里混着非帧选内容，提取结果不干净 |
| C | `git filter-repo --subdirectory-filter reel/` | 新仓库根干净 | 丢失 `server/`、`tests/`、`docs/` 全部历史，等于半白 |

**推荐 A。** 帧选从 2026-11-02 起步，历史价值有限，完整追溯靠原仓库的归档 tag 就够了；方案 B／C 要重写公开仓库历史，风险与收益不成比例。

## 7. 旧入口过渡

GitHub Pages **不支持配置 301 重定向**，只能用页面级跳转。

1. 原仓库保留 `reel/`，内容替换为一个最小跳转页：`<meta http-equiv="refresh" content="0; url=https://highstrith.github.io/framepick/">` + 一段 `location.replace` + 一条**用户可点的可见链接**（`refresh` 被禁用时仍可用）。
2. 跳转页上明确写一句「帧选已搬到新地址，本页将在 X 后下线」，不沉默跳走。
3. 个人站 `index.html` 的帧选入口区块外链改为新地址；中英字典里的对应链接同步。
4. 保留期建议 **不少于 6 个月**，且至少覆盖一次个人站的正常发布周期。
5. 个人站发布工作流的白名单要继续带 `reel/`（只发这个跳转页），别在清理时误删。

**已知无法避免的代价**：搜索引擎与社交卡片里的旧链接会 404 或走 refresh；浏览器书签不受影响（跳转页承接）。这属于拆仓的固有成本，不是实现缺陷。

## 8. 共享服务与数据（好消息：基本不用动）

- 评价／跳转数据存在站点根目录之外的 `~/.framepick/reviews/reviews.json`，**与仓库无关**，拆仓不迁移、不丢失。
- 访客身份 cookie 是 `Path=/api/framepick`、不设 `Domain`、签名密钥同在数据目录。两个 Pages 站点同在 `highstrith.github.io` 这个 host 下，**cookie 与密钥都不变**，访客对已有评价的修改权在迁移后可延续。
- 若将来帧选迁到独立域名，则 cookie 身份会全部失效，需重新设计身份体系——所以**拆仓不换域名**是本次方案的重要前提。
- 提醒：正式 Pages 目前**没有部署**这个 API，线上仍是未配置状态。拆仓不解决部署问题，阶段 C 之前需要单独安排（PRD 12.10 已记录）。

## 9. 发布流程

新仓库 `.github/workflows/pages.yml` 相比现在大幅简化：

```
on: push: branches: ["main"]   # 与个人站同策略，只认 main
steps:
  - checkout
  - setup-node 22
  - 准备 public/：拷贝 index.html、framepick*.js、review-config.js、framepick.css
    rsync -a --exclude '/img/raw/' img/ public/img/
    touch public/.nojekyll
  - node scripts/prepare-media-cdn.mjs --site public   # 用帧选自己的 MEDIA_CDN_BASE_URL
  - configure-pages / upload-pages-artifact / deploy-pages
```

`concurrency: group: pages, cancel-in-progress: true` 保留（防并发覆盖）。注意这个 group 名在两个仓库里各自独立，不会互相取消。

## 10. 风险与回滚

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 媒体 CDN 前缀没改 | 全站封面 404 | 发布前先跑一次 `prepare-media-cdn.mjs` 打 dry-run 报告，核对对象键前缀 |
| 新仓库 Pages 未开启 | 新地址 404 | 先在仓库 Settings → Pages 选 GitHub Actions 来源，再推 main |
| 旧 `reel/` 被提前删掉 | 旧入口 404 | 跳转页先上线并验证，再清理原仓 |
| 两站进度文档分叉 | 口径不一致 | 帧选口径以 `docs/framepick-prd-20261102.md` 为唯一入口，个人站三份固定文档只记个人站 |
| 拆仓后发现评估错了 | — | 新仓可弃用，原仓从归档 tag 恢复 `reel/`；媒体双前缀并存，回滚只需清变量 |

## 11. 执行前必须确认的决策

1. **新仓库名**：`framepick` 还是 `framepick-site`？（决定线上地址，改一次要重新走一遍第 7 节过渡）
2. **历史方案**：确认采用方案 A（不保留提交历史）。
3. **执行时点**：建议在帧选下一次功能变更**之前**完成，避免两边同时改动产生合并成本。
4. **是否同步启用独立域名**：本方案默认否（涉及备案，且会打断第 8 节的 cookie 延续）。

## 12. 执行检查清单

拆仓当天按顺序做，每步可独立验证：

1. ☐ 建空仓库 `highstrith/framepick`，Settings → Pages → Source 选 GitHub Actions。
2. ☐ OSS 复制 `reel/img/` 发布用对象到 `framepick/img/`，核对数量与字节。
3. ☐ 新仓库初始提交：第 3 节目录结构；`prepare-media-cdn.mjs` 白名单改为 `/^(?:img\/|assets\/)/`。
4. ☐ 新仓库加 `.github/workflows/pages.yml`、`README.md`、`.gitignore`（含 `._*`）。
5. ☐ 新仓库配置 Variables：`MEDIA_CDN_BASE_URL=https://highstrith-assets.oss-cn-hangzhou.aliyuncs.com/framepick/`。
6. ☐ 本地用独立启动脚本（见帧选维护文档）启动，跑通帧选全部测试。
7. ☐ 推 `main`，等 Pages 任务 success，核对新地址页面、封面、OSS 请求前缀。
8. ☐ 推个人站：帧选外链改新地址；`reel/` 替换为跳转页；工作流白名单保留 `reel/`。
9. ☐ 验证旧地址跳转可达、新地址三个榜单正常、评价 API 状态如实显示。
10. ☐ 原仓库打 tag `archive/framepick-pre-split-20261102`，删除帧选源文件。
11. ☐ 更新两站的文档与 `当前进度.md`。

## 13. 关联

- 需求入口：[帧选 PRD](framepick-prd-20261102.md)（拆仓属阶段 A，待决策项「工程拆分」）
- 路线与补片：[影院路线与片库更新](framepick-cinema-roadmap-20261102.md)
- 评价／跳转服务：[访客评价](framepick-guest-reviews-20261102/README.md)、[跳转榜](framepick-outbound-20261102/README.md)
- 媒体与 OSS：[OSS 媒体托管说明](oss-cdn-20261101.md)、[部署说明](部署说明.md)
- 本轮同步产出：[帧选独立维护文档](framepick-standalone-20261102/README.md)

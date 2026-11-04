# 帧选搜片管道（2026-11-03）

解决"片源太少"：定时去公开平台搜新片，机器做初筛与复核，结果落到候选池并出报告；**上架始终由人决定**。

## 抓取后端：先用现成的，不自己写爬虫

| 方案 | 结论 |
| --- | --- |
| **bilibili-api-python 17.4.2**（默认） | ✅ 采用。B 站公开网页接口的封装，库自己处理 wbi 签名与 buvid，无需登录。一条搜索请求直接返回 `bvid／标题／UP 主／时长／播放量／发布时间／简介／标签`，不用解析 DOM |
| yt-dlp（`bilisearch`） | ❌ 试过。flat 模式只给 id；逐条取详情被 B 站 412 反爬拦下，需登录 cookie 才可能可用 |
| Playwright 渲染搜索页 | ⚠️ 保留为 `--backend browser` 兜底。能用，但依赖 B 站卡片 DOM，改版即失效，且 37 条要跑 3 分钟 |
| **ego-browser（抖音专用）** | ✅ 采用。抖音站内搜索必须登录，只能借用你已登录的浏览器会话；脚本 `scripts/framepick-discovery-douyin.js` 在你的窗口里读搜索结果卡片，不接管账号 |
| Scrapy / Crawlee | ➖ 不采用。它们是通用爬取框架，本场景只有一个有公开接口的站点，框架只增加活动部件 |
| Apify / Firecrawl 等托管服务 | ➖ 不采用。按量计费、数据出境，抖音 actor 同样要你的登录 cookie |

实测对比：同一批候选，API 后端 **约 2 秒／关键词**，浏览器后端 约 25 秒／关键词。

## 边界

| 环节 | 谁做 | 说明 |
| --- | --- | --- |
| 搜索 | 脚本（B 站公开接口 + 抖音浏览器会话） | 小红书尚未验证，只登记线索，不核实、不臆造 |
| 初筛 | `framepick-discovery-cli.mjs` | 时长 3–40 分钟、来源与链接匹配、排除教程／解说／合集／预告等、必须带 AI 制作属性证据、去重 |
| 复核 | 同上 `verify` | 打开原页比对标题与作者，判定链接是否失效 |
| 入池 | 同上 `add` | 写入候选池（站点外 `~/.framepick/library`），状态 `new` |
| 看片与上架 | **人** | `candidate convert` → `draft → reviewing → approved → scheduled → published` |

自动任务**不会**改 `reel/index.html`、不会提交、不会发布。

两种日期分开记：

- **原片发布日期**（`originalReleaseDate`）必须记录，是作品本身的属性，详情弹窗里显示（支持 `2026-10-20` / `2026-09` / `2026` 三种精度）。候选备注里也带一行「原片发布 …」。
- **收录日期**（`intakeDate`）只是运营内部字段：唯一用途是「今日更新」榜把当天收录的作品归到一组，**不进详情、不进榜单文案**，也不需要查证——入库时取当天即可。

## 依赖

```bash
python3 -m pip install bilibili-api-python curl_cffi   # 前者是 B 站接口封装，后者是它需要的 HTTP 客户端
```

浏览器兜底额外需要 `playwright`（项目测试已依赖，浏览器用系统 Chrome 即可）。

## 三块组成

- `docs/framepick-discovery-20261103/sources.json` —— 搜什么：关键词、平台状态、排除词、时长区间、AI 证据要求。
- `scripts/framepick-discovery-scan.py` —— 怎么搜（B 站）：`scan`（API 后端批量搜索）、`channel`（按 UP 主 mid 拉最新投稿）、`enrich`（重算 AI 证据，无需开页面）。
- `scripts/framepick-discovery-douyin.js` —— 怎么搜（抖音）：在你的 ego-browser 窗口里逐关键词读搜索结果卡片，输出与上面同格式的 JSON。
- `scripts/framepick-discovery-cli.mjs` —— 怎么筛和存：`plan / screen / add / verify / rescreen / report`。规则在 `scripts/framepick-discovery-rules.mjs`，与测试共用一份。

## 一次完整运行

```bash
cd /Volumes/E61--/网站/jusheng
node scripts/framepick-discovery-cli.mjs plan                                   # 本轮搜什么
python3 scripts/framepick-discovery-scan.py scan --out /tmp/fp-found.json --limit 15
node scripts/framepick-discovery-cli.mjs add --file /tmp/fp-found.json           # 初筛并入池
node scripts/framepick-discovery-cli.mjs verify                                  # 复核链接与元数据
node scripts/framepick-discovery-cli.mjs report                                  # 写 runs/*.md
```

监控已入库作者的新稿（mid 取自搜索结果的 `mid` 字段）：

```bash
python3 scripts/framepick-discovery-scan.py channel --mid 123456 --out /tmp/fp-channel.json --limit 20
node scripts/framepick-discovery-cli.mjs add --file /tmp/fp-channel.json
```

## 抖音：借你自己的浏览器会话

抖音站内搜索未登录只返回导航栏，所以这条路必须用你已经登录的浏览器。脚本只读公开搜索结果，
在你的 ego-browser 窗口里跑，不碰账号设置：

```bash
ego-browser nodejs < scripts/framepick-discovery-douyin.js     # → /tmp/framepick-douyin.json
node scripts/framepick-discovery-cli.mjs add --file /tmp/framepick-douyin.json
```

脚本读的字段只有：时长、播放量、标题与简介、作者、发布时间、链接；每关键词之间停 4.5 秒。
**不点赞、不关注、不评论、不私信、不下载原片、不改任何设置。**

登录态失效时脚本会提示「没有抓到结果」，把窗口交回本人登录后重跑即可
（`task.handOff()` 让窗口回到你手上，登完再跑一次）。关键词取自 `sources.json` 的 `queries`
前 6 条——ego-browser 的 nodejs 运行时收不到 shell 环境变量，别指望用环境变量换词。

## 人工收口

```bash
node scripts/framepick-library-cli.mjs candidate list              # 看候选池
node scripts/framepick-library-cli.mjs candidate convert <id> --file 作品.json
node scripts/framepick-library-cli.mjs status <作品id> reviewing --note "人工审片"
node scripts/framepick-library-cli.mjs build                       # 重新生成片库页面
```

排除词变长之后，用当前规则回扫一遍存量候选（默认只报告，`--apply` 才标成 `rejected`）：

```bash
node scripts/framepick-discovery-cli.mjs rescreen
node scripts/framepick-discovery-cli.mjs rescreen --apply
```

候选 ID 取平台自己的作品编号（`dy-7699342435985476905` / `bili-bv1xx411c7md` / `xhs-<笔记号>`），
不用中文片名抠字母——中文片名会退化成 `ai`、`aigc` 甚至单个字母。存量老 ID 可重算，幂等：

```bash
node scripts/framepick-library-cli.mjs candidate reindex --dry-run
node scripts/framepick-library-cli.mjs candidate reindex
```

`作品.json` 必须带 `originalReleaseDate`（原片发布日期）与 `intakeDate`（收录日期，填当天）。片库校验会拦下缺原片发布日期的作品。

## 实测记录

- 2026-11-03 浏览器后端：3 关键词 → 37 条 → 22 条被拦 → 15 条入池。
- 2026-11-03 API 后端：2 关键词 × 15 条 → 30 条 → 17 条被拦、4 条重复、9 条入池（与首轮重叠部分被去重）。
- 2026-11-03 抖音（ego-browser）：6 关键词 → 174 条 → 54 条入池、104 条被拦（时长不足为多）、16 条重复；按新排除词回扫又降 8 条教程。
- 入池 ≠ 收录：AI 音乐翻唱、同人二创、资讯解说、连续剧单集都会混进来，**初筛只能缩短清单，不能替代看片**。

## 已知限制

- 抖音必须有登录态；扫描器只是读搜索列表，链接失效／作者改名的复核仍要人工点开看。
- 小红书未验证，相关线索只记录不入库。
- AI 制作属性只认标题／简介／UP 主自填标签里的明确表述（`\bai\b` 词边界），页面推荐位与评论里的 AI 字样不算。
- B 站接口字段与风控会变；失败时脚本在 stderr 打印原因并跳过该关键词，不会中断整轮。
- 抖音短视频的标题常常就是简介首句，脚本按标点截断，可能截得偏短；判断以链接原页为准。

## 关联

- [自动化计划](自动化计划.md)——抖音那一路为什么暂时只做手动、接之前要看什么
- [帧选 PRD](framepick-prd-20261102.md) · [片库运营流程](framepick-library-operations-20261102.md) · [首轮 AI 搜片试跑](../ai-film-discovery-trial-20261102/试跑结果.md)
- 测试：`tests/framepick-discovery-integration.mjs`（规则／去重／报告）、`tests/framepick-discovery-scan-test.py`（时长与证据解析，无需联网）

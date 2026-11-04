# 帧选 Framepick · 产品展示

用户要求把主页推荐片单作为本人产品项目展示，并引流到独立片单网页。本轮命名「帧选 Framepick」，主张「好看的 AI 影像，从这里发现」。

首页入口：`/#filmRecommendations`。产品页面：`/reel/`。本轮只完成本地品牌展示与入口，不新增评分、搜片服务、会员或片源，不推送发布。

制作前评估 [CineList](https://github.com/BetaHuhn/cinelist)（GPL-3.0）：其服务端推荐及个人片库超出本次需求，沿用现站静态实现及原封面，没有复制上游源码或引入依赖。

截图：

- `home-desktop-light.png`、`home-desktop-dark.png`：1440×900 首页片单产品章节。
- `home-mobile-light.png`、`home-mobile-dark.png`：390×844 首页片单产品章节。
- `reel-desktop.png`、`reel-mobile.png`：独立产品页首屏。

验证入口：`tests/projects-smoke.py`、`tests/chapter-scenes-smoke.py` 中的双语响应式章节用例、`tests/section-jump-smoke.py`、`tests/pages-artifact-integration.mjs`。最终结果见根目录 `当前进度.md`。

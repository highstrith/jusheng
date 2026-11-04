# 帧选片库页面改版记录

2026-11-02，本地完成，未推送发布。预览：`http://localhost:3000/reel/`。

## 交付

- 以现有帧选为基础重新组织介绍、横幅精选、三列片库、会员计划和选片标准；手机单列，沿用现有概念封面与外部原片链接。
- 支持搜索片名／作者／题材，组合类型、题材、来源、评分与免费／VIP条件；排序包含编辑精选、评分最高及最新收录，URL保留筛选。
- 作品详情支持分享深链接、浏览器返回／前进、Esc／背景关闭和回焦。收藏保存在当前浏览器，存储受限时仅保留本次浏览并明确告知。
- 首批来源入口为小红书、抖音、哔哩哔哩；实际公开内容仍是原有三部抖音作品。所有正式评分为空并显示待评。没有新编影片、评分、会员数、收费金额或VIP内容。
- 免费／VIP权益区和弹窗明确会员尚未开放；没有真实会员后台、收费、定时搜片或站内视频播放。静态公开产物不承载私密会员内容。

## 开源复用评估

制作前重新核对[FOSSRadar](https://github.com/wbfoss/fossradar)（MIT）与[CineList](https://github.com/BetaHuhn/cinelist)（GPL-3.0）。前者的目录检索组织可借鉴，后者的电影API与服务端超出本轮页面范围；采用项目已有原生HTML／CSS／JS与媒体，没有复制上游源码或引入依赖。

## 验证

共17项通过：

- `python3 tests/framepick-library-smoke.py`：9项。搜索与组合筛选、待评和VIP空状态、数值评分fixture、URL／历史／回焦、输入安全、收藏持久化／存储失败、320–1920px、无JS／file、键盘收藏焦点、手机控件可访问名称。
- `python3 tests/projects-smoke.py ProjectPages.test_recommended_film_screen_precedes_portrait_and_opens_in_current_tab ProjectPages.test_film_index_recommendation_works_without_javascript ProjectPages.test_recommended_covers_load_and_are_current_tab_links_in_both_themes`：3项，保留主页入口、封面、品牌和无JS往返。
- `python3 tests/cursor-smoke.py`：3项，正文光标、链接／按钮与可编辑字段和文字选择。
- `node --test tests/pages-artifact-integration.mjs`：2项，真实Pages产物包含新CSS／JS且字节一致。
- `node --check reel/framepick.js`、`git diff --check`通过。

独立只读审查提出两项问题，均已验证修复：卡片无条件append造成键盘收藏后失焦，改为只移动顺序实际变化的节点；收藏视图移除当前卡片后聚焦下一收藏或清除按钮。手机通过display:none隐藏标签导致收藏按钮和排序框无可访问名称，改为视觉隐藏。两项均有先红后绿的回归；审查未发现其他实质缺陷。

Ego实际操作：搜索燕然并查看详情、Esc关闭、哔哩哔哩空状态、清除筛选、收藏烬海棠并只看收藏、会员状态弹窗。截图已检查实际布局，无横向溢出。

## 截图

- [桌面首屏](desktop.png)
- [桌面片库](desktop-library.png)
- [作品详情](detail.png)
- [手机首屏](mobile.png)
- [手机片库](mobile-library.png)
- [手机会员区](mobile-membership.png)

截图是本地页面证据，不进入Pages发布目录。概念封面仍明确标注非官方海报。

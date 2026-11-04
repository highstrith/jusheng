# 推荐片单独立章节

用户要求推荐片单成为有图片的独立整屏区，放到数字人之前，并删除肖像左下角说明。涉及首页结构、展厅／章节CSS、字典与初始锚点、现有片单回归和项目文档。先复现旧位置，再改布局与标注，最后检查手机、双语／主题、跳转、图片加载和首屏预算。风险为整屏过度挤压小屏、封面提前加载或新锚点落错位置。

## 参考与设计

开工前检索并评估[Movieace](https://github.com/hendurhance/movieace)的编辑式影片陈列思路。其完整Vue／TMDB／播放系统不适合本次静态片单入口，仅借鉴「清楚的区块标题＋真实封面」的组织方式，未复制代码、素材或安装依赖。

沿用本站纸白／墨黑／橘色主题变量和系统字体。导演台后是推荐片单，再进入数字人介绍；片单区顶部标题与说明／入口分栏，下方三张16:10封面并排，让内容本身界定这个章节。桌面至少100svh，使用min-height允许长文案增长；手机改为首张通栏、另两张半宽，避免三张纵排拉长页面。390×844实测章节约753px。

## 实现

- 图片复用reel/img的相骨、烬海棠、燕然，带片名caption；640／1280px srcset、准确尺寸、lazy和async解码。没有重新制作或复制媒体文件。
- 三张封面与主CTA分别为原生同标签链接，均进入独立reel/。现有中英文推荐文案继续使用；片名保留原名。
- home-modules.css纳入该章节高度、内边距与scroll-margin；studio.js将filmRecommendations加入异步目录完成后的锚点恢复列表。
- 肖像的portrait-caption DOM、CSS及两个闲置字典键移除。原图及双语alt保留，不影响图片内容和关于区其余文字。
- 首页studio.js、home-modules.css及三页studio／exhibition.css资源版本升级20261101-reel-screen，避免已有缓存继续使用旧布局。

## 验证

- 片单相关3项：位置在projects和about之间、1440／820／390／320双语、桌面整屏、三张真实封面／加载属性、标注移除与双语alt；原生无脚本入口；封面实际解码、两主题和同标签打开。旧版首先因推荐区在contact后失败，新版通过。初始锚点检查等待浏览器完成异步定位后的稳定帧。
- `tests/home-modules-smoke.py`：3项；`tests/typography-smoke.py`：2项；手机首屏图片预算：1项，104,621B，与前轮一致；`node --test tests/pages-artifact-integration.mjs`：1项。
- 共10项相关检查，`node --check assets/studio.js`和`git diff --check`通过。
- 实际IAB：[桌面片单](reel-screen-20261101/desktop.png)、[深色](reel-screen-20261101/dark.png)、[无角标肖像](reel-screen-20261101/portrait.png)。独立Chrome：[手机](reel-screen-20261101/mobile.png)。测试基于Chrome和视口模拟，未验证真实移动设备或Safari。

仅本地提交，未推送或发布。

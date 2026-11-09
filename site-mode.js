// 站点形态开关。必须在 <head> 里同步加载（不能加 defer / async）：
// 1) 样式生效前写好 data-sfm，避免 cinema 专属区块闪一下；
// 2) 下面用 document.write 条件注入可选脚本，只有解析阶段才安全。
// ranking：编选与榜单模式，隐藏会员、购票、订单、创作者与账号入口。
// cinema：影院模式，恢复单片观影、我的影院、创作者发行等区块。
window.FRAMEPICK_SITE_MODE = 'ranking';
document.documentElement.setAttribute('data-sfm', window.FRAMEPICK_SITE_MODE);

// 编选形态下不下载只在影院形态才用到的三个脚本（约 46KB）。这些区块整块
// display:none，脚本顶层却仍会绑事件、发目录请求，属于白下载。
//
// 为什么是 document.write，而不是等 DOMContentLoaded 再 appendChild：
// framepick.js 在顶层一次性派发 framepick:catalogue-ready，账号与创作者模块
// 靠它处理 ?account=1 / ?creator=1 深链；动态注入的脚本赶不上，会永久错过。
// 在解析阶段写出 <script defer> 与静态写在 HTML 里完全等价——顺序、
// 执行时机、DOMContentLoaded 之前执行完的保证都不变。同源 + defer 也不会
// 触发 Chrome 对慢速网络下 document.write 注入脚本的拦截。
//
// 前提：review-config.js 必须同步排在本文件之前，否则读不到站点配置。
// 改下面三个脚本的内容时，记得 bump 三张 HTML 里 site-mode.js 的 ?v=。
(function () {
  'use strict';
  var accountApi = String(window.FRAMEPICK_ACCOUNT_API || window.FRAMEPICK_REVIEW_API || '').trim();
  var cinema = window.FRAMEPICK_SITE_MODE === 'cinema';
  var optional = [];
  // 显式配置了账号服务时，ranking 也要装上账号模块：它会写
  // data-accounts="enabled"，解除登录入口的隐藏（既有行为，勿删）。
  if (cinema || accountApi) optional.push('framepick-accounts.js?v=20261109-perf1');
  if (cinema) {
    // creators 必须在 demo 之前：demo 顶层靠 window.framepickCreatorsReady
    // 判断要不要绑兜底事件，晚一步会双重绑定。
    optional.push('framepick-creators.js?v=20261109-perf1');
    optional.push('framepick-demo.js?v=20261109-perf1');
  }
  for (var i = 0; i < optional.length; i++) {
    document.write('<script defer src="' + optional[i] + '"><\/script>');
  }
})();

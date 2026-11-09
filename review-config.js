// 站点服务配置。构建时原样发布，改这里不需要重新打包。
//
// FRAMEPICK_ACCOUNT_API：账号／订单／观影三个接口的基址（阿里云函数计算·香港）。
// FRAMEPICK_REVIEW_API：共享评价接口的基址（当前未上线，留空）。
//
// 账号服务只在对外主站与本地预览启用：主站指向 https://api.orangeaistudio.com，
// 本地预览走后端 loopback（相对 /api/framepick）。后端 CORS 只放行对外主站，
// 因此备份站（highstrith.github.io）与裸域留空——露出登录入口只会点开报错，保持隐藏。
// 留空不会静默假装成功：未配置时登录入口由站点形态隐藏。
(function () {
  var host = location.hostname;
  if (host === 'www.orangeaistudio.com') {
    window.FRAMEPICK_ACCOUNT_API = 'https://api.orangeaistudio.com/api/framepick';
  } else if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    window.FRAMEPICK_ACCOUNT_API = '/api/framepick';
  }
})();
window.FRAMEPICK_ACCOUNT_API = window.FRAMEPICK_ACCOUNT_API || '';
window.FRAMEPICK_REVIEW_API = window.FRAMEPICK_REVIEW_API || '';

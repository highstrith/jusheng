// 站点服务配置。构建时原样发布，改这里不需要重新打包。
//
// FRAMEPICK_ACCOUNT_API：账号／订单／观影三个接口的基址（阿里云函数计算）。
// FRAMEPICK_REVIEW_API：共享评价接口的基址（当前未上线，留空）。
//
// 留空时的行为：本机预览（localhost/127.0.0.1）自动用 /api/framepick；
// 线上静态托管则显示「服务尚未部署」，不会静默假装成功。
// 正式接入时填写已绑定自有域名的 https://<域名>/api/framepick；fcapp.run 仅供测试。
window.FRAMEPICK_ACCOUNT_API = window.FRAMEPICK_ACCOUNT_API || '';
window.FRAMEPICK_REVIEW_API = window.FRAMEPICK_REVIEW_API || '';

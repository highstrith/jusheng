// 站点形态开关。同步加载，在样式生效前写好属性，避免闪烁。
// ranking：编选与榜单模式，隐藏会员、购票、订单、观影记录与账号入口。
// cinema：影院模式，恢复单片观影、我的影院、创作者发行等区块。
window.FRAMEPICK_SITE_MODE = 'ranking';
document.documentElement.setAttribute('data-sfm', window.FRAMEPICK_SITE_MODE);

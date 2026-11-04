# 帧选访客评价

日期：2026-11-02。当前交付是本地运行的访客评论与评分，不包含正式网站服务部署。

## 页面使用

打开`http://localhost:3000/reel/`，页眉「访客模式」说明无需注册的使用方式。打开任一作品详情：

- 「作品介绍」展示帧选整理的剧情简介与选片线索。
- 「原平台评价」提供原作者发布页入口，查看作者介绍及原平台观众评论；本站未同步这些评论或平台评分。
- 「站内评价」查看本站访客评价、评分均值与人数，填写昵称、1–10分或评价正文后发布。同一浏览器同一作品保留一份评价，可更新、撤回；只写正文不参与评分均值。

评分依据可选编辑评分或站内用户评分，各自筛选／排序，来源分开标明。编辑未完成审核的评分仍为待评。访客身份由此浏览器cookie识别，清除cookie后不能恢复原评价的修改权；不冒充实名账户或付费身份。

## 本地服务与数据

现有本地预览仍使用`node serve.js`，集成`server/framepick-reviews.cjs`。评价数据默认保存在`~/.framepick/reviews/`，不是静态站点的data目录，数据库及cookie签名key不进入Git或Pages。浏览器测试与API测试使用独立临时目录，预览库没有自动写入的示例评论或评分。

独立API可运行：

```sh
node server/framepick-reviews.cjs
```

默认监听127.0.0.1:3001，只提供评价API，不提供本地作品上传／管理功能。不要把完整serve.js当作生产评论服务暴露到公网。

环境变量：

| 变量 | 用途 |
| --- | --- |
| `FRAMEPICK_REVIEWS_DATA_DIR` | 数据库与签名key的私密持久化目录 |
| `FRAMEPICK_REVIEWS_COOLDOWN_MS` | 同访客写入间隔，默认1500毫秒 |
| `FRAMEPICK_REVIEWS_ALLOWED_ORIGIN` | 可选的一个精确前端origin，不能用通配符 |
| `PORT` | 独立API端口，默认3001；预览serve.js默认3000 |

API包括GET `/api/framepick/session`、GET `/api/framepick/summary`与GET／POST／DELETE `/api/framepick/films/:id/reviews`。POST的JSON为`{nickname,text,rating}`；昵称最多24字、正文最多1000字，rating为null或1–10整数；评分和正文至少一项。数据库写入串行且通过临时文件原子替换，保存失败不报告成功。

文件存储仅支持每数据目录一个活跃进程，数据库与key应一起备份。默认cookie是HttpOnly、SameSite=Lax；当前面向同源／同站点本地预览。未来静态Pages连接跨站API时，须安排同源代理或明确cookie与TLS部署方案，CORS白名单本身不能解决浏览器跨站cookie限制。

`reel/review-config.js`的API地址默认空：localhost自动使用本地同源服务；普通静态域名和file模式不请求本地API，并显示未配置共享评价服务。正式站尚未接入，不能把本地可用表述为线上已开通。

## 复用与验证

制作前查阅[Twikoo](https://github.com/twikoojs/twikoo)（MIT）和[Waline](https://github.com/walinejs/waline)（GPL-2.0），现有Twikoo环境配置为空。两者均需部署服务；本轮沿用原生Node与页面代码实现所需共享评分接口，无新增运行时依赖，没有复制上游源码。

访客相关累计53项通过：评价HTTP10、评价浏览器13、旧片库9、推荐入口3、光标3、作品API13、Pages打包2。最终审查发现并修复慢汇总丢失其他影片评分、空昵称草稿恢复旧昵称两项问题，新增3项先红后绿回归。测试命令与结果记录在`当前进度.md`；核心新增测试：

```sh
node --test tests/framepick-reviews-api-integration.mjs
python3 tests/framepick-reviews-smoke.py
```

API已完成真实HTTP多会话、身份与所有权、更新不重复、撤回、重启保存、并发、分页、坏数据、请求上限、频控与来源检查。独立后端审查另注入保存失败，确认此前数据保留且后续写入可恢复。

页面实看截图：[桌面站内评价](desktop-review.png)、[原平台入口](original-source.png)、[手机站内评价](mobile-review.png)。均为实际空预览库，无假评论。

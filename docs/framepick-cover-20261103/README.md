# 封面改用平台原封面（2026-11-03）

## 为什么改

此前每部片的封面都是按剧情单独生成的 AI 概念图（卡片角标写着「概念封面」）。两个问题：

1. 那些图看上去像是本站自己画的，容易被理解成我们的作品，与原片作者的权利边界不清楚；
2. 每个平台（横屏的 B 站、竖屏的抖音）本来就带着官方封面，再另画一张既多余也不如原封面有辨识度。

现在一律使用**平台原封面**：卡片角标写「原片封面」，`alt` 写「《片名》原片封面」，页面上不再出现任何自造封面。

## 取封面通道

| 来源 | 通道 | 尺寸 | 稳定性 |
| --- | --- | --- | --- |
| 哔哩哔哩 | 公开接口 `https://api.bilibili.com/x/web-interface/view?bvid=<BV>` 的 `data.pic`，无需登录 | 1920×1080 / 2540×1429 等原始大小 | 永久链接，可随时重取 |
| 抖音 | 登录态浏览器打开 `https://www.douyin.com/video/<id>`，页面上 `biz_tag=pcweb_cover&s=PackSourceEnum_AWEME_DETAIL` 的那张图 | 440×330（4:3，平台已裁切） | 带签名，`x-expires` 到 2036 年 |

抖音没有公开的封面接口：服务端 HTML 里没有 `og:image`、没有 `video[poster]`，`iesdouyin.com/share/video/<id>` 只做 302 跳转，`web/api/v2/aweme/iteminfo` 返回空。所以走登录态浏览器（ego-browser）。

## 一条命令上线

日常只需要这一条（在 `site-portfolio-upgrade` 目录下）：

```sh
scripts/framepick-ship.sh "第三批 5 部上架"
```

它依次做 7 步，任何一步失败就停下并告诉你原因：

1. 检查环境（node、ossutil 凭据）
2. 刷新抖音封面（仅 `--with-douyin`，需要 ego-browser 登录态）
3. 取封面 + 转 640w webp（`framepick-cover-build.mjs`）
4. 上传 OSS + 逐张 HEAD 自检，有非 200 就拒绝部署
5. 重建页面 + 卡片校验（`build` / `check`）
6. 全量测试（`--fast` 跳过，约省 2 分钟）
7. 提交 → 推 `release/white-pages` 与 `main` → 等部署 → 线上复核卡片数与破图数

常用变体：

```sh
scripts/framepick-ship.sh "改了文案" --fast        # 不跑浏览器测试
scripts/framepick-ship.sh "先看看" --no-push       # 只做到本地校验，不碰线上
scripts/framepick-ship.sh "新片上架" --with-douyin # 顺带刷新抖音封面
```

**一次性准备**（只做一次，做完不再需要）：`~/bin/ossutil config`，endpoint 填 `oss-cn-hangzhou.aliyuncs.com`，写好 `~/.ossutilconfig`（`chmod 600`）。之后脚本自己读配置，不再要密钥。

## 分步操作（排查问题时用）

```sh
# 1) 抖音：登录态浏览器抓封面 URL → douyin-covers.json（B 站不需要这步）
ego-browser nodejs < scripts/framepick-cover-douyin.js

# 2) 下载 + 转 640px 宽 webp + 回填作品表（sourceCover / cover / coverAlt / coverNote）
node scripts/framepick-cover-build.mjs --dry-run     # 先看清单
node scripts/framepick-cover-build.mjs

# 3) 重建页面
node scripts/framepick-library-cli.mjs build

# 4) 上传新封面到 OSS 后部署（见 docs/OSS媒体托管说明.md 的「换素材」）
```

产物：

- `reel/img/<slug>-640w.webp` —— 等比缩放到 640px 宽（不裁切、不变形），进仓库、进站点；
- `reel/img/raw/<slug>-cover.jpg` —— 平台原图下载缓存，**不进 git、不进站点**（`.gitignore` 与发布白名单都排除 `raw/`）；
- 作品表 `sourceCover` —— 原封面出处，仅供追溯，页面不外链它（抖音链接带签名，会失效）。

## 已知限制

1. **抖音只有 4:3 裁切版**。URL 里的 `~tplv-dy-resize-origshort-autoq-75:330` 是签名的一部分，改成 `:1080` 之类会 403；未裁切的 `origin_cover` 只能通过带签名的 aweme 详情接口拿，不做。
   结果是个别封面会被裁掉字：例如《南天门计划：灰蚀危机》左侧片名被切掉一截。
   如需更完整，只能改用「视频首帧截图」——那是画面不是海报，且要下载视频，暂不采用。
2. **抖音封面分辨率上限 440×330**，放大到 640 宽会有轻微软；卡片容器 16:10 + `object-fit:cover` 下观感可接受。B 站封面足够清晰。
3. 竖屏视频的原封面（1080×1920）同样被平台裁成 4:3，不是我们裁的。

## 与旧封面的关系

- 17 个 1280px 的旧 AI 概念封面（`reel/img/<slug>.webp`）已删除，站点不再引用；
- 封面文件名沿用 `<slug>-640w.webp`，OSS 上同名对象覆盖上传即可，链接不变（缓存 600 秒）；
- OSS 上没有 DeleteObject 权限，个别遗留对象会留在桶里，不占页面。

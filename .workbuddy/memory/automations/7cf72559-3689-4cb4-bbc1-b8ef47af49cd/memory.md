# 自动上新任务执行记录（7cf72559）

## 2026-11-07 11:32 首轮

- 发现：B 站 10 关键词 ×15 = 150 条 → 入池 14 条；channel 扫描跳过（片库/候选池都无 UP 主 mid，按规则不猜）。verify 全通过。报告 `docs/framepick-discovery-20261103/runs/2026-11-07-1136.md`。
- 上架：哔哩哔哩额度 5/5 用满，45→50 部（CLAUDE：好孩子，晚安、南海上空的白色幽灵、Bounty Hunters、梅花之影、N-10）。
- 坑：`candidate convert` 不补 `completion` 字段，缺了会让片库冒烟测试多出一个空值失败。以后载荷必须带 `completion: standalone`。
- ship 一次通过（76 测试 OK、部署 success、线上 50 卡片）。
- 注意：commit 的 docs 之后单独 push 不会触发新部署（最新 run 仍指向 ship 的 commit），无需等待。

## 2026-11-07 23:55 第二轮（只发现，未上架）

- **额度教训**：哔哩哔哩额度一天两轮共享，上午已上 5/5，晚间这轮剩 0 → 整轮零上架，按规则不上、不改页面、不跑 ship。以后接到第二轮任务先算额度，额度为 0 时把力气放在发现和「明日优先名单」上。
- 发现：搜索 150 条入池 39 条；**channel 这轮跑通了**——用 `api.bilibili.com/x/web-interface/view?bvid=<BV>` 取 `data.owner.mid`（读原页真实数据，不算猜）补上片库缺失的 mid，8 个作者 6 个成功 31 条、2 个 412，作者批入池 4 条。本轮共入池 43 条，池内 679 条。
- 抖音：候选池无一条在 `douyin-covers.json` 里有封面（15 个键全是已上架作品的），按规则留人工。
- 部署：这次 docs-only 提交**确实触发了** Deploy（d00ddf1，success），和上一轮记录相反 —— 说明 paths 过滤可能已去掉或本次不同，docs push 后要顺手等一次 run，不要假设不触发。

## 2026-11-08 12:00 当日首轮（发现＋上架 5 部）

- 额度：新自然日 0 部已上，哔哩哔哩 5/5 用满；抖音 5/5 可用但无缓存封面 → 留人工。
- 发现：搜索 150 条入池 49；channel 用 view API 读 `owner.mid` 拿到 23 位作者 mid，9 位成功（103 条）、10 位 412 后连续 4 次失败即停。池 679→728。verify 全过。
- 上架：未来遗物·最后一单、蝶1：落地无声、虚蚀录、上德不德、远征（50→55）。载荷带 `completion: standalone` 后无返工。
- **新坑：本机代理 127.0.0.1:7897 端口活但 HTTPS 穿不过**，git push 报 SSL_ERROR_SYSCALL / Empty reply / 443 超时。解法：`env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY git -c http.proxy= -c https.proxy= push origin main`；github.com 直连间歇性抽风，多试 1–3 次即可成功。先测 `curl -o /dev/null -w %{http_code}` 直连与走代理再判断，别急着怪沙箱。
- ship 结果：76 测试 OK、产物 155、线上 55 卡片、两次部署（382df09 与 docs ec8c090）均 success。
- 报告 `docs/framepick-discovery-20261103/runs/2026-11-08-1203.md`。

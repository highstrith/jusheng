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

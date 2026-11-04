# 橘生梦厂 · AI 短片编选

https://highstrith.github.io/jusheng/

把 AI 短片编成片单、让人真的坐下来看完的站。这个仓库是它的**源码仓库**：
页面、脚本、服务端模块、测试、文档都在这里，仓库根目录就是站点根目录。

## 目录

```
index.html library.html me.html     三张页面
*.css *.js                          页面样式与脚本（serve.js 除外，那是本地服务器）
img/                                封面（img/raw/ 是原图，不进产物）
server/                             片库、账号、创作者、订单、观影、评价
scripts/                            片库 CLI、封面、发现、构建、上线
tests/                              浏览器冒烟 + Node 集成
docs/                               工作记录与决策文档
产品需求.md 软件架构.md 当前进度.md   三份固定产品文档
```

## 常用命令

```bash
node serve.js                       本地预览 → http://127.0.0.1:3200/
./scripts/run-tests.sh              全量测试（自己起服务，跑完关）
./scripts/build-site.sh             构建 public/（CI 跑同一份）
./scripts/ship.sh "提交说明"         一条命令上线：封面 → 校验 → 测试 → 构建 → 推 → 复核

node scripts/framepick-library-cli.mjs list|show|candidate|status    片库操作
```

片库数据在 `~/.framepick/library/library.json`，**不在仓库里**：它是内容资产，
不是代码。换机器要单独带走。

## 和作品集的关系

作品集是另一个仓库 [highstrithstate](https://github.com/highstrith/highstrithstate)，
发布在 https://highstrith.github.io/highstrithstate/ 。两边只靠一条公开链接相连：
作品集首页有三张推荐卡，点进来就是这个站。**没有共享代码、没有同步脚本**，
改这边不会影响那边。

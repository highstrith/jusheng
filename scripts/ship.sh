#!/bin/bash
# 橘生梦厂「一条命令上线」：取封面 → 转图 → 重建页面 → 校验 → 测试
#                              → 构建 public/ → 推 main → 等部署 → 线上复核。
#
# 本地源码仍用 img/；发布前先上传 OSS，build-site.sh 再改写产物图片地址。
# OSS 凭据只由本机 ossutil 读取，不进入 GitHub Actions 或浏览器。
#
#   scripts/ship.sh "第三批 5 部上架"            全流程（含浏览器测试）
#   scripts/ship.sh "第三批 5 部上架" --fast     跳过浏览器测试，只跑校验
#   scripts/ship.sh "..." --no-push              只做到本地校验，不部署
#   scripts/ship.sh "..." --with-douyin          先用登录态浏览器刷新抖音封面
#
# 这个仓库就是橘生梦厂的源码仓库，站点由 GitHub Actions 构建 public/ 发布到
# https://highstrith.github.io/jusheng/ 。作品集是另一个仓库（highstrithstate），
# 与这里无关，不再由本脚本一并发布。
#
# 一次性准备：ego-browser 保持登录抖音，仅 --with-douyin 时需要
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

MSG="${1:-}"
if [ -z "$MSG" ]; then
  echo "用法：scripts/ship.sh \"提交说明\" [--fast] [--no-push] [--with-douyin]" >&2
  exit 2
fi
shift

FAST=0; PUSH=1; WITH_DOUYIN=0
for flag in "$@"; do
  case "$flag" in
    --fast) FAST=1 ;;
    --no-push) PUSH=0 ;;
    --with-douyin) WITH_DOUYIN=1 ;;
    *) echo "未知参数：$flag" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "0/6 检查环境"
command -v node >/dev/null || fail "找不到 node"
echo "  工作目录 $(pwd)"

if [ "$WITH_DOUYIN" = "1" ]; then
  step "1/6 刷新抖音封面（登录态浏览器）"
  if ego-browser nodejs < scripts/framepick-cover-douyin.js; then
    echo "  抖音封面已刷新"
  else
    echo "  ! 抖音封面抓取失败（多半是没登录），沿用已有封面继续"
  fi
else
  step "1/6 刷新抖音封面 — 跳过（需要时加 --with-douyin）"
fi

step "2/6 取封面并转 640w webp"
node scripts/framepick-cover-build.mjs || fail "封面构建失败，见上面的 ✗ 行"
./scripts/upload-cover-assets.sh || fail "OSS 上传或图片自检失败，停止发布"

step "3/6 重建页面并校验"
node scripts/build-framepick-library.mjs || fail "页面重建失败"
node scripts/check-framepick-library.mjs || fail "卡片校验未通过"

if [ "$FAST" = "0" ]; then
  step "4/6 全量测试（约 2 分钟）"
  ./scripts/run-tests.sh > /tmp/jusheng-ship-tests.log 2>&1
  if [ $? -eq 0 ]; then
    grep -E '^Ran |^OK' /tmp/jusheng-ship-tests.log | tail -2
  else
    grep -E '^(FAIL|ERROR):' /tmp/jusheng-ship-tests.log | head -10
    fail "测试未通过，日志在 /tmp/jusheng-ship-tests.log"
  fi
else
  step "4/6 全量测试 — 跳过（--fast）"
fi

step "5/6 构建 public/ 并检查产物"
./scripts/build-site.sh || fail "产物构建失败"

if [ "$PUSH" = "0" ]; then
  step "6/6 提交推送 — 跳过（--no-push）"
  printf '\n\033[32m本地已完成\033[0m\n'
  exit 0
fi

step "6/6 提交、推送、等部署、复核线上"
if git diff --quiet && git diff --cached --quiet; then
  echo "  没有文件改动，跳过提交"
  PUSHED=0
else
  git add -A
  git commit -q -m "$MSG" || fail "提交失败"
  echo "  已提交 $(git log --oneline -1)"
  PUSHED=1
fi

if [ "$PUSHED" = "1" ]; then
  git push origin main 2>&1 | tail -1 || fail "推送失败"
  for _ in $(seq 1 15); do
    sleep 20
    S=$(curl -s "https://api.github.com/repos/highstrith/jusheng/actions/runs?per_page=1" \
      | python3 -c "import json,sys; d=json.loads(sys.stdin.read(),strict=False)['workflow_runs'][0]; print(d['status'], d['conclusion'])" 2>/dev/null)
    echo "  部署：$S"
    case "$S" in *success*|*failure*) break;; esac
  done
  case "$S" in
    *success*) ;;
    *) fail "部署未成功（状态：$S）。到 Actions 看日志；若是 github-pages 产物报错，别点 Re-run failed jobs，直接 Run workflow 新开一次运行" ;;
  esac
fi

sleep 5
curl -s "https://highstrith.github.io/jusheng/?cb=$(date +%s)" -o /tmp/jusheng-live.html
python3 - <<'PY'
import re
h = open('/tmp/jusheng-live.html', encoding='utf-8').read()
cards = len(re.findall(r'<article class="card"', h))
print(f'  线上首页：{cards} 张卡片 · 标题含「橘生梦厂」：{"橘生梦厂" in h}')
PY

printf '\n\033[32m完成\033[0m\n'

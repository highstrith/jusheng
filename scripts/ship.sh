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

# ossutil 装在 ~/bin（deploy-orange.sh 自己也这么加，但 ship 里要先能找到它才知道能不能同步主站）
export PATH="$HOME/bin:$PATH"

# 这一版上线了没有？用产物比对，不靠 Actions API —— 未认证的 API 每小时只有 60 次，
# 自动化两轮一跑就撞限流；拿不到状态时 `set -u` 会把脚本崩在 case 上（2026-11-08 真实踩过）。
#   1 = 线上 index.html 与本地产物字节一致（最严格）
#   2 = 页面结构一致（卡片数、周榜卡数、轮播张数），多半只是图片 CDN 地址不同
#   0 = 还是旧版 / 没拿到
check_deploy() {
  curl -s --compressed "https://highstrith.github.io/jusheng/?cb=$(date +%s)" \
    -o /tmp/jusheng-live.html || { echo 0; return; }
  python3 - "$1" 2>/dev/null <<'PY' || echo 0
import hashlib, re, sys
live = open('/tmp/jusheng-live.html', 'rb').read()
local = open(sys.argv[1], 'rb').read()
if hashlib.sha256(live).hexdigest() == hashlib.sha256(local).hexdigest():
    print(1)
    raise SystemExit
def shape(buf):
    text = buf.decode('utf-8', 'replace')
    return (len(re.findall(r'<article class="card"', text)),
            len(re.findall(r'<li class="pick-card', text)),
            len(re.findall(r'class="hero-slide', text)))
print(2 if shape(live) == shape(local) else 0)
PY
}

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
# 本周推荐按上一自然周首发的作品自动生成；片库数据不在仓库里，缺失时保留现有榜单。
if [ -f "${FRAMEPICK_LIBRARY_FILE:-$HOME/.framepick/library/library.json}" ]; then
  node scripts/build-weekly-picks.mjs || fail "周榜生成失败"
else
  echo "  跳过周榜生成：找不到片库数据"
fi
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

step "6/6 提交、推送、等部署、同步主站、复核线上"
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
  STATUS=""; LEVEL=0
  for i in $(seq 1 15); do
    sleep 20
    LEVEL=$(check_deploy public/index.html)
    if [ "$LEVEL" = "1" ]; then
      echo "  部署：线上已是这一版（第 ${i} 次检查）"; break
    fi
    # API 只当辅助信息：限流拿不到就显示「检查中」，不影响判断。
    STATUS=$(curl -s "https://api.github.com/repos/highstrith/jusheng/actions/runs?per_page=1" \
      | python3 -c "import json,sys; d=json.loads(sys.stdin.read(),strict=False)['workflow_runs'][0]; print(d['status'], d['conclusion'])" 2>/dev/null || true)
    echo "  部署：${STATUS:-检查中}"
    case "$STATUS" in
      *failure*) fail "部署失败（$STATUS）。到 Actions 看日志；若是 github-pages 产物报错，别点 Re-run failed jobs，直接 Run workflow 新开一次运行" ;;
    esac
  done
  case "$LEVEL" in
    1) ;;
    2) echo "  ! 线上内容已更新，但字节与本地产物不同（多半是图片 CDN 地址差异），按已上线处理" ;;
    *) fail "5 分钟内线上还是旧版（部署可能仍在排队，或这一版构建失败）。到 Actions 确认：若 github-pages 报产物重复，别点 Re-run failed jobs，直接 Run workflow 新开一次运行" ;;
  esac
fi

# 主站是 www.orangeaistudio.com/orangedream/（阿里云香港 OSS）；GitHub Pages 那份只当备份。
# 只同步片单，作品集那 136MB 不在每轮发布里传（要更作品集用 bash deploy-orange.sh 全量）。
if command -v ossutil >/dev/null 2>&1; then
  if bash ../deploy-orange.sh --reel-only > /tmp/jusheng-oss-sync.log 2>&1; then
    echo "  主站已同步：https://www.orangeaistudio.com/orangedream/"
  else
    echo "  ! 主站同步失败，详见 /tmp/jusheng-oss-sync.log（GitHub 那份已正常部署，不受影响）"
  fi
else
  echo "  跳过主站同步：本机没有 ossutil"
fi

sleep 2
for host in "https://www.orangeaistudio.com/orangedream/" "https://highstrith.github.io/jusheng/"; do
  curl -s --compressed "$host?cb=$(date +%s)" -o /tmp/jusheng-live.html || true
  HOST="$host" python3 - <<'PY'
import re, os
h = open('/tmp/jusheng-live.html', encoding='utf-8').read()
cards = len(re.findall(r'<article class="card"', h))
picks = len(re.findall(r'<li class="pick-card', h))
print(f'  {os.environ["HOST"]}  {cards} 张卡片 · 本周推荐 {picks} 张')
PY
done

printf '\n\033[32m完成\033[0m\n'

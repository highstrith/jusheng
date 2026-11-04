#!/bin/sh
# 跑橘生梦厂全部测试：浏览器冒烟 + Node 集成 + 产物守卫。
#
#   scripts/run-tests.sh              起本地服务（:3200），跑完自动关
#   scripts/run-tests.sh --no-server  复用已在跑的 STUDIO_BASE_URL
#
# 可覆盖：PORT / STUDIO_BASE_URL / FRAMEPICK_BASE_PATH
set -e
cd "$(dirname "$0")/.."

PORT="${PORT:-3200}"
FRAMEPICK_BASE_PATH="${FRAMEPICK_BASE_PATH:-/}"
export FRAMEPICK_BASE_PATH
export FRAMEPICK_SITE_ROOT="${FRAMEPICK_SITE_ROOT:-$PWD}"

SERVER=""
if [ "$1" != "--no-server" ]; then
  export STUDIO_BASE_URL="${STUDIO_BASE_URL:-http://127.0.0.1:$PORT}"
  node serve.js & SERVER=$!
  trap 'kill $SERVER 2>/dev/null || true' EXIT
  for _ in $(seq 1 100); do
    curl -sf -o /dev/null "$STUDIO_BASE_URL$FRAMEPICK_BASE_PATH" && break
    sleep 0.1
  done
  echo "本地预览：$STUDIO_BASE_URL$FRAMEPICK_BASE_PATH"
else
  export STUDIO_BASE_URL="${STUDIO_BASE_URL:-http://127.0.0.1:$PORT}"
fi

python3 -m unittest \
  tests/framepick-library-smoke.py \
  tests/framepick-picks-smoke.py \
  tests/framepick-reviews-smoke.py \
  tests/framepick-accounts-smoke.py \
  tests/framepick-demo-smoke.py \
  tests/framepick-viewing-smoke.py \
  tests/framepick-typography-smoke.py \
  tests/framepick-oss-smoke.py \
  tests/framepick-discovery-scan-test.py

node --test tests/framepick-reviews-api-integration.mjs
node --test tests/framepick-library-store-integration.mjs
node --test tests/framepick-accounts-integration.mjs
node --test tests/framepick-orders-integration.mjs
node --test tests/framepick-viewing-integration.mjs
node --test tests/framepick-api-integration.mjs
node --test tests/framepick-discovery-integration.mjs
node --test tests/framepick-publish-rules-test.mjs
node --test tests/framepick-creators-integration.mjs
node --test tests/framepick-creators-store-integration.mjs

# 发布前守卫：卡片字段齐全，页面与作品表一致。
node scripts/check-framepick-library.mjs --site "$FRAMEPICK_SITE_ROOT"
if [ -f "$HOME/.framepick/library/library.json" ]; then
  node scripts/build-framepick-library.mjs --site "$FRAMEPICK_SITE_ROOT" --check
else
  echo "跳过片库一致性检查：还没有作品表（先跑 scripts/framepick-library-cli.mjs seed）"
fi

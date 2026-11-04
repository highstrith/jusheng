#!/bin/sh
# 打包函数计算（Web 函数 / Node.js）部署包。产物：dist/framepick-api.zip
#
#   控制台上传后，启动命令填：node framepick-api.cjs
#   监听端口 9000（FC Web 函数的默认端口，代码里读 PORT，缺省 9000）
set -eu
cd "$(dirname "$0")/.."

OUT=dist/framepick-api
FILES="framepick-api.cjs framepick-accounts.cjs framepick-orders.cjs framepick-viewing.cjs framepick-store.cjs oss-client.cjs"

rm -rf "$OUT" dist/framepick-api.zip
mkdir -p "$OUT"
for file in $FILES; do
  [ -f "server/$file" ] || { echo "✗ 缺少 server/$file" >&2; exit 1; }
  cp "server/$file" "$OUT/"
done

# 语法先把关，别把坏包传上去再回滚
for file in $FILES; do node --check "$OUT/$file" || exit 1; done

(cd "$OUT" && zip -qr ../framepick-api.zip . -x '._*' '.*')
echo "  dist/framepick-api.zip（$(du -h dist/framepick-api.zip | cut -f1)）"

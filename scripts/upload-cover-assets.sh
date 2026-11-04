#!/bin/sh
# 上传当前站点的封面与分享卡。凭据只由本机 ossutil 配置读取，不进仓库或 CI。
#   scripts/upload-cover-assets.sh --dry-run  只列文件
#   scripts/upload-cover-assets.sh --check    只核对公开图片（CI 无需凭据）
set -eu
cd "$(dirname "$0")/.."

OSSUTIL="${OSSUTIL:-$HOME/bin/ossutil}"
BUCKET="oss://highstrith-assets/reel/img/"
BASE="https://highstrith-assets.oss-cn-hangzhou.aliyuncs.com/reel/img/"

if [ "${1:-}" = "--dry-run" ]; then
  echo "待上传："
  for file in img/*.webp img/*.jpg; do
    [ -f "$file" ] || continue
    printf '  %6sKB  %s\n' "$(( $(wc -c < "$file") / 1024 ))" "$(basename "$file")"
  done
  exit 0
fi

# 仅当前目录图片，排除原图缓存与 exFAT 伴生文件；同名换图缓存最长 10 分钟。
if [ "${1:-}" != "--check" ]; then
  [ -x "$OSSUTIL" ] || { echo "找不到 ossutil：$OSSUTIL" >&2; exit 2; }
  for file in img/*.webp img/*.jpg; do
    [ -f "$file" ] || continue
    "$OSSUTIL" cp --update --force --meta "Cache-Control:public,max-age=600" "$file" "$BUCKET"
  done
fi

echo "逐张核对 OSS 图片（失败即停止发布）："
for file in img/*.webp img/*.jpg; do
  [ -f "$file" ] || continue
  name=$(basename "$file")
  # 与浏览器跨域图片请求一致，核对正式站来源也被桶的防盗链规则放行。
  code=$(curl -sS --retry 2 --connect-timeout 10 --max-time 30 --referer "https://highstrith.github.io/" -o /dev/null -w '%{http_code}' -I "$BASE$name")
  printf '  %s %s\n' "$code" "$name"
  [ "$code" = "200" ] || { echo "OSS 图片不可用：$name" >&2; exit 1; }
done

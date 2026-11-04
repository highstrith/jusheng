#!/bin/sh
# 把封面素材上传到 OSS（凭据在 ~/.ossutilconfig，AccessKey 长期启用，不必每次开关）。
#
#   scripts/upload-cover-assets.sh            上传 reel/img 下的 webp
#   scripts/upload-cover-assets.sh --dry-run  只列出会传什么
#
# 前提：`~/bin/ossutil` 已配好（ossutil config，endpoint 用 oss-cn-hangzhou）。
set -e
cd "$(dirname "$0")/.."

OSSUTIL="${OSSUTIL:-$HOME/bin/ossutil}"
BUCKET="${BUCKET:-oss://highstrith-assets/reel/img/}"

if [ ! -x "$OSSUTIL" ]; then
  echo "找不到 ossutil：$OSSUTIL" >&2
  exit 2
fi

# ossutil 没有 --dry-run，这里只把待传清单打出来。
if [ "$1" = "--dry-run" ]; then
  echo "待上传（reel/img/*.webp，raw/ 除外）："
  for file in reel/img/*.webp; do
    printf '  %6sKB  %s\n' "$(( $(wc -c < "$file") / 1024 ))" "$(basename "$file")"
  done
  exit 0
fi

# 只传 webp 封面；raw/ 是平台原图缓存，属于母版，不进 OSS。
# 素材不是哈希命名，Cache-Control 与 HTML 对齐 600 秒，换图最多 10 分钟生效。
# exFAT 盘会给每个文件造 `._原名` 伴生文件，扩展名同样是 .webp，先删掉再传，
# 否则桶里会多出一堆 4KB 的垃圾对象（framepick-ship.sh 里也有同样一步）。
find reel/img -name '._*' -type f -delete 2>/dev/null
"$OSSUTIL" cp -r --update --jobs 4 \
  --include "*.webp" --exclude "._*" \
  --meta "Cache-Control:public,max-age=600" \
  reel/img/ "$BUCKET"

echo
echo "上传后逐个确认（应全部 200）："
for file in reel/img/*.webp; do
  name=$(basename "$file")
  code=$(curl -s -o /dev/null -w '%{http_code}' -I "https://highstrith-assets.oss-cn-hangzhou.aliyuncs.com/reel/img/$name")
  printf '  %s %s\n' "$code" "$name"
done

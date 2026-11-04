#!/bin/sh
# 把站点文件按白名单装进 public/。本地与 GitHub Actions 跑同一份。
#
#   ./scripts/build-site.sh            生成 public/
#   ./scripts/build-site.sh --check    只检查产物是否完整，不落地
#
# 为什么要白名单：这个仓库同时装着脚本、测试、文档和产品文档，直接发布仓库根
# 目录会把这些东西一起发到线上。站点只由三张页面 + 根目录的 js/css + img/ 组成。
set -eu
cd "$(dirname "$0")/.."

OUT=public
PAGES="index.html library.html me.html"
# 根目录里不是站点资源的 js（本地预览服务器）
SKIP_JS="serve.js"

rm -rf "$OUT"
mkdir -p "$OUT/img"

for page in $PAGES; do
  [ -f "$page" ] || { echo "✗ 缺少页面 $page" >&2; exit 1; }
  cp "$page" "$OUT/"
done

for file in *.js *.css; do
  case " $SKIP_JS " in *" $file "*) continue ;; esac
  cp "$file" "$OUT/"
done

rsync -a --exclude '/raw/' img/ "$OUT/img/"
touch "$OUT/.nojekyll"

# 守卫：页面里引用到的本站文件必须都在产物里，别等线上 404 才发现
python3 - "$OUT" <<'PY'
import os, re, sys
out = sys.argv[1]
html = ''.join(open(os.path.join(out, p), encoding='utf-8').read()
               for p in ('index.html', 'library.html', 'me.html'))
missing = []
for ref in set(re.findall(r'(?:src|href)="([^"?#:]+\.(?:js|css|webp|png|jpg|svg))"', html)):
    if ref.startswith(('http', '//')):
        continue
    if not os.path.exists(os.path.join(out, ref)):
        missing.append(ref)
if missing:
    print('✗ 产物缺这些被页面引用的文件：', ', '.join(sorted(missing)[:10]), file=sys.stderr)
    sys.exit(1)
print(f'  产物 {sum(len(f) for _, _, f in os.walk(out))} 个文件，页面引用齐全')
PY

echo "  public/ 就绪"

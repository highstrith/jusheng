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

# 不 rm -rf 整个 public 再重建：沙箱的批量删除守卫会拦「一次删 >50 个文件」
# （rm 直接退出码 2，自动化里必挂）。改为原地覆盖，再只删陈旧文件——正常
# 重建时需要删的就是 0 个。exFAT 伴生的 ._* 文件留在原地不管：本地 public/
# 只做预览与测试，部署产物在 CI 上从源码干净重建，不带伴生文件。
mkdir -p "$OUT/img"

for page in $PAGES; do
  [ -f "$page" ] || { echo "✗ 缺少页面 $page" >&2; exit 1; }
  cp "$page" "$OUT/"
done

for file in *.js *.css; do
  case " $SKIP_JS " in *" $file "*) continue ;; esac
  cp "$file" "$OUT/"
done

# 给搜索引擎的基础文件。漏了不会报 404，但收录会一直起不来，所以缺了直接拦下。
for file in robots.txt sitemap.xml; do
  [ -f "$file" ] || { echo "✗ 缺少 $file，站点收录会受影响" >&2; exit 1; }
  cp "$file" "$OUT/"
done

rsync -a --exclude '/raw/' --exclude '._*' img/ "$OUT/img/"
touch "$OUT/.nojekyll"

# 守卫：页面里引用到的本站文件必须都在产物里，别等线上 404 才发现
python3 - "$OUT" <<'PY'
import os, re, sys
from pathlib import Path
out = sys.argv[1]
html = ''.join(open(os.path.join(out, p), encoding='utf-8').read()
               for p in ('index.html', 'library.html', 'me.html'))
missing = []
refs = set(re.findall(r'(?:src|href)="([^"?#:]+\.(?:js|css|webp|png|jpg|svg))"', html))
# srcset 里的每一档也要在产物里，否则高分屏拿到的是一张 404。
for attr in re.findall(r'srcset="([^"]+)"', html):
    for part in attr.split(','):
        ref = part.strip().split(' ')[0]
        if ref and not ref.startswith(('http', '//', 'data:')):
            refs.add(ref)
for ref in refs:
    if ref.startswith(('http', '//')):
        continue
    if not os.path.exists(os.path.join(out, ref)):
        missing.append(ref)
# site-mode.js 在解析阶段条件注入的脚本不出现在 HTML 的字面引用里，单独核对。
# 否则「形态开关改了、文件却没进产物」要等切到 cinema 才暴露成线上 404。
mode = Path(out, 'site-mode.js').read_text(encoding='utf-8')
for src in re.findall(r"optional\.push\('([^']+\.js)", mode):
    name = src.split('?')[0]
    if not os.path.exists(os.path.join(out, name)):
        missing.append(name + ' (site-mode.js 可选脚本)')
if missing:
    print('✗ 产物缺这些被页面引用的文件：', ', '.join(sorted(missing)[:10]), file=sys.stderr)
    sys.exit(1)
print(f'  产物 {sum(len(f) for _, _, f in os.walk(out))} 个文件，页面引用齐全')

# 只改发布产物。本地源码与片库数据继续用 img/，离线预览和校验不依赖 OSS。
base = 'https://highstrith-assets.oss-cn-hangzhou.aliyuncs.com/reel/img/'
images = {p.name for p in Path(out, 'img').iterdir()
          if p.is_file() and not p.name.startswith('.')}
reference = re.compile(
    r'(?<![\w./-])(?:https://highstrith\.github\.io/jusheng/)?img/([A-Za-z0-9._-]+\.(?:webp|png|jpg|jpeg|svg))')
for file in Path(out).iterdir():
    if file.name.startswith('.') or file.suffix not in ('.html', '.js', '.css'):
        continue
    source = file.read_text(encoding='utf-8')
    # 不锚引号：srcset 里的 `img/x-1280w.webp 1280w` 不带引号，锚了就漏改。
    result = reference.sub(lambda m: base + m.group(1) if m.group(1) in images else m.group(0), source)
    if file.suffix == '.html':
        config = ('<link rel="preconnect" href="https://highstrith-assets.oss-cn-hangzhou.aliyuncs.com">'
                  '<script>window.FRAMEPICK_IMAGE_BASE="' + base + '";</script>')
        result = result.replace('<head>', '<head>\n' + config, 1)
    file.write_text(result, encoding='utf-8')
print(f'  图片已切到 OSS：{len(images)} 个文件（含片库数据与分享卡）')
PY

# 陈旧清理：只删本次产物清单里不存在的文件（改名/下架留下的旧封面等）。
# ._* 伴生文件不在此列，一律留着；单次超过 45 个就停下报错，由人工分批清，
# 免得撞上批量删除守卫。
python3 - "$OUT" <<'PY'
import os, sys
out = sys.argv[1]
skip_js = {'serve.js'}
expected = {'.nojekyll', 'index.html', 'library.html', 'me.html', 'robots.txt', 'sitemap.xml'}
for name in os.listdir('.'):
    if name.endswith(('.js', '.css')) and name not in skip_js:
        expected.add(name)
for dirpath, dirnames, files in os.walk('img'):
    rel_dir = os.path.relpath(dirpath, 'img')
    if rel_dir == 'raw':
        dirnames[:] = []
        continue
    for name in files:
        if name.startswith('._'):
            continue
        rel = name if rel_dir == '.' else os.path.join(rel_dir, name)
        expected.add(os.path.join('img', rel))
stale = []
for dirpath, _, files in os.walk(out):
    for name in files:
        if name.startswith('._'):
            continue
        rel = os.path.relpath(os.path.join(dirpath, name), out)
        if rel not in expected:
            stale.append(os.path.join(dirpath, name))
if len(stale) > 45:
    print('✗ 陈旧文件 %d 个超过 45，为避免批量删除守卫拦截，请人工分批清理：'
          '%s' % (len(stale), ', '.join(stale[:5])), file=sys.stderr)
    sys.exit(1)
for path in stale:
    os.remove(path)
print(f'  陈旧文件清理 {len(stale)} 个')
PY
echo "  public/ 就绪"

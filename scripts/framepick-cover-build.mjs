// Build platform-original covers for Framepick films.
//
//   node scripts/framepick-cover-build.mjs --dry-run   report only
//   node scripts/framepick-cover-build.mjs             download + convert + update the store
//   node scripts/framepick-cover-build.mjs --only yabiao,tower32
//   node scripts/framepick-cover-build.mjs --ffmpeg /path/to/ffmpeg
//
// Policy (2026-11-03): the site no longer generates its own cover art. Every
// published film shows the cover chosen by its original platform:
//   - bilibili: permanent `pic` URL from the public view API (no login);
//   - douyin:   signed PC-web cover captured from the video detail page by
//               scripts/framepick-cover-douyin.js (ego-browser), archived in
//               docs/framepick-cover-20261103/douyin-covers.json.
// Covers are downscaled proportionally to a 640px-wide webp and stored next to
// the page; the raw download stays in reel/img/raw/ which deployment ignores.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLibraryStore } = require('../server/framepick-library.cjs');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const dryRun = process.argv.includes('--dry-run');
const only = (arg('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const root = path.resolve(arg('--site') || '.');
const rawDir = path.join(root, 'img', 'raw');
const coversDoc = path.join(root, 'docs', 'framepick-cover-20261103', 'douyin-covers.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const FALLBACK_FFMPEG = '/Users/linjunjie/Downloads/type 助手/saydra/node_modules/ffmpeg-static/ffmpeg';
// 首屏那张大图要的宽度；低于 900 的母版就别另存一档了，省得产出一堆没用的近似尺寸。
const LARGE_WIDTH = 1280;
const LARGE_MIN_WIDTH = 900;

function resolveFfmpeg() {
  const wanted = arg('--ffmpeg') || 'ffmpeg';
  try {
    execFileSync(wanted, ['-version'], { stdio: 'ignore' });
    return wanted;
  } catch (_) { /* fall through */ }
  if (fs.existsSync(FALLBACK_FFMPEG)) return FALLBACK_FFMPEG;
  throw new Error('找不到 ffmpeg：用 --ffmpeg 指定可执行文件路径');
}

function bvidOf(url) {
  return String(url || '').match(/BV[0-9A-Za-z]{10}/)?.[0] || '';
}

async function fetchBilibiliCover(url) {
  const bvid = bvidOf(url);
  if (!bvid) throw new Error('无法从链接里解析 BV 号');
  const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`B 站接口 ${response.status}`);
  const payload = await response.json();
  if (payload.code !== 0) throw new Error(`B 站接口 code=${payload.code}：${payload.message}`);
  const pic = String(payload.data?.pic || '').replace(/^http:\/\//, 'https://');
  if (!pic) throw new Error('B 站接口未返回封面');
  return pic;
}

function douyinCoverMap() {
  return JSON.parse(fs.readFileSync(coversDoc, 'utf8'));
}

async function download(url, destination) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1024) throw new Error(`下载内容过小（${bytes.length}B），疑似错误响应`);
  fs.writeFileSync(destination, bytes);
  return bytes.length;
}

function probeSize(ffmpeg, file) {
  // ffmpeg 没有 output file 时以非零码退出，但媒体信息已经打在 stderr 上，
  // 抛出的 error.stderr 正是要解析的内容。
  let output = '';
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    output = String(error.stderr || '');
  }
  const match = output.match(/Video:[^\n]*?, (\d{2,5})x(\d{2,5})/);
  if (!match) throw new Error(`无法识别图片尺寸：${file}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function convertToWebp(ffmpeg, source, target, width, height) {
  execFileSync(ffmpeg, [
    '-hide_banner', '-y', '-i', source,
    '-vf', `scale=${width}:${height}:flags=lanczos`,
    '-c:v', 'libwebp', '-q:v', '82',
    target,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
}

const ffmpeg = resolveFfmpeg();
const store = createLibraryStore({});
const films = store.listFilms('published').filter((film) => !only.length || only.includes(film.id));
const douyinCovers = fs.existsSync(coversDoc) ? douyinCoverMap() : {};
fs.mkdirSync(rawDir, { recursive: true });

const done = [];
const failed = [];
for (const film of films) {
  try {
    let sourceCover = film.sourceCover || '';
    if (!sourceCover && film.source === 'bilibili') sourceCover = await fetchBilibiliCover(film.sourceUrl);
    if (!sourceCover && film.source === 'douyin') sourceCover = douyinCovers[film.id] || '';
    if (!sourceCover) throw new Error(`没有平台封面：${film.source === 'douyin' ? '跑 scripts/framepick-cover-douyin.js 更新 douyin-covers.json' : '来源平台暂无取封面通道'}`);

    const rawFile = path.join(rawDir, `${film.id}-cover.jpg`);
    let size;
    if (fs.existsSync(rawFile) && fs.statSync(rawFile).size > 1024) {
      size = probeSize(ffmpeg, rawFile);
    } else {
      size = null;
    }
    if (!size) {
      const bytes = await download(sourceCover, rawFile);
      size = probeSize(ffmpeg, rawFile);
      console.log(`  ↓ ${film.id} ${size.width}x${size.height} ${(bytes / 1024).toFixed(0)}KB`);
    }

    // 等比缩放到 640px 宽，高度按原比例取偶；卡片容器 16:10 + object-fit:cover
    // 会自己裁掉多余部分，所以不同来源的比例可以混排。
    const targetWidth = 640;
    const targetHeight = Math.max(2, Math.round((targetWidth * size.height) / size.width / 2) * 2);
    const webpFile = path.join(root, 'img', `${film.id}-640w.webp`);
    if (!dryRun) convertToWebp(ffmpeg, rawFile, webpFile, targetWidth, targetHeight);

    // 大图一档：首屏主推在桌面上铺到 800 多像素宽，640w 放大看是糊的。
    // 母版够大就再出一张，宽度取 min(1280, 母版宽度)——不放大凑数，
    // 文件名带真实宽度（`-1152w.webp` 就是 1152），生成器按文件名写 srcset。
    const largeWidth = Math.min(LARGE_WIDTH, size.width);
    let largeFile = '';
    if (largeWidth >= LARGE_MIN_WIDTH) {
      const largeHeight = Math.max(2, Math.round((largeWidth * size.height) / size.width / 2) * 2);
      largeFile = path.join(root, 'img', `${film.id}-${largeWidth}w.webp`);
      if (!dryRun) convertToWebp(ffmpeg, rawFile, largeFile, largeWidth, largeHeight);
    }

    const patch = {
      sourceCover,
      cover: `img/${film.id}-640w.webp`,
      coverAlt: `《${film.title}》原片封面`,
      coverNote: '原片封面',
      coverWidth: targetWidth,
      coverHeight: targetHeight,
    };
    if (!dryRun) store.updateFilm(film.id, patch, { actor: 'cover-build' });
    done.push({ id: film.id, source: film.source, ...size, targetHeight, large: largeFile ? largeWidth : 0 });
  } catch (error) {
    failed.push({ id: film.id, reason: error.message });
  }
}

console.log(`\n封面${dryRun ? '（dry-run，未写库）' : '已更新'}：成功 ${done.length} · 失败 ${failed.length}`);
for (const row of done) console.log(`  ✓ ${row.id}（${row.source}）${row.width}x${row.height} → 640x${row.targetHeight}${row.large ? ` + ${row.large}w` : ''}`);
for (const row of failed) console.log(`  ✗ ${row.id}：${row.reason}`);
if (failed.length && !dryRun) console.log('\n失败的条目保持原封面不变，可修复后重跑。');
if (dryRun) console.log('\n去掉 --dry-run 执行下载、转换与写库。');
process.exit(failed.length ? 1 : 0);

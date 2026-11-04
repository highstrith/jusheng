// Capture Douyin PC-web covers for published Framepick films (ego-browser script).
//
//   ego-browser nodejs < scripts/framepick-cover-douyin.js
//
// Why a browser: Douyin renders the cover client-side. Server-rendered HTML has
// no og:image, no video[poster], and `iesdouyin.com/share/video/<id>` only 302s
// to the PC page. The logged-in ego tab exposes the real cover as an <img> with
// `biz_tag=pcweb_cover&s=PackSourceEnum_AWEME_DETAIL`.
//
// Output: docs/framepick-cover-20261103/douyin-covers.json (slug → cover URL).
// Then run `node scripts/framepick-cover-build.mjs` to download and convert.
//
// Known limits (2026-11-03):
//   - Douyin only serves a 4:3 cropped cover (440x330, `image-cut-tos-priv`).
//     The `~tplv-...:330` suffix is part of the signature, so the size cannot be
//     raised by editing the URL; the uncropped `origin_cover` is only reachable
//     through the signed aweme detail API and is not used here.
//   - The signed URL expires in 2036, so it is stable enough to archive.
import fs from 'node:fs/promises';

const LIBRARY = '/Users/linjunjie/.framepick/library/library.json';
const OUT = '/Volumes/E61--/网站/jusheng/docs/framepick-cover-20261103/douyin-covers.json';
const WAIT_MS = 4500;

const task = await taskSpace('抖音封面抓取');
const page = task.page('p1');

const library = JSON.parse(await fs.readFile(LIBRARY, 'utf8'));
const films = (library.films || []).filter((film) => film.source === 'douyin' && film.status === 'published');
console.log(`待抓取抖音作品：${films.length} 部`);

const covers = {};
let failed = 0;
for (const film of films) {
  const id = String(film.sourceUrl || '').match(/video\/(\d{6,})/)?.[1] || '';
  if (!id) { console.error(`! ${film.id} 链接里没有视频 ID`); failed += 1; continue; }
  try {
    await page.goto(`https://www.douyin.com/video/${id}`);
    await page.waitForTimeout(WAIT_MS);
    const url = await page.evaluate(() => {
      const html = document.documentElement.outerHTML.replace(/&amp;/g, '&');
      const all = html.match(/https?:\/\/[^"'\\ )]+?\.douyinpic\.com\/[^"'\\ )]+/g) || [];
      return all.find((item) => /PackSourceEnum_AWEME_DETAIL/.test(item)) || '';
    });
    if (!url) throw new Error('页面里找不到 AWEME_DETAIL 封面');
    covers[film.id] = url;
    console.log(`  ✓ ${film.id}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${film.id}：${error.message}`);
  }
}

const previous = await fs.readFile(OUT, 'utf8').then(JSON.parse).catch(() => ({}));
const merged = { ...previous, ...covers, fetchedAt: new Date().toISOString().slice(0, 10) };
await fs.writeFile(OUT, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
console.log(`\n写入 ${OUT}：新增/更新 ${Object.keys(covers).length} 条，失败 ${failed} 条`);
console.log('下一步：node scripts/framepick-cover-build.mjs');

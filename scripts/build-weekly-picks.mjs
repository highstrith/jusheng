// 橘生梦厂「按周推荐」：本期榜单只收录上一自然周首发的作品。
//
//   node scripts/build-weekly-picks.mjs                  生成当期周榜（写 index.html + data/weekly-picks.json）
//   node scripts/build-weekly-picks.mjs --check          只校验页面与归档是否已是最新，不落地
//   node scripts/build-weekly-picks.mjs --week 2026-11-09  以指定日期（北京时间）为「今天」重算，用于补档/测试
//   node scripts/build-weekly-picks.mjs --json           打印机器可读报告
//
// 口径（2026-11-07 用户定的方向，执行方细化）：
//   · 「新出」= 作品在原平台的发布日期 originalReleaseDate，不是本站收录日 intakeDate；
//     日期必须精确到日，只到「2026-08」这类模糊值不参与，避免把旧片说成上周新片。
//   · 窗口 = 上一自然周（周一 00:00 至周日 23:59，北京时间），本周展示、下周一切换。
//   · 「优秀」= 已通过编辑终审上架（status=published）的作品；上架本身就是筛选，
//     不编造评分、播放量或排名依据。按 curatedOrder（编辑精选顺序）排列，最多 5 部。
//   · 不足 5 部就如实展示实际数量，0 部显示空状态；不从窗口外借片凑数。
//   · 期次用本周 ISO 周数，页面上的两个 <time> 是「影片首发窗口」，不冒充影片上线时间。
//
// 片库数据在仓库外：~/.framepick/library/library.json（可用 FRAMEPICK_LIBRARY_FILE 覆盖）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const checkOnly = process.argv.includes('--check');
const asJson = process.argv.includes('--json');
const indexPath = path.join(repoRoot, 'index.html');
const archivePath = path.join(repoRoot, 'data', 'weekly-picks.json');
const libraryPath = process.env.FRAMEPICK_LIBRARY_FILE
  || path.join(process.env.FRAMEPICK_LIBRARY_DATA_DIR || path.join(process.env.HOME || '', '.framepick', 'library'), 'library.json');
const MAX_PICKS = 5;
const START = '<!-- WEEKLY_PICKS_START -->';
const END = '<!-- WEEKLY_PICKS_END -->';

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const pad = (n) => String(n).padStart(2, '0');
const utcDay = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const shiftDays = (iso, days) => isoOf(utcDay(iso) + days * 86400000);
const shortDate = (iso) => `${iso.slice(5, 7)}.${iso.slice(8, 10)}`;
const cnDate = (iso) => `${Number(iso.slice(0, 4))} 年 ${Number(iso.slice(5, 7))} 月 ${Number(iso.slice(8, 10))} 日`;

// 北京时间「今天」；--week 用于回溯补档与测试。
function todayInBeijing() {
  const override = arg('--week');
  if (override) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(override)) throw new Error(`--week 需要 YYYY-MM-DD，收到 ${override}`);
    return override;
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// ISO 8601 周数：以该周周四所在年份为周所属年。
function isoWeek(iso) {
  const thursday = new Date(utcDay(iso));
  thursday.setUTCDate(thursday.getUTCDate() - ((thursday.getUTCDay() + 6) % 7) + 3);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  return { year, week: 1 + Math.round((thursday - firstThursday) / (7 * 86400000)) };
}

const mondayOffset = (iso) => (new Date(utcDay(iso)).getUTCDay() + 6) % 7;
const thisMonday = (today) => shiftDays(today, -mondayOffset(today));
const releaseStart = (monday) => shiftDays(monday, -7);
const releaseEnd = (monday) => shiftDays(monday, -1);

// 推荐语取第一句；过长时在句读处收住，只做展示层裁剪，不改事实。
function reasonOf(film) {
  const text = String(film.recommendation || film.description || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const stop = text.indexOf('。');
  let out = stop >= 0 ? text.slice(0, stop + 1) : text;
  if ([...out].length > 54) {
    const cut = [...out].slice(0, 54).join('');
    const boundary = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf('；'));
    out = (boundary > 30 ? cut.slice(0, boundary) : cut) + '…';
  }
  return out;
}

const genreFallback = {
  fantasy: '奇幻', scifi: '科幻', wuxia: '武侠', xianxia: '仙侠', urban: '都市',
  romance: '情感', healing: '治愈', thriller: '悬疑', comedy: '喜剧', horror: '惊悚',
};
const genreOf = (film) => String(film.kind || '').split(/\s*\/\s*/)[0].trim()
  || genreFallback[(film.genres || [])[0]] || '影像';
const sourceLabels = { douyin: '抖音', bilibili: '哔哩哔哩', xiaohongshu: '小红书', youtube: 'YouTube', x: 'X' };

function totalRuntime(films) {
  let seconds = 0;
  for (const film of films) {
    const m = /^(?:(\d+):)?(\d{1,3}):(\d{2})$/.exec(String(film.runtime || '').trim());
    if (!m) return null;
    seconds += (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
  }
  const mins = Math.floor(seconds / 60);
  return `${mins} 分 ${pad(seconds % 60)} 秒`;
}

function pickCard(film, index) {
  const rank = pad(index + 1);
  const title = String(film.title || '').trim();
  const href = String(film.sourceUrl || '').trim();
  const cover = String(film.cover || '').trim();
  const coverAlt = String(film.coverAlt || `${title}原片封面`).trim();
  const release = String(film.originalReleaseDate || '').trim();
  return `      <li class="pick-card">
        <a class="pick-link" data-open-film="${escapeHtml(film.id)}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" aria-label="第 ${index + 1} 名：查看《${escapeHtml(title)}》">
          <div class="pick-cover"><img src="${escapeHtml(cover)}" width="${Number(film.coverWidth) || 640}" height="${Number(film.coverHeight) || 480}" alt="${escapeHtml(coverAlt)}" loading="lazy" decoding="async"></div>
          <span class="pick-meta"><span class="pick-rank" aria-hidden="true">${rank}</span><span class="pick-genre">${escapeHtml(genreOf(film))}</span><span class="pick-runtime">${escapeHtml(film.runtime || '')}</span></span><h3>${escapeHtml(title)}</h3>
        </a>
        <p class="pick-release"><time datetime="${escapeHtml(release)}">${shortDate(release)}</time> 首发 · ${escapeHtml(sourceLabels[film.source] || film.source || '')}</p>${reasonOf(film) ? `\n        <p class="pick-reason">${escapeHtml(reasonOf(film))}</p>` : ''}
      </li>`;
}

function sectionHtml(current, films) {
  const { start, end } = current;
  const label = `${current.isoYear} · 第 ${current.isoWeek} 周`;
  const range = `<div class="picks-edition-range" aria-label="本期收录 2026 年 ${Number(start.slice(5, 7))} 月 ${Number(start.slice(8, 10))} 日至 ${Number(end.slice(5, 7))} 月 ${Number(end.slice(8, 10))} 日首发的作品"><time datetime="${start}">${shortDate(start)}</time><span>—</span><time datetime="${end}">${shortDate(end)}</time></div>`;
  const caption = `    <p class="picks-caption">上一周首发的新作 · 本周编选 · 每周一更新</p>`;
  const runtime = totalRuntime(films);
  const body = films.length
    ? `    <ol class="picks-grid" role="list" aria-label="本周推荐排名">
${films.map(pickCard).join('\n')}
    </ol>`
    : `    <p class="picks-empty">上一周（${shortDate(start)}—${shortDate(end)}）没有通过编选的新作。榜单不凑数，先去片库看看：<a href="#entries">探索全部作品</a></p>`;
  const note = films.length
    ? `每周一更新，本期收录上一周（${shortDate(start)}—${shortDate(end)}）首发的 ${films.length} 部作品，按首发日期排列。${runtime ? `合计 ${runtime}。` : ''}`
    : `每周一更新。本期没有可推荐的上周新作，往期作品仍在片库里。`;
  return `${START}
  <section class="rankings wrap editorial-picks" id="rankings" aria-labelledby="rankingsTitle">
    <div class="section-heading">
      <h2 id="rankingsTitle" tabindex="-1">本周推荐</h2>
      <div class="picks-edition"><span class="picks-edition-label">${label}</span>${range}</div>
      <a class="rankings-browse" href="#entries">探索片库</a>
    </div>
${caption}
${body}
    <p class="picks-note">${note}</p>
  </section>
${END}`;
}

const today = todayInBeijing();
const monday = thisMonday(today);
const start = releaseStart(monday);
const end = releaseEnd(monday);
const { year: isoYear, week: isoWeekNumber } = isoWeek(monday);
const library = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
const published = (library.films || []).filter((f) => f.status === 'published');
const candidates = published.filter((f) => {
  const date = String(f.originalReleaseDate || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= start && date <= end;
});
candidates.sort((a, b) => {
  const byDate = String(b.originalReleaseDate).localeCompare(String(a.originalReleaseDate));
  if (byDate) return byDate;
  const order = (a.curatedOrder ?? Infinity) - (b.curatedOrder ?? Infinity);
  return order || String(a.id).localeCompare(String(b.id));
});
const picks = candidates.slice(0, MAX_PICKS);
const current = {
  week: `${isoYear}-W${pad(isoWeekNumber)}`,
  isoYear, isoWeek: isoWeekNumber,
  displayStart: monday, displayEnd: shiftDays(monday, 6),
  start, end,
  films: picks.map((f) => ({
    id: f.id, title: f.title, releaseDate: f.originalReleaseDate,
    source: f.source, runtime: f.runtime || '', cover: f.cover,
  })),
  candidateCount: candidates.length,
};

const source = fs.readFileSync(indexPath, 'utf8');
const marker = new RegExp(`${START}[\\s\\S]*?${END}`);
if (!marker.test(source)) {
  console.error('✗ index.html 找不到周榜生成标记，请检查 WEEKLY_PICKS_START / END');
  process.exit(2);
}
const nextSection = sectionHtml(current, picks);
const nextHtml = source.replace(marker, nextSection);

const archive = fs.existsSync(archivePath) ? JSON.parse(fs.readFileSync(archivePath, 'utf8')) : { weeks: [] };
const history = (archive.weeks || []).filter((w) => w.week !== current.week);
history.push(current);
history.sort((a, b) => a.week.localeCompare(b.week));
const nextArchive = `${JSON.stringify({ weeks: history }, null, 2)}\n`;
const archiveCurrent = fs.existsSync(archivePath) ? fs.readFileSync(archivePath, 'utf8') : '';
const pageStale = nextHtml !== source;
const archiveStale = nextArchive !== archiveCurrent;

const report = {
  today, week: current.week, displayWindow: [current.displayStart, current.displayEnd],
  releaseWindow: [start, end], candidates: candidates.length, picks: current.films.map((f) => f.id),
  pageStale, archiveStale,
};

if (checkOnly) {
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(`周榜 ${current.week}：上一周 ${shortDate(start)}—${shortDate(end)} 首发 ${candidates.length} 部，上榜 ${picks.length} 部 · ${pageStale || archiveStale ? '页面或归档需要重建' : '已是最新'}`);
  process.exit(pageStale || archiveStale ? 1 : 0);
}

if (pageStale) fs.writeFileSync(indexPath, nextHtml, 'utf8');
if (archiveStale) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, nextArchive, 'utf8');
}
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`周榜 ${current.week}：本期展示 ${shortDate(current.displayStart)}—${shortDate(current.displayEnd)}，收录上一周 ${shortDate(start)}—${shortDate(end)} 首发的 ${candidates.length} 部，上榜 ${picks.length} 部`);
  for (const film of current.films) console.log(`  ${shortDate(film.releaseDate)}  ${film.title}`);
  console.log(pageStale || archiveStale ? '  已写入 index.html 与 data/weekly-picks.json' : '  页面与归档无需改动');
}

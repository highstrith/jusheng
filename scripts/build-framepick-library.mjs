// Render published Framepick films into the static catalogue page.
//
//   node scripts/build-framepick-library.mjs            rewrite reel/index.html
//   node scripts/build-framepick-library.mjs --check    fail if the page is stale
//   node scripts/build-framepick-library.mjs --site .   standalone repository root
//
// Only public fields are written. Rights, reviewer notes and pricing stay in the
// store outside the repository (docs/framepick-library-operations-20261102.md).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { GENRES, SOURCES, ACCESS, CATEGORIES, COMPLETION_LABELS } from '../server/framepick-library.cjs';
import { resolveHeroId, pinnedFeatureId } from './lib/feature.mjs';

const require = createRequire(import.meta.url);
const { createLibraryStore } = require('../server/framepick-library.cjs');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
// 首屏主推也是一块由数据驱动的区块：默认跟本周推荐的第一部走（每周一自动换），
// 想固定某部就写 data/feature-film.json（`--feature <id>`）。
function featureRange(source) {
  const match = source.match(/<article class="feature[^"]*"[^>]*>/);
  if (!match) throw new Error('找不到 <article class="feature">');
  const end = source.indexOf('</article>', match.index);
  if (end < 0) throw new Error('主推区块没有闭合');
  return { start: match.index, end: end + '</article>'.length };
}

const asJson = process.argv.includes('--json');
const checkOnly = process.argv.includes('--check');
const siteDir = path.resolve(arg('--site') || '.');
const indexPath = path.join(siteDir, 'index.html');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function gridRange(source) {
  // 锚点容忍栅格上的其它属性（data-limit / data-total 由这里自己维护）。
  const anchor = source.match(/<div class="grid" id="filmGrid"[^>]*>/);
  if (!anchor) throw new Error('找不到 <div class="grid" id="filmGrid">');
  const start = anchor.index;
  const open = start + anchor[0].length;
  let depth = 1;
  let cursor = open;
  while (depth > 0) {
    const nextOpen = source.indexOf('<div', cursor);
    const nextClose = source.indexOf('</div>', cursor);
    if (nextClose < 0) throw new Error('#filmGrid 的 </div> 缺失');
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + 4;
    } else {
      depth -= 1;
      cursor = nextClose + 6;
      if (depth === 0) return { open, close: nextClose };
    }
  }
  throw new Error('#filmGrid 结构无法解析');
}

function card(film, index) {
  const titleId = `c${index + 1}Title`;
  const score = film.editorScore === null || film.editorScore === undefined;
  const scoreValue = score ? '' : film.editorScore.toFixed(1);
  const scoreText = score ? '待评' : film.editorScore.toFixed(1);
  const sourceLabel = SOURCES[film.source]?.label || film.source;
  const badge = ACCESS[film.access] || '免费精选';
  const watchLabel = `前往${sourceLabel}`;
  const alt = film.coverAlt || `${film.title}封面`;
  const note = film.coverNote ? `<span class="image-note">${escapeHtml(film.coverNote)}</span>` : '';
  const recommendation = film.recommendation
    ? `<p class="recommendation" hidden>${escapeHtml(film.recommendation)}</p>` : '<p class="recommendation" hidden></p>';
  const episode = film.episode ? `<p class="episode" hidden>${escapeHtml(film.episode)}</p>` : '<p class="episode" hidden></p>';
  // 连载状态与体量：卡片上只露一个小标签，完整信息在详情弹窗里读这几段隐藏文本。
  const completion = film.completion || '';
  const statusTag = completion && COMPLETION_LABELS[completion]
    ? `<span class="status-tag" data-completion="${escapeHtml(completion)}">${escapeHtml(COMPLETION_LABELS[completion])}</span>`
    : '';
  const volume = film.volume ? `<p class="volume" hidden>${escapeHtml(film.volume)}</p>` : '<p class="volume" hidden></p>';
  const relation = film.relation ? `<p class="relation" hidden>${escapeHtml(film.relation)}</p>` : '<p class="relation" hidden></p>';

  return `      <article class="card" data-film="${escapeHtml(film.id)}" data-score="${escapeHtml(scoreValue)}" data-category="${escapeHtml(film.category)}" data-genres="${escapeHtml(film.genres.join(' '))}" data-source="${escapeHtml(film.source)}" data-access="${escapeHtml(film.access)}" data-date="${escapeHtml(film.intakeDate)}" data-published="${escapeHtml(film.originalReleaseDate || '')}" data-completion="${escapeHtml(completion)}" aria-labelledby="${titleId}">
        <a class="card-media" data-open-film="${escapeHtml(film.id)}" href="${escapeHtml(film.sourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="查看《${escapeHtml(film.title)}》"><img src="${escapeHtml(film.cover)}" width="${film.coverWidth}" height="${film.coverHeight}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async"><span class="access-badge">${escapeHtml(badge)}</span>${note}</a>
        <div class="card-body"><div class="card-topline"><span class="kind">${escapeHtml(film.kind)}</span><span class="card-runtime">${escapeHtml(film.runtime)}</span>${statusTag}<span class="score" aria-label="编辑评分：${escapeHtml(scoreText)}">${escapeHtml(scoreText)}</span></div><h3 id="${titleId}">${escapeHtml(film.title)}</h3><p class="film-author"><span class="author-name">${escapeHtml(film.author)}</span><span class="source-name">${escapeHtml(sourceLabel)}</span></p><p class="desc">${escapeHtml(film.description)}</p>${recommendation}${episode}${volume}${relation}<div class="card-actions"><button class="details-button js-only" type="button" data-open-film="${escapeHtml(film.id)}">作品详情</button><a class="watch" data-outbound-film="${escapeHtml(film.id)}" href="${escapeHtml(film.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(watchLabel)}<svg aria-hidden="true"><use href="#arrow"/></svg></a><button class="save-button js-only" type="button" data-save-film="${escapeHtml(film.id)}" aria-label="收藏《${escapeHtml(film.title)}》" aria-pressed="false"><svg aria-hidden="true"><use href="#bookmark"/></svg></button></div></div>
      </article>`;
}

// 片库页（library.html）用的数据：只放公开字段，由前端渲染并分页。
function filmData(film) {
  const unscored = film.editorScore === null || film.editorScore === undefined;
  return {
    id: film.id,
    title: film.title,
    kind: film.kind,
    genres: film.genres,
    category: film.category,
    source: film.source,
    sourceLabel: SOURCES[film.source]?.label || film.source,
    access: film.access,
    badge: ACCESS[film.access] || '免费精选',
    runtime: film.runtime,
    author: film.author,
    description: film.description,
    recommendation: film.recommendation || '',
    cover: film.cover,
    coverWidth: film.coverWidth,
    coverHeight: film.coverHeight,
    coverAlt: film.coverAlt || `${film.title}封面`,
    coverNote: film.coverNote || '',
    sourceUrl: film.sourceUrl,
    watchLabel: `前往${SOURCES[film.source]?.label || film.source}`,
    score: unscored ? null : Number(film.editorScore.toFixed(1)),
    scoreText: unscored ? '待评' : film.editorScore.toFixed(1),
    completion: film.completion || '',
    statusLabel: (film.completion && COMPLETION_LABELS[film.completion]) || '',
    // 集数／体量／续集关系：片库页不显示，但首页分享链接靠这份数据补详情弹窗。
    episode: film.episode || '',
    volume: film.volume || '',
    relation: film.relation || '',
    intakeDate: film.intakeDate,
    published: film.originalReleaseDate || '',
  };
}

function setTagText(source, pattern, render) {
  const match = source.match(pattern);
  if (!match) return source;
  return source.replace(pattern, () => render(match));
}

// Category tabs carry a <span> count only when the category has films.
function updateCategoryCounts(source, films) {
  const totals = new Map();
  for (const film of films) totals.set(film.category, (totals.get(film.category) || 0) + 1);
  return source.replace(/<button type="button" data-category="([a-z]+)"([^>]*)>([\s\S]*?)<\/button>/g, (whole, category, attrs, inner) => {
    const count = category === 'all' ? films.length : (totals.get(category) || 0);
    const label = inner.replace(/<span>\d+<\/span>/, '').trim();
    return `<button type="button" data-category="${category}"${attrs}>${label}${count ? ` <span>${count}</span>` : ''}</button>`;
  });
}

const store = createLibraryStore({ dataDir: process.env.FRAMEPICK_LIBRARY_DATA_DIR });
const films = store.publishedFilms();
// 首屏主推：--feature <id> 锁定某部，--feature auto 交回「本周推荐第一部」每周自动换。
const featureArg = arg('--feature');
if (featureArg) {
  const lockPath = path.join(siteDir, 'data', 'feature-film.json');
  if (featureArg === 'auto') {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    console.log('主推已交回本周推荐（每周自动换）');
  } else if (!films.some((film) => film.id === featureArg)) {
    console.error(`没有这部作品：${featureArg}。先用 scripts/framepick-library-cli.mjs list 查一下 id。`);
    process.exit(2);
  } else {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath,
      `${JSON.stringify({ id: featureArg, updatedAt: new Date().toISOString().slice(0, 10) }, null, 2)}\n`);
    console.log(`主推锁定为 ${featureArg}`);
  }
}
if (!fs.existsSync(indexPath)) {
  console.error(`找不到片库页面：${indexPath}`);
  process.exit(2);
}
const original = fs.readFileSync(indexPath, 'utf8');
const { open, close } = gridRange(original);
// 首页只铺一屏：最近收录的 9 部，并让开本周推荐已经展示过的作品（上面刚铺过一遍，
// 再摆一次就是重复内容）。作品涨到几百部，首页长度也不会变；完整片库在 library.html。
const homeLimit = Number(arg('--home-limit') ?? 9);
function thisWeekPicks() {
  const archive = path.join(siteDir, 'data', 'weekly-picks.json');
  if (!fs.existsSync(archive)) return [];
  try {
    const weeks = JSON.parse(fs.readFileSync(archive, 'utf8')).weeks || [];
    const last = weeks[weeks.length - 1];
    // 补选（为铺满榜单从片库补上的）在首页上半页已经出现过，下半页同样让开。
    return [...(last?.films || []), ...(last?.supplement || [])].map((film) => film.id).filter(Boolean);
  } catch {
    return [];
  }
}
const thisWeekPickIds = () => new Set(thisWeekPicks());
const picksShown = thisWeekPickIds();
const newestFirst = films
  .map((film, index) => ({ film, index }))
  .sort((a, b) => String(b.film.intakeDate || '').localeCompare(String(a.film.intakeDate || '')) || a.index - b.index)
  .map((entry) => entry.film);
const fresh = newestFirst.filter((film) => !picksShown.has(film.id));
const pool = fresh.length >= (Number.isFinite(homeLimit) ? homeLimit : 9) ? fresh : newestFirst;
const whileHome = Number.isFinite(homeLimit) && homeLimit > 0 ? pool.slice(0, homeLimit) : pool;
// 主推选谁：手选锁定 > 本周推荐第一部 > 最近收录第一部，永远有东西可推。
// 前两条与 scripts/build-weekly-picks.mjs 共用 lib/feature.mjs，规则不会各写一份。
function pickFeature(list, newestFirst) {
  const publishedIds = new Set(list.map((film) => film.id));
  const heroId = resolveHeroId({ siteDir, picks: thisWeekPicks(), publishedIds });
  const hero = heroId ? list.find((film) => film.id === heroId) : null;
  if (hero) {
    // 角标说实话：钉住的写「编辑选片」，跟榜走的写「本周主推」。
    return { film: hero, label: pinnedFeatureId(siteDir) === hero.id ? '编辑选片' : '本周主推' };
  }
  if (newestFirst.length) return { film: newestFirst[0], label: '最新收录' };
  return null;
}
// 简介第一句，超长截断加省略号：首屏位置窄，整段会顶掉按钮。
function firstSentence(text, limit = 46) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const match = clean.match(/^[^。！？!?]*[。！？!?]/);
  const sentence = (match ? match[0] : clean).trim();
  return sentence.length > limit ? `${sentence.slice(0, limit)}…` : sentence;
}
// 首屏轮播：第一张是主推，其余从「没进首页九张、也不在本周榜单」的作品里顺补，最多六张。
// 这样首屏不跟下面的榜单／栅格重复，片库长尾也有露脸机会；六张一轮约 42 秒，够看完两张再翻。
const HERO_SLIDES = 6;
function heroSlides(hero, pool) {
  if (!hero) return [];
  const taken = new Set([...whileHome.map((film) => film.id), ...picksShown, hero.film.id]);
  const extras = pool.filter((film) => !taken.has(film.id)).slice(0, HERO_SLIDES - 1);
  return [hero, ...extras.map((film) => ({ film, label: '同样值得看' }))];
}
function heroSlide({ film, label }, index, total) {
  const active = index === 0;
  const sourceLabel = SOURCES[film.source]?.label || film.source;
  const alt = film.coverAlt || `${film.title}封面`;
  const note = film.coverNote ? `<span class="image-note">${escapeHtml(film.coverNote)}</span>` : '';
  const tags = (film.genres || [])
    .map((genre) => GENRES[genre])
    .filter(Boolean)
    .slice(0, 2)
    .map((genre) => `<span>${escapeHtml(genre)}</span>`)
    .join('');
  // 首屏那行说明不另写：取简介第一句（题材已经在标签行，再写一遍就重复了）；
  // 实在没有简介才退回「题材 · 来源」。零维护，也不会和卡片信息打架。
  const line = firstSentence(film.description)
    || [film.kind, sourceLabel].filter(Boolean).join(' · ');
  const meta = [film.author, [film.episode, film.runtime].filter(Boolean).join(' / ')]
    .filter(Boolean)
    .map((text) => `<span>${escapeHtml(text)}</span>`)
    .join('');
  // 不在当前页的整块从无障碍树和 Tab 序列里摘掉：键盘不会落到看不见的链接上。
  const rest = active ? '' : ' inert aria-hidden="true"';
  // 首张是 LCP 元素，优先加载；其余等切换前由脚本预热，首屏体积不为没露脸的封面买单。
  const load = active ? 'fetchpriority="high"' : 'loading="lazy"';
  return `<div class="hero-slide${active ? ' is-active' : ''}" role="group" aria-roledescription="幻灯片" aria-label="第 ${index + 1} 部，共 ${total} 部：${escapeHtml(film.title)}"${rest}>
      <a class="feature-media" href="${escapeHtml(film.sourceUrl)}" data-open-film="${escapeHtml(film.id)}" target="_blank" rel="noopener noreferrer" aria-label="查看《${escapeHtml(film.title)}》">
        <img src="${escapeHtml(film.cover)}" sizes="(max-width:760px) calc(100vw - 36px), 65vw" width="${film.coverWidth}" height="${film.coverHeight}" alt="${escapeHtml(alt)}" ${load} decoding="async">
        <span class="feature-label">${escapeHtml(label)}</span>${note}
      </a>
      <div class="feature-copy"><div class="film-tags">${tags}</div><h2>${escapeHtml(film.title)}</h2><p>${escapeHtml(line)}</p><div class="feature-meta">${meta}</div><a class="watch" data-outbound-film="${escapeHtml(film.id)}" href="${escapeHtml(film.sourceUrl)}" target="_blank" rel="noopener noreferrer">前往${escapeHtml(sourceLabel)}观看<svg aria-hidden="true"><use href="#arrow"/></svg></a><span class="watch-note">免费原片 · 在原平台播放</span></div>
    </div>`;
}
function heroCarousel(slides) {
  if (!slides.length) return '';
  const body = slides.map((slide, index) => heroSlide(slide, index, slides.length)).join('\n    ');
  // 只有一张时不生成控件：没有可切换的，按钮只是噪音。js-only 让无脚本时也不出现。
  const controls = slides.length > 1 ? `
    <div class="hero-controls js-only">
      <button type="button" class="hero-arrow" data-hero-prev aria-label="上一部"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 5-7 7 7 7"/></svg></button>
      <div class="hero-dots">${slides.map(({ film }, index) => `<button type="button" class="hero-dot" data-hero-dot="${index}" aria-label="第 ${index + 1} 部：${escapeHtml(film.title)}"${index === 0 ? ' aria-current="true"' : ''}></button>`).join('')}</div>
      <button type="button" class="hero-arrow" data-hero-next aria-label="下一部"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg></button>
    </div>` : '';
  return `<article class="feature wrap" id="heroCarousel" aria-roledescription="轮播" aria-label="编辑主推">
    <div class="hero-track">
    ${body}
    </div>${controls}
  </article>`;
}

const grid = ['', ...whileHome.map(card), '    '].join('\n');
let next = original.slice(0, open) + grid + original.slice(close);
next = updateCategoryCounts(next, films);
// 主推必须在算「栅格外引用」之前换好，新主推才会被写进详情兜底数据。
const featured = pickFeature(films, newestFirst);
if (featured) {
  const span = featureRange(next);
  next = next.slice(0, span.start) + heroCarousel(heroSlides(featured, pool)) + next.slice(span.end);
}
next = next.replace(/(<p id="resultCount"[^>]*>)[^<]*(<\/p>)/, `$1共 ${films.length} 部 · 首页收录 ${whileHome.length} 部$2`);
next = next.replace(/(<span class="filter-note">)[^<]*(<\/span>)/, `$1已收录 ${films.length} 部 · 正式评分陆续补充$2`);
// 作品数只在这一个地方算：首页文案、分享卡片、无 JS 兜底、片库页标题全部跟着走，
// 免得每轮自动上新都把「42 部」这种旧数字再放大一次。
next = next.replace(/<div class="grid" id="filmGrid"([^>]*)>/, (whole, attrs) =>
  `<div class="grid" id="filmGrid"${attrs.replace(/\s*data-total="[^"]*"/, '')} data-total="${films.length}">`);
next = next.replace(/(<span data-film-total>)\d*(<\/span>)/, `$1${films.length}$2`);
next = next.replace(/(<meta property="og:description" content=")\d+( 部筛过的 AI 短片)/, `$1${films.length}$2`);

// 本周推荐和主推引用的作品可能不在首页九张卡里。弹窗按 id 取数，缺了就打不开，
// 所以把「页面别处引用了、栅格里没有」的片单独写一份精简数据给弹窗用。
const homeIds = new Set(whileHome.map((film) => film.id));
const outsideGrid = next.split(grid).join('');
const referenced = new Set([...outsideGrid.matchAll(/data-open-film="([^"]+)"/g)].map((m) => m[1]));
const extras = films
  .filter((film) => referenced.has(film.id) && !homeIds.has(film.id))
  .map((film) => ({
    id: film.id, title: film.title, kind: film.kind, category: film.category,
    author: film.author, source: film.source, episode: film.episode || '',
    statusLabel: (film.completion && COMPLETION_LABELS[film.completion]) || '',
    volume: film.volume || '', relation: film.relation || '',
    published: film.originalReleaseDate || '', description: film.description,
    recommendation: film.recommendation || '', cover: film.cover,
    coverWidth: film.coverWidth, coverHeight: film.coverHeight,
    coverAlt: film.coverAlt || `${film.title}封面`, sourceUrl: film.sourceUrl,
    score: film.editorScore === null || film.editorScore === undefined ? null : Number(film.editorScore.toFixed(1))
  }));
const extrasJson = JSON.stringify(extras).replace(/</g, '\\u003c');
const extrasTag = `<script id="detailExtras">window.FRAMEPICK_DETAIL_EXTRAS = ${extrasJson};</script>`;
if (next.includes('id="detailExtras"')) {
  next = next.replace(/<script id="detailExtras">[\s\S]*?<\/script>/, () => extrasTag);
} else {
  next = next.replace(/<script src="framepick\.js/, (whole) => `${extrasTag}\n${whole}`);
}

// 片库页的静态小标题同样跟着数据走（前端渲染前也能读到正确的数）。
const libraryPath = path.join(siteDir, 'library.html');
const libOriginal = fs.existsSync(libraryPath) ? fs.readFileSync(libraryPath, 'utf8') : '';
const libNext = libOriginal.replace(/(<p class="lib-meta" id="libMeta">)[^<]*(<\/p>)/, `$1共 ${films.length} 部 · 每周更新$2`);
const libStale = libOriginal !== '' && libNext !== libOriginal;

const unknownGenres = [...new Set(films.flatMap((film) => film.genres))].filter((genre) => !GENRES[genre]);
const unknownCategories = [...new Set(films.map((film) => film.category))].filter((category) => !CATEGORIES[category]);

// 片库页的独立数据文件：首页只铺一屏，完整列表在 library.html 里按页渲染。
const dataPath = path.join(siteDir, 'films-data.js');
const dataSource = `// 由 scripts/build-framepick-library.mjs 生成，请勿手工编辑。\nwindow.FRAMEPICK_FILMS = ${JSON.stringify(films.map(filmData), null, 2)};\n`;
const dataCurrent = fs.existsSync(dataPath) ? fs.readFileSync(dataPath, 'utf8') : '';
const dataStale = dataCurrent !== dataSource;

if (checkOnly) {
  const stale = next !== original || dataStale || libStale;
  if (asJson) console.log(JSON.stringify({ stale, films: films.length, homeLimit: whileHome.length, unknownGenres, unknownCategories }, null, 2));
  else console.log(stale ? `片库页面与作品表不一致：${films.length} 部已上架作品需要重新生成` : `片库页面已是最新：${films.length} 部已上架作品`);
  process.exit(stale ? 1 : 0);
}

if (next !== original) fs.writeFileSync(indexPath, next, 'utf8');
if (libStale) fs.writeFileSync(libraryPath, libNext, 'utf8');
if (dataStale) fs.writeFileSync(dataPath, dataSource, 'utf8');
const report = { siteDir, films: films.length, homeLimit: whileHome.length, written: next !== original || dataStale || libStale, unknownGenres, unknownCategories };
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`片库页面${report.written ? '已更新' : '无需改动'}：${siteDir} · ${films.length} 部已上架作品`);
  for (const genre of unknownGenres) console.log(`  提醒 题材 ${genre} 还没有中文筛选项，记得补 genreFilter 与题材字典`);
  for (const category of unknownCategories) console.log(`  提醒 类型 ${category} 不在已知类型表内`);
}

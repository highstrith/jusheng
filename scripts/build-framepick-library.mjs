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

const require = createRequire(import.meta.url);
const { createLibraryStore } = require('../server/framepick-library.cjs');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const asJson = process.argv.includes('--json');
const checkOnly = process.argv.includes('--check');
const siteDir = path.resolve(arg('--site') || '.');
const indexPath = path.join(siteDir, 'index.html');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function gridRange(source) {
  const start = source.indexOf('<div class="grid" id="filmGrid">');
  if (start < 0) throw new Error('找不到 <div class="grid" id="filmGrid">');
  const open = source.indexOf('>', start) + 1;
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
if (!fs.existsSync(indexPath)) {
  console.error(`找不到片库页面：${indexPath}`);
  process.exit(2);
}
const original = fs.readFileSync(indexPath, 'utf8');
const { open, close } = gridRange(original);
const grid = ['', ...films.map(card), '    '].join('\n');
let next = original.slice(0, open) + grid + original.slice(close);
next = updateCategoryCounts(next, films);
next = next.replace(/(<p id="resultCount"[^>]*>)[^<]*(<\/p>)/, `$1${films.length} 部公开精选$2`);
next = next.replace(/(<span class="filter-note">)[^<]*(<\/span>)/, `$1已收录 ${films.length} 部 · 正式评分陆续补充$2`);

const unknownGenres = [...new Set(films.flatMap((film) => film.genres))].filter((genre) => !GENRES[genre]);
const unknownCategories = [...new Set(films.map((film) => film.category))].filter((category) => !CATEGORIES[category]);

// 片库页的独立数据文件：首页只铺一屏，完整列表在 library.html 里按页渲染。
const dataPath = path.join(siteDir, 'films-data.js');
const dataSource = `// 由 scripts/build-framepick-library.mjs 生成，请勿手工编辑。\nwindow.FRAMEPICK_FILMS = ${JSON.stringify(films.map(filmData), null, 2)};\n`;
const dataCurrent = fs.existsSync(dataPath) ? fs.readFileSync(dataPath, 'utf8') : '';
const dataStale = dataCurrent !== dataSource;

if (checkOnly) {
  const stale = next !== original || dataStale;
  if (asJson) console.log(JSON.stringify({ stale, films: films.length, unknownGenres, unknownCategories }, null, 2));
  else console.log(stale ? `片库页面与作品表不一致：${films.length} 部已上架作品需要重新生成` : `片库页面已是最新：${films.length} 部已上架作品`);
  process.exit(stale ? 1 : 0);
}

if (next !== original) fs.writeFileSync(indexPath, next, 'utf8');
if (dataStale) fs.writeFileSync(dataPath, dataSource, 'utf8');
const report = { siteDir, films: films.length, written: next !== original || dataStale, unknownGenres, unknownCategories };
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`片库页面${report.written ? '已更新' : '无需改动'}：${siteDir} · ${films.length} 部已上架作品`);
  for (const genre of unknownGenres) console.log(`  提醒 题材 ${genre} 还没有中文筛选项，记得补 genreFilter 与题材字典`);
  for (const category of unknownCategories) console.log(`  提醒 类型 ${category} 不在已知类型表内`);
}

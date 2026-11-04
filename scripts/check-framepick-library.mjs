// Framepick catalogue linter. Run before committing a new film card.
//   node scripts/check-framepick-library.mjs            checks reel/
//   node scripts/check-framepick-library.mjs --site .   checks a standalone root
//   node scripts/check-framepick-library.mjs --json     machine-readable output
import fs from 'node:fs';
import path from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const asJson = process.argv.includes('--json');
const siteDir = path.resolve(arg('--site') || '.');
const indexPath = path.join(siteDir, 'index.html');

// Only the three first-wave sources are accepted today; X, YouTube and Kuaishou
// are not wired up (docs/framepick-prd-20261102.md section 10).
const SOURCES = {
  douyin: { label: '抖音', hosts: ['www.douyin.com', 'douyin.com', 'v.douyin.com', 'www.iesdouyin.com'] },
  xiaohongshu: { label: '小红书', hosts: ['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com'] },
  bilibili: { label: '哔哩哔哩', hosts: ['www.bilibili.com', 'bilibili.com', 'b23.tv'] },
};
const ACCESS = new Set(['free', 'paid']);
const CATEGORIES = new Set(['film', 'series', 'short', 'ad', 'music', 'experimental']);
// 连载状态；留空表示尚未核实。
const COMPLETIONS = ['standalone', 'ongoing', 'completed'];
const RUNTIME = /^(?:\d+:)?\d{1,2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RELEASE_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

const errors = [];
const warnings = [];
const fail = (film, message) => errors.push(`[${film}] ${message}`);
const warn = (film, message) => warnings.push(`[${film}] ${message}`);

function beijingToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : null;
}

function textOf(card, className) {
  const match = card.match(new RegExp(`<[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<`));
  return match ? match[1].replace(/<[^>]*>/g, '').trim() : '';
}

if (!fs.existsSync(indexPath)) {
  console.error(`找不到片库页面：${indexPath}`);
  process.exit(2);
}

const source = fs.readFileSync(indexPath, 'utf8');
const cards = [...source.matchAll(/<article\b[^>]*\bdata-film="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)];
const films = [];

if (!cards.length) fail('片库', '没有解析到任何作品卡片，检查 data-film 是否还写在 article 上');

for (const [card, id, body] of cards.map((m) => [m[0], m[1], m[2]])) {
  if (films.includes(id)) fail(id, '作品 ID 重复，稳定标识必须唯一');
  films.push(id);

  for (const required of ['data-category', 'data-genres', 'data-source', 'data-access', 'data-date', 'data-published']) {
    if (attr(card, required) === null) fail(id, `缺少 ${required}`);
  }

  const category = attr(card, 'data-category');
  const access = attr(card, 'data-access');
  const source_ = attr(card, 'data-source');
  const date = attr(card, 'data-date');
  const published = attr(card, 'data-published');
  const score = attr(card, 'data-score');

  // 原片发布日期必须记录；收录日期只用于今日更新榜的分组。
  if (published !== null && !published) fail(id, '缺少原片发布日期（data-published），作品上架前必须记录');
  else if (published && !RELEASE_DATE.test(published)) fail(id, `data-published="${published}" 必须是 YYYY、YYYY-MM 或 YYYY-MM-DD`);
  else if (published && published.length === 10 && published > beijingToday()) fail(id, `data-published="${published}" 是未来日期`);

  if (category && !CATEGORIES.has(category)) fail(id, `data-category="${category}" 不在允许值内：${[...CATEGORIES].join(' / ')}`);
  if (access && !ACCESS.has(access)) fail(id, `data-access="${access}" 只能是 free 或 paid`);
  if (!attr(card, 'data-genres')) fail(id, 'data-genres 不能为空');

  if (source_ && !SOURCES[source_]) {
    fail(id, `data-source="${source_}" 不是首批已接通来源（${Object.keys(SOURCES).join(' / ')}）`);
  }

  if (date && !DATE.test(date)) fail(id, `data-date="${date}" 必须是 YYYY-MM-DD`);
  else if (date && date > beijingToday()) fail(id, `data-date="${date}" 是未来日期，收录时间不能超前`);

  if (score !== null && score !== '') {
    const value = Number(score);
    if (!Number.isFinite(value) || value < 0 || value > 10) fail(id, `data-score="${score}" 超出 0–10 分范围`);
  } else if (!textOf(body, 'score').includes('待评')) {
    fail(id, '没有编辑评分时，页面上必须显示「待评」，不能按 0 分展示');
  }

  // LIB-04 / LIB-08: a serialised episode is not a feature film and must not be sold as one.
  if (category === 'series' && !textOf(body, 'episode')) {
    warn(id, '标记为系列单集但缺少集号说明，连载的一集不得被描述成完整电影');
  }
  // 连载状态：值必须合法；系列片没标状态只提醒，不拦发布（很多片状态要核实）。
  const completion = attr(card, 'data-completion');
  if (completion && !COMPLETIONS.includes(completion)) {
    fail(id, `data-completion="${completion}" 只能是 ${COMPLETIONS.join(' / ')} 或留空`);
  }
  if (category === 'series' && !completion) {
    warn(id, '系列短剧还没标注连载状态（单部／连载中／已完结），详情里会显示「状态待核实」');
  }
  if (access === 'paid' && category !== 'film') {
    fail(id, '只有完整电影（data-category="film"）可以标为付费，单集不得作为付费正片');
  }
  if (access === 'paid') {
    warn(id, '付费作品需先在运营处留存授权范围、期限与价格记录，页面校验无法替代授权审核');
  }

  const watch = body.match(/<a\b[^>]*class="[^"]*\bwatch\b[^"]*"[^>]*>/);
  const href = watch ? attr(watch[0], 'href') : null;
  if (!href) {
    fail(id, '缺少原作观看链接');
  } else {
    let host;
    try {
      host = new URL(href).host;
    } catch (_) {
      fail(id, `原作链接不是合法 URL：${href}`);
    }
    if (host) {
      if (new URL(href).protocol !== 'https:') fail(id, `原作链接必须使用 HTTPS：${href}`);
      const allowed = SOURCES[source_]?.hosts || [];
      if (allowed.length && !allowed.includes(host)) {
        fail(id, `原作链接域名 ${host} 与 data-source="${source_}"（${SOURCES[source_].label}）不一致`);
      }
    }
  }

  const runtime = textOf(body, 'card-runtime');
  if (!runtime) warn(id, '卡片没有显示时长');
  else if (!RUNTIME.test(runtime)) fail(id, `时长格式应为 mm:ss 或 h:mm:ss，当前为「${runtime}」`);

  const cover = body.match(/<img\b[^>]*src="([^"]+)"/);
  if (!cover) fail(id, '缺少封面图');
  else if (!/^(?:https?:)?\/\//.test(cover[1]) && !fs.existsSync(path.join(siteDir, cover[1]))) {
    fail(id, `封面文件不存在：${cover[1]}`);
  }

  if (!textOf(body, 'desc')) fail(id, '缺少简介');
  if (!textOf(body, 'author-name')) fail(id, '缺少作者');
  const title = body.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/);
  if (!title || !title[1].trim()) fail(id, '缺少片名');
}

// Outbound counters and reviews resolve film ids from the same markup.
for (const id of films) {
  for (const hook of ['data-open-film', 'data-outbound-film', 'data-save-film']) {
    if (!source.includes(`${hook}="${id}"`)) warn(id, `卡片上找不到 ${hook}，该作品可能无法打开详情／统计跳转／收藏`);
  }
}

const report = { siteDir, films: films.length, errors, warnings };
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`帧选片库校验：${siteDir} · ${films.length} 部作品 · ${errors.length} 个错误 · ${warnings.length} 个提醒`);
  for (const message of warnings) console.log(`  提醒 ${message}`);
  for (const message of errors) console.log(`  错误 ${message}`);
}
process.exit(errors.length ? 1 : 0);

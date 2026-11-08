// Framepick catalogue admin CLI. Operations run against the store outside the
// repository; nothing here writes private material into the site.
//
//   node scripts/framepick-library-cli.mjs list [--status published]
//   node scripts/framepick-library-cli.mjs seed                 import current cards
//   node scripts/framepick-library-cli.mjs add --file film.json
//   node scripts/framepick-library-cli.mjs status xianggu published --note "审片通过"
//   node scripts/framepick-library-cli.mjs candidate add --json '{...}'
//   node scripts/framepick-library-cli.mjs candidate convert cand-1 --file film.json
//   node scripts/framepick-library-cli.mjs candidate reindex [--dry-run]
//   node scripts/framepick-library-cli.mjs log -n 20
//   node scripts/framepick-library-cli.mjs build               regenerate the page
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLibraryStore, LibraryError, FILM_STATUSES, CANDIDATE_STATUSES } = require('../server/framepick-library.cjs');

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i < 0 ? undefined : rest[i + 1];
};
const has = (name) => rest.includes(`--${name}`);
const positional = rest.filter((value, index) => !value.startsWith('--') && (index === 0 || !rest[index - 1].startsWith('--')));

const store = createLibraryStore({ dataDir: process.env.FRAMEPICK_LIBRARY_DATA_DIR });

function readPayload() {
  const file = flag('file');
  if (file) return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const inline = flag('json');
  if (inline) return JSON.parse(inline);
  throw new Error('需要 --file <路径> 或 --json <JSON>');
}

function print(value) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

// One-shot import of the hand-written cards that shipped before this store existed.
// 首页只铺九部之后，卡片数已经不等于片库总数（55），所以优先读生成器写出的
// films-data.js（全量），没有它才退回解析 index.html 的卡片。
function seedFromData(siteDir) {
  const file = path.join(siteDir, 'films-data.js');
  if (!fs.existsSync(file)) return null;
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('[');
  const end = source.lastIndexOf(']');
  if (start < 0 || end < start) return null;
  const films = JSON.parse(source.slice(start, end + 1));
  const created = [];
  const skipped = [];
  for (const film of films) {
    if (!film.id) continue;
    if (store.listFilms().some((existing) => existing.id === film.id)) { skipped.push(film.id); continue; }
    store.addFilm({
      id: film.id, title: film.title, author: film.author, source: film.source,
      sourceUrl: film.sourceUrl, category: film.category, genres: film.genres,
      kind: film.kind, access: film.access, runtime: film.runtime, cover: film.cover,
      coverAlt: film.coverAlt, coverWidth: film.coverWidth, coverHeight: film.coverHeight,
      coverNote: film.coverNote, originalReleaseDate: film.published || '',
      description: film.description, recommendation: film.recommendation || '',
      episode: film.episode || '', completion: film.completion || '',
      volume: film.volume || '', relation: film.relation || '',
      editorScore: film.score === null || film.score === undefined ? '' : film.score,
      intakeDate: film.intakeDate,
    }, { actor: 'seed' });
    for (const status of ['reviewing', 'approved', 'scheduled', 'published']) store.setStatus(film.id, status, { actor: 'seed' });
    created.push(film.id);
  }
  return { created, skipped, total: store.listFilms().length };
}

function seed() {
  const siteDir = path.resolve(flag('site') || '.');
  const fromData = seedFromData(siteDir);
  if (fromData) { print(fromData); return; }
  const source = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8');
  const cards = [...source.matchAll(/<article\b[^>]*\bdata-film="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)];
  const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';
  const textOf = (body, className) => body.match(new RegExp(`<[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<`))?.[1].replace(/<[^>]*>/g, '').trim() || '';
  const created = [];
  const skipped = [];
  cards.forEach(([, id, body], index) => {
    if (store.listFilms().some((film) => film.id === id)) { skipped.push(id); return; }
    const image = body.match(/<img\b[^>]*src="([^"]+)"[^>]*>/) || [];
    const film = store.addFilm({
      id,
      title: body.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/)?.[1].trim(),
      author: textOf(body, 'author-name'),
      source: attr(cards[index][0], 'data-source'),
      sourceUrl: body.match(/<a\b[^>]*class="[^"]*\bwatch\b[^"]*"[^>]*href="([^"]+)"/)?.[1],
      category: attr(cards[index][0], 'data-category'),
      genres: attr(cards[index][0], 'data-genres').split(' ').filter(Boolean),
      kind: textOf(body, 'kind'),
      access: attr(cards[index][0], 'data-access'),
      runtime: textOf(body, 'card-runtime'),
      cover: image[1],
      coverAlt: body.match(/<img\b[^>]*alt="([^"]*)"/)?.[1] || '',
      coverWidth: Number(body.match(/<img\b[^>]*width="(\d+)"/)?.[1]) || 640,
      coverHeight: Number(body.match(/<img\b[^>]*height="(\d+)"/)?.[1]) || 397,
      coverNote: textOf(body, 'image-note'),
      // 原片发布日期写在卡片的 data-published 上，seed 必须回填，否则重建页面会丢。
      originalReleaseDate: attr(cards[index][0], 'data-published'),
      description: textOf(body, 'desc'),
      recommendation: textOf(body, 'recommendation'),
      episode: textOf(body, 'episode'),
      // 连载状态同样长在卡片上（data-completion 与隐藏的 .volume/.relation），
      // seed 不回填就会在重建页面时整片丢失，页面也就无法从种子复现。
      completion: attr(cards[index][0], 'data-completion'),
      volume: textOf(body, 'volume'),
      relation: textOf(body, 'relation'),
      editorScore: attr(cards[index][0], 'data-score'),
      intakeDate: attr(cards[index][0], 'data-date'),
    }, { actor: 'seed' });
    for (const status of ['reviewing', 'approved', 'scheduled', 'published']) store.setStatus(id, status, { actor: 'seed' });
    created.push(film.id);
  });
  print({ created, skipped, total: store.listFilms().length });
}

try {
  switch (command) {
    case 'list': print(store.listFilms(flag('status')).map((film) => ({
      id: film.id, title: film.title, status: film.status, category: film.category,
      access: film.access, source: film.source, intakeDate: film.intakeDate, score: film.editorScore,
    }))); break;
    case 'show': print(store.getFilm(positional[0])); break;
    case 'add': print(store.addFilm(readPayload())); break;
    case 'update': print(store.updateFilm(positional[0], readPayload())); break;
    case 'status': print(store.setStatus(positional[0], positional[1], { note: flag('note') })); break;
    case 'note': print(store.addNote(positional[0], positional.slice(1).join(' '))); break;
    case 'seed': seed(); break;
    case 'log': print(store.log(Number(flag('n')) || 30)); break;
    case 'candidate': {
      const action = positional[0];
      if (action === 'list') print(store.listCandidates(flag('status')));
      else if (action === 'add') print(store.addCandidate(readPayload()));
      else if (action === 'status') print(store.setCandidateStatus(positional[1], positional[2], { note: flag('note') }));
      else if (action === 'convert') print(store.convertCandidate(positional[1], readPayload()));
      else if (action === 'reindex') print(store.reindexCandidates({ dryRun: has('dry-run'), actor: 'reindex' }));
      else throw new Error(`未知候选操作 ${action}，可用：list / add / status / convert / reindex`);
      break;
    }
    case 'build': {
      const result = spawnSync(process.execPath, ['scripts/build-framepick-library.mjs', ...(flag('site') ? ['--site', flag('site')] : [])], { stdio: 'inherit' });
      process.exit(result.status ?? 1);
    }
    default:
      console.log(`用法：
  list [--status <状态>]            列出作品，状态：${FILM_STATUSES.join(' / ')}
  show <id>                         查看完整作品记录
  add --file <json>|--json <json>   新增作品（草稿）
  update <id> --file <json>         修改作品字段
  status <id> <状态> [--note 说明]   推进审核／排期／上下架
  note <id> <审核意见>               记录审核意见
  candidate list|add|status|convert 候选池操作
  candidate reindex [--dry-run]       用平台编号重算候选 ID（幂等，修重号）
  seed                              从现有 reel/index.html 导入作品
  log [-n 条数]                      查看变更记录
  build [--site <目录>]              重新生成静态片库页面`);
      process.exit(command ? 1 : 0);
  }
} catch (error) {
  if (error instanceof LibraryError) {
    console.error(`[${error.code}] ${error.message}`);
    process.exit(1);
  }
  console.error(error.message);
  process.exit(1);
}

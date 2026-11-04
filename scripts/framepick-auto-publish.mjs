// 机器自己判「这条候选能不能上架」，够格就转成作品并直接上架，不再逐条人工看片。
//
//   node scripts/framepick-auto-publish.mjs                   只看：列出够格的候选与剔除原因
//   node scripts/framepick-auto-publish.mjs --ids dy-xxx,dy-yy  只看指定几条
//   node scripts/framepick-auto-publish.mjs --apply           按 films.json 转换并入册上架
//
// 判定规则在 scripts/framepick-publish-rules.mjs（纯函数，带测试）。机器推断不了的东西
// ——片名、类型、题材、简介、原片发布日期、封面——写在
// docs/framepick-publish-20261103/films.json 里，脚本只负责校验与落库。
//
// 上架链路仍然走状态机（draft → reviewing → approved → scheduled → published），
// actor 记为 auto-publish，所以事后能一眼看出哪些是机器放的。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { filmTitle, publishability } from './framepick-publish-rules.mjs';

const require = createRequire(import.meta.url);
const { createLibraryStore } = require('../server/framepick-library.cjs');

const root = fileURLToPath(new URL('..', import.meta.url));
const batchFile = path.join(root, 'docs', 'framepick-publish-20261103', 'films.json');
const ACTOR = 'auto-publish';

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i < 0 ? undefined : rest[i + 1];
};
const apply = process.argv.slice(2).includes('--apply');
const only = (flag('ids') || '').split(',').map((id) => id.trim()).filter(Boolean);

const store = createLibraryStore({ dataDir: process.env.FRAMEPICK_LIBRARY_DATA_DIR });
const films = store.listFilms();
const pool = store.listCandidates().filter((item) => ['new', 'verifying'].includes(item.status));
const siblingTitles = pool.map((item) => item.title);

function evaluate(item, others = pool) {
  return publishability(item, { films, siblings: others.filter((other) => other.id !== item.id).map((other) => other.title) });
}

function survey() {
  const targets = only.length ? pool.filter((item) => only.includes(item.id)) : pool;
  const rows = targets.map((item) => ({ item, verdict: evaluate(item, targets) }));
  if (only.length) {
    // 只点了这几条时，它们之间不该互相判重，但仍要和片库、和池子里其余候选比。
    rows.forEach((row) => { row.verdict = evaluate(row.item, pool); });
  }
  const keep = rows.filter((row) => row.verdict.eligible);
  const drop = rows.filter((row) => !row.verdict.eligible);
  return { keep, drop, total: targets.length };
}

function printSurvey({ keep, drop, total }) {
  console.log(`候选 ${total} 条 · 够格上架 ${keep.length} 条 · 剔除 ${drop.length} 条`);
  if (keep.length) {
    console.log('\n够格：');
    for (const { item, verdict } of keep) {
      const minutes = Math.floor(verdict.runtimeSeconds / 60);
      console.log(`  ✓ ${item.id} · ${minutes} 分 · ${verdict.filmTitle} （${item.author}）`);
    }
  }
  if (drop.length) {
    console.log('\n剔除原因（前 20 条）：');
    for (const { item, verdict } of drop.slice(0, 20)) console.log(`  ✗ ${item.title.slice(0, 40)} — ${verdict.reasons.join('；')}`);
    if (drop.length > 20) console.log(`  …另有 ${drop.length - 20} 条`);
  }
}

function loadBatch() {
  if (!fs.existsSync(batchFile)) throw new Error(`缺少上架清单 ${path.relative(root, batchFile)}`);
  const parsed = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
  if (!Array.isArray(parsed.films) || !parsed.films.length) throw new Error('上架清单里没有 films 数组');
  return parsed;
}

function publish() {
  const batch = loadBatch();
  const { keep } = survey();
  const eligibleIds = new Set(keep.map((row) => row.item.id));
  const done = [];
  const skipped = [];
  const already = [];
  const everyone = store.listCandidates();

  for (const entry of batch.films) {
    const known = everyone.find((item) => item.id === entry.candidate);
    // 上一批已经转成作品的条目不该每轮都报一遍"找不到"。
    if (known && known.status === 'converted') { already.push(known.id); continue; }
    const candidate = pool.find((item) => item.id === entry.candidate);
    if (!candidate) { skipped.push({ id: entry.candidate, reason: '候选池里没有这条（已转换或已剔除？）' }); continue; }
    if (only.length && !only.includes(candidate.id)) continue;
    if (!eligibleIds.has(candidate.id)) {
      const verdict = evaluate(candidate);
      skipped.push({ id: candidate.id, reason: verdict.reasons.join('；') });
      continue;
    }
    // 封面必须在盘上：卡片会直接引用它，缺图就是公开页面上的破图。
    // 2026-11 起不再自造封面：封面统一取平台原封面（scripts/framepick-cover-build.mjs
    // 负责下载转换），这里只要求 640w 一档在盘上。
    const cover = `img/${entry.id}-640w.webp`;
    if (!fs.existsSync(path.join(root, cover))) {
      skipped.push({ id: candidate.id, reason: `缺封面 ${cover}（先跑 scripts/framepick-cover-build.mjs）` });
      continue;
    }

    const film = store.convertCandidate(candidate.id, {
      id: entry.id,
      title: entry.title,
      author: candidate.author,
      source: candidate.source,
      sourceUrl: candidate.url,
      category: entry.category,
      genres: entry.genres,
      access: 'free',
      runtime: entry.runtime || candidate.note.match(/时长\s*(\d{1,2}:\d{2})/)?.[1],
      cover,
      coverAlt: entry.coverAlt || `《${entry.title}》原片封面`,
      coverNote: entry.coverNote || '原片封面',
      coverWidth: 640,
      coverHeight: 480,
      description: entry.description,
      recommendation: entry.recommendation,
      episode: entry.episode,
      intakeDate: batch.intakeDate,
      originalReleaseDate: entry.originalReleaseDate,
    }, { actor: ACTOR });

    for (const status of ['reviewing', 'approved', 'scheduled', 'published']) {
      store.setStatus(film.id, status, { actor: ACTOR, note: status === 'published' ? '按放行规则自动上架' : '' });
    }
    done.push({ id: film.id, candidate: candidate.id, title: film.title });
  }

  console.log(`已上架 ${done.length} 部，跳过 ${skipped.length} 条${already.length ? `（另有 ${already.length} 条此前已上架）` : ''}`);
  for (const row of done) console.log(`  ✓ ${row.id} · ${row.title}（候选 ${row.candidate}）`);
  for (const row of skipped) console.log(`  - 跳过 ${row.id}：${row.reason}`);
  if (done.length) console.log('\n下一步：node scripts/framepick-library-cli.mjs build 重新生成页面');
  return { done, skipped };
}

try {
  if (apply) publish();
  else printSurvey(survey());
} catch (error) {
  console.error(`[auto-publish] ${error.message}`);
  process.exit(1);
}

// 批量标注连载状态、体量、续集关系。
//
//   node scripts/framepick-completion.mjs --dry-run
//   node scripts/framepick-completion.mjs --file docs/framepick-series-20261103/status.json
//
// 状态是编辑判断，不是抓出来的。这个脚本只负责把判定结果稳定写进作品表：
//   standalone 单部完整 / ongoing 连载中 / completed 多集已完结 / '' 未核实
// 数据文件里的 basis 只作追溯记录，不写库。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLibraryStore, COMPLETIONS } = require('../server/framepick-library.cjs');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const dryRun = process.argv.includes('--dry-run');
const file = path.resolve(arg('--file') || 'docs/framepick-series-20261103/status.json');

const source = JSON.parse(fs.readFileSync(file, 'utf8'));
const store = createLibraryStore({});
const films = store.listFilms('published');
const byId = new Map(films.map((film) => [film.id, film]));

const done = [];
const skipped = [];
const unknown = [];
for (const [id, entry] of Object.entries(source.films || {})) {
  const film = byId.get(id);
  if (!film) { skipped.push({ id, reason: '作品表里没有这部（或还没上架）' }); continue; }
  const patch = {};
  if (entry.completion !== undefined) {
    if (entry.completion && !COMPLETIONS.includes(entry.completion)) {
      skipped.push({ id, reason: `completion=${entry.completion} 不合法` });
      continue;
    }
    patch.completion = entry.completion;
  }
  if (entry.volume !== undefined) patch.volume = String(entry.volume || '');
  if (entry.relation !== undefined) patch.relation = String(entry.relation || '');

  const changed = Object.entries(patch).filter(([key, value]) => (film[key] || '') !== value);
  if (!changed.length) { skipped.push({ id, reason: '已是这个状态' }); continue; }
  if (!dryRun) store.updateFilm(id, patch, { actor: 'editorial' });
  done.push({ id, title: film.title, patch, basis: entry.basis || '' });
}

// 系列片如果还没标状态，提醒一下——不拦发布，只是页面会显示「状态待核实」。
for (const film of films) {
  if (film.category === 'series' && !film.completion) unknown.push({ id: film.id, title: film.title });
}

console.log(`连载状态${dryRun ? '（dry-run）' : ''}：更新 ${done.length} · 跳过 ${skipped.length}`);
for (const row of done) console.log(`  ✓ ${row.id} · ${row.title} → ${row.patch.completion || '(清空)'}${row.basis ? `（${row.basis}）` : ''}`);
for (const row of skipped) console.log(`  - 跳过 ${row.id}：${row.reason}`);
if (unknown.length) {
  console.log(`\n系列片里还没标状态的 ${unknown.length} 部：`);
  for (const row of unknown) console.log(`  ? ${row.id} · ${row.title}`);
}

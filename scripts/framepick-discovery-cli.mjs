// Framepick discovery pipeline: turn an agent's raw search output into screened
// candidates, verify their links and write a run report.
//
//   node scripts/framepick-discovery-cli.mjs plan [--json]
//   node scripts/framepick-discovery-cli.mjs screen --file candidates.json [--json]
//   node scripts/framepick-discovery-cli.mjs add --file candidates.json [--json]
//   node scripts/framepick-discovery-cli.mjs verify [--file candidates.json] [--id cand-x] [--json]
//   node scripts/framepick-discovery-cli.mjs rescreen [--apply] [--json]
//   node scripts/framepick-discovery-cli.mjs report [--json]
//
// The pipeline never publishes anything: candidates stop at the candidate pool and
// a human promotes them with framepick-library-cli.mjs (draft → … → published).
// Data lives outside the repository, same as the library store.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { normalizeUrl, oneLine, screenCandidate } from './framepick-discovery-rules.mjs';

const require = createRequire(import.meta.url);
const { createLibraryStore, SOURCES } = require('../server/framepick-library.cjs');

const root = fileURLToPath(new URL('..', import.meta.url));
const configDir = path.join(root, 'docs', 'framepick-discovery-20261103');
const configPath = path.join(configDir, 'sources.json');
const runsDir = path.join(configDir, 'runs');

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i < 0 ? undefined : rest[i + 1];
};
const asJson = rest.includes('--json');
const chinaNow = () => new Date(Date.now() + 8 * 3600 * 1000);
const stamp = () => chinaNow().toISOString().slice(0, 16).replace('T', '-').replace(':', '');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`读不到搜索源配置 ${configPath}：${error.message}`);
  }
}

function readInput() {
  const file = flag('file');
  if (!file) throw new Error('需要 --file <发现结果.json>');
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const candidates = Array.isArray(parsed) ? parsed : parsed.candidates;
  if (!Array.isArray(candidates)) throw new Error('输入里找不到 candidates 数组');
  return { runAt: parsed.runAt || chinaNow().toISOString(), runBy: parsed.runBy || 'ai', candidates };
}

function store() {
  return createLibraryStore({ dataDir: process.env.FRAMEPICK_LIBRARY_DATA_DIR });
}

function plan() {
  const config = loadConfig();
  const s = store();
  const films = s.listFilms();
  const candidates = s.listCandidates();
  const authors = [...new Set(films.map((film) => film.author))];
  const runs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((name) => name.endsWith('.md')).sort() : [];
  const plan = {
    generatedAt: chinaNow().toISOString(),
    platforms: Object.entries(config.platforms).map(([key, value]) => ({ key, label: value.label, state: value.state, how: value.how })),
    queries: config.queries,
    searchUrls: config.queries.map((query) => String(config.platforms.bilibili.entry || '').replace('{query}', encodeURIComponent(query))),
    excludeKeywords: config.excludeKeywords,
    runtimeRangeSeconds: config.runtimeRangeSeconds,
    watchAuthors: [...(config.watchAuthors || []), ...authors.map((name) => ({ name, from: '已收录作品的作者' }))],
    pool: { films: films.length, published: films.filter((film) => film.status === 'published').length, candidates: candidates.length, candidatesNew: candidates.filter((item) => item.status === 'new').length },
    lastRun: runs.length ? path.join('docs/framepick-discovery-20261103/runs', runs[runs.length - 1]) : null,
  };
  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }
  console.log('帧选搜片清单 · ' + plan.generatedAt);
  console.log('\n平台：');
  for (const item of plan.platforms) console.log(`  - ${item.label}：${item.state}\n    ${item.how}`);
  console.log('\n关键词（B 站搜索，按最新发布排序）：');
  for (const url of plan.searchUrls) console.log('  - ' + url);
  console.log('\n关注作者（看是否有新稿）：');
  for (const item of plan.watchAuthors) console.log('  - ' + item.name + (item.from ? `（${item.from}）` : ''));
  console.log(`\n硬门槛：时长 ${plan.runtimeRangeSeconds[0] / 60}–${plan.runtimeRangeSeconds[1] / 60} 分钟；需 AI 制作属性证据；排除 ${plan.excludeKeywords.length} 类词（教程／解说／合集／预告等）。`);
  console.log(`\n池内现状：作品 ${plan.pool.films} 部（已上架 ${plan.pool.published}）· 候选 ${plan.pool.candidates} 条（待核实 ${plan.pool.candidatesNew}）`);
  console.log(plan.lastRun ? `上次运行报告：${plan.lastRun}` : '尚无历史运行报告。');
  return plan;
}

function screen(commandName) {
  const config = loadConfig();
  const { runAt, runBy, candidates } = readInput();
  const s = store();
  const films = s.listFilms();
  const existing = s.listCandidates();
  const accepted = [];
  const rejected = [];
  const duplicates = [];
  const added = [];
  const failed = [];
  for (const item of candidates) {
    const result = screenCandidate(item, { config, films, candidates: existing });
    const row = { title: oneLine(item?.title), author: oneLine(item?.author), source: oneLine(item?.source), url: oneLine(item?.url), reasons: result.reasons };
    if (result.status === 'accepted') {
      accepted.push(row);
      if (commandName === 'add') {
        try {
          const record = s.addCandidate({
            title: row.title,
            author: row.author,
            source: row.source,
            url: row.url,
            discoveredBy: ['ai', 'manual', 'creator'].includes(runBy) ? runBy : 'ai',
            discoveredAt: runAt,
            evidence: Array.isArray(item.evidence) ? item.evidence : [],
            popularity: item.popularity || null,
            // 原片发布日期要记进候选备注；收录日期交给入库时取当天，不在这里写。
            note: [oneLine(item.note), oneLine(item.aiEvidenceNote), item.runtime ? `时长 ${oneLine(item.runtime)}` : '', item.publishedAt ? `原片发布 ${oneLine(item.publishedAt)}` : ''].filter(Boolean).join(' · ').slice(0, 600),
          }, { actor: `discovery:${runBy}` });
          added.push({ id: record.id, title: record.title, url: record.url });
          existing.push(record);
        } catch (error) {
          failed.push({ ...row, reason: error.message });
        }
      }
    } else if (result.status === 'duplicate') duplicates.push(row);
    else rejected.push(row);
  }
  const summary = { runAt, runBy, accepted: accepted.length, added: added.length, rejected: rejected.length, duplicates: duplicates.length, failed: failed.length, addedList: added, rejectedDetail: rejected, duplicateDetail: duplicates, failedDetail: failed };
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`初筛：通过 ${accepted.length} · 被拒 ${rejected.length} · 重复 ${duplicates.length}` + (commandName === 'add' ? ` · 已入池 ${added.length}` + (failed.length ? ` · 入池失败 ${failed.length}` : '') : ''));
    for (const row of rejected) console.log(`  ✗ ${row.title || '（无片名）'} — ${row.reasons.join('；')}`);
    for (const row of duplicates) console.log(`  = ${row.title || '（无片名）'} — ${row.reasons.join('；')}`);
    for (const row of added) console.log(`  ✓ 入池 ${row.id} · ${row.title}`);
    for (const row of failed) console.log(`  ! 入池失败 ${row.title} — ${row.reason}`);
  }
  return summary;
}

async function verifyOne(candidate) {
  const url = candidate.url;
  const base = { id: candidate.id, title: candidate.title, url, source: candidate.source };
  if (candidate.source !== 'bilibili') {
    return { ...base, verifiable: false, reason: `${SOURCES[candidate.source]?.label || candidate.source} 需登录才能复核，本轮只登记待核` };
  }
  let html = '';
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', accept: 'text/html' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    if (!response.ok) return { ...base, verifiable: true, reachable: false, reason: `原页返回 ${response.status}` };
    html = await response.text();
  } catch (error) {
    return { ...base, verifiable: true, reachable: false, reason: `无法访问原页：${error.message}` };
  }
  const missing = /视频去哪了呢|页面不存在|出错了|当前视频不可用/.test(html);
  if (missing) return { ...base, verifiable: true, reachable: true, missing: true, reason: '原页显示视频不存在或已失效' };
  const pageTitle = (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/) || html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  const decoded = pageTitle.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/_哔哩哔哩.*$/, '').trim();
  const titleMatched = Boolean(decoded) && decoded.includes(candidate.title.slice(0, 4));
  const authorMatched = Boolean(candidate.author) && html.includes(candidate.author);
  return { ...base, verifiable: true, reachable: true, pageTitle: decoded, titleMatched, authorMatched, reason: titleMatched && authorMatched ? '原页标题与作者均一致' : '原页标题或作者与候选记录不一致，需人工确认' };
}

async function verify() {
  const s = store();
  const id = flag('id');
  const file = flag('file');
  let targets;
  if (id) {
    const found = s.listCandidates().find((item) => item.id === id);
    if (!found) throw new Error(`候选池里没有 ${id}`);
    targets = [found];
  } else if (file) {
    const input = readInput();
    const pool = s.listCandidates();
    targets = input.candidates.map((item) => pool.find((entry) => normalizeUrl(entry.url) === normalizeUrl(item.url))).filter(Boolean);
  } else {
    targets = s.listCandidates().filter((item) => ['new', 'verifying'].includes(item.status));
  }
  const results = [];
  for (const candidate of targets) {
    const result = await verifyOne(candidate);
    results.push(result);
    const ok = result.verifiable && result.reachable && !result.missing && result.titleMatched && result.authorMatched;
    const actor = 'discovery:verify';
    if (ok && candidate.status === 'new') {
      s.setCandidateStatus(candidate.id, 'verifying', { actor, note: '链接可达，原页标题与作者一致' });
    } else if (result.reachable && !result.missing && result.verifiable && !ok) {
      s.setCandidateStatus(candidate.id, candidate.status === 'new' ? 'verifying' : candidate.status, { actor, note: result.reason });
    } else {
      s.setCandidateStatus(candidate.id, candidate.status, { actor, note: result.reason });
    }
  }
  if (asJson) console.log(JSON.stringify({ verified: results.length, results }, null, 2));
  else {
    console.log(`复核 ${results.length} 条候选：`);
    for (const result of results) console.log(`  - ${result.title}：${result.reason}${result.pageTitle ? `（原页：${result.pageTitle}）` : ''}`);
  }
  return results;
}

function report() {
  const s = store();
  const config = loadConfig();
  const candidates = s.listCandidates();
  const films = s.listFilms();
  const log = s.log(20).filter((entry) => entry.action.startsWith('candidate.'));
  const fresh = candidates.filter((item) => ['new', 'verifying'].includes(item.status));
  const now = chinaNow();
  const lines = [];
  lines.push('# 帧选搜片运行报告 · ' + now.toISOString().slice(0, 16).replace('T', ' ') + '（北京时间）');
  lines.push('');
  lines.push(`- 池内：作品 ${films.length} 部（已上架 ${films.filter((film) => film.status === 'published').length}）· 候选 ${candidates.length} 条（待处理 ${fresh.length}）`);
  lines.push('- 本次未自动上架任何作品：候选停在候选池，人工确认后才进入审片流程。');
  lines.push('');
  lines.push('## 待处理候选');
  lines.push('');
  if (!fresh.length) lines.push('（无）');
  else {
    lines.push('| 候选 | 作者 | 来源 | 状态 | 备注 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of fresh) lines.push(`| ${item.title} | ${item.author} | ${SOURCES[item.source]?.label || item.source} | ${item.status} | ${oneLine(item.note).replace(/\|/g, '\\|') || '—'} |`);
  }
  lines.push('');
  lines.push('## 最近候选变更');
  lines.push('');
  if (!log.length) lines.push('（无）');
  else for (const entry of log.slice(-10)) lines.push(`- ${entry.at} · ${entry.actor} · ${entry.action} ${entry.target} · ${entry.detail}`);
  lines.push('');
  lines.push('## 下一步（人工）');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/framepick-discovery-cli.mjs plan                # 本轮搜什么');
  lines.push('node scripts/framepick-discovery-cli.mjs add --file 发现.json  # 初筛并入池');
  lines.push('node scripts/framepick-library-cli.mjs candidate list          # 看候选池');
  lines.push('node scripts/framepick-library-cli.mjs candidate convert <id> --file 作品.json');
  lines.push('node scripts/framepick-library-cli.mjs status <作品id> reviewing --note "人工审片"');
  lines.push('```');
  lines.push('');
  lines.push(`硬门槛：时长 ${config.runtimeRangeSeconds[0] / 60}–${config.runtimeRangeSeconds[1] / 60} 分钟 · 需 AI 制作属性证据 · 排除 ${config.excludeKeywords.length} 类词。`);
  const markdown = lines.join('\n') + '\n';
  fs.mkdirSync(runsDir, { recursive: true });
  const target = path.join(runsDir, `${stamp()}.md`);
  fs.writeFileSync(target, markdown, 'utf8');
  if (asJson) console.log(JSON.stringify({ report: path.relative(root, target), pending: fresh.length, candidates: candidates.length }, null, 2));
  else {
    console.log(markdown);
    console.log(`报告已写入 ${path.relative(root, target)}`);
  }
  return target;
}

// 排除词会随发现的问题变长（比如「制作分享」「全流程」这类教程腔）。这个命令拿当前
// 规则重扫一遍候选池，只判标题与备注层面的规则——候选记录里没存时长，所以时长门槛
// 不在这里复核。默认只报告，加 --apply 才把命中项标成 rejected。
function rescreen() {
  const config = loadConfig();
  const s = store();
  const apply = rest.includes('--apply');
  const films = s.listFilms();
  const pool = s.listCandidates();
  const hits = [];
  let marked = 0;
  for (const item of pool) {
    if (item.status === 'converted') continue;
    const again = screenCandidate(
      { title: item.title, author: item.author, source: item.source, url: item.url, aiEvidence: true },
      { config, films, candidates: pool.filter((other) => other.id !== item.id) },
    );
    const keyword = again.reasons.find((reason) => reason.startsWith('命中排除词'));
    if (!keyword) continue;
    hits.push({ id: item.id, title: item.title, status: item.status, reason: keyword });
    if (apply && ['new', 'verifying'].includes(item.status)) {
      s.setCandidateStatus(item.id, 'rejected', { actor: 'discovery:rescreen', note: keyword });
      marked += 1;
    }
  }
  if (asJson) console.log(JSON.stringify({ scanned: pool.length, hits: hits.length, applied: marked, hitsList: hits }, null, 2));
  else {
    console.log(`重扫候选池 ${pool.length} 条：命中当前排除词 ${hits.length} 条${apply ? `，本次新标 rejected ${marked} 条（其余早已标注）` : '（未改动，加 --apply 才落状态）'}`);
    for (const hit of hits) console.log(`  - ${hit.id} · ${hit.title} — ${hit.reason}`);
  }
  return { hits, marked };
}

const commands = { plan, screen, add: () => screen('add'), verify, report, rescreen };
const run = commands[command];
if (!run) {
  console.log(`用法：
  plan [--json]                                打印本轮搜索清单（平台／关键词／关注作者／硬门槛）
  screen --file <发现结果.json> [--json]        只跑初筛，不写候选池
  add --file <发现结果.json> [--json]           初筛通过后写入候选池（discoveredBy=ai）
  verify [--file <发现结果.json>] [--id <候选id>] [--json]   复核链接可达与元数据一致
  rescreen [--apply] [--json]                   用当前排除词重扫候选池，可选标记 rejected
  report [--json]                              写本轮运行报告到 docs/framepick-discovery-20261103/runs/`);
  process.exit(command ? 1 : 0);
}

Promise.resolve(run()).catch((error) => {
  console.error(`[discovery] ${error.message}`);
  process.exit(1);
});

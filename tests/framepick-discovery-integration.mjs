// Discovery pipeline tests: screening rules, intake into the candidate pool,
// link verification and the run report. Everything runs against a temp store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { screenCandidate } from '../scripts/framepick-discovery-rules.mjs';

const require = createRequire(import.meta.url);
const { createLibraryStore } = require('../server/framepick-library.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const node = process.execPath;
const config = JSON.parse(fs.readFileSync(path.join(root, 'docs/framepick-discovery-20261103/sources.json'), 'utf8'));

const candidate = (overrides = {}) => ({
  title: '测试短片', author: '测试作者', source: 'bilibili',
  url: 'https://www.bilibili.com/video/BV1xx411c7mD', runtime: '12:30',
  aiEvidence: true, aiEvidenceNote: '原页简介写明 AI 制作', ...overrides,
});

test('overseas originals pass discovery while tutorials and spoof hosts stay rejected', () => {
  for (const [source, url] of [['youtube', 'https://www.youtube.com/watch?v=V5AFQaEbHQU'], ['x', 'https://x.com/artist/status/123456789']]) {
    const result = screenCandidate(candidate({ source, url }), { config });
    assert.equal(result.status, 'accepted');
    assert.equal(screenCandidate(candidate({ source, url, title: 'AI短片教程' }), { config }).status, 'rejected');
  }
  assert.equal(screenCandidate(candidate({ source: 'youtube', url: 'https://youtube.com.evil.test/watch?v=abc' }), { config }).status, 'rejected');
});

async function dataDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'framepick-discovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function cli(dataDir, args) {
  return execFileSync(node, ['scripts/framepick-discovery-cli.mjs', ...args], {
    cwd: root, env: { ...process.env, FRAMEPICK_LIBRARY_DATA_DIR: dataDir }, encoding: 'utf8',
  });
}

test('screening keeps a complete AI short film and explains every rejection', async (t) => {
  const dir = await dataDir(t);
  const store = createLibraryStore({ dataDir: dir });
  const films = store.listFilms();
  const check = (item) => screenCandidate(item, { config, films, candidates: store.listCandidates() });

  assert.equal(check(candidate()).status, 'accepted');

  const tutorial = check(candidate({ title: 'AI 短片教程：如何做', url: 'https://www.bilibili.com/video/BV1yy222c7mD' }));
  assert.equal(tutorial.status, 'rejected');
  assert.match(tutorial.reasons.join(), /排除词/);

  const tooLong = check(candidate({ runtime: '58:00', url: 'https://www.bilibili.com/video/BV1zz333c7mD' }));
  assert.equal(tooLong.status, 'rejected');
  assert.match(tooLong.reasons.join(), /不在 3–40 分钟区间/);

  const noEvidence = check(candidate({ aiEvidence: false, aiEvidenceNote: '', url: 'https://www.bilibili.com/video/BV1aa444c7mD' }));
  assert.equal(noEvidence.status, 'rejected');
  assert.match(noEvidence.reasons.join(), /AI 制作属性证据/);

  const wrongHost = check(candidate({ source: 'douyin' }));
  assert.equal(wrongHost.status, 'rejected');
  assert.match(wrongHost.reasons.join(), /链接与来源不匹配|来源/);

  const noRuntime = check(candidate({ runtime: undefined, url: 'https://www.bilibili.com/video/BV1bb555c7mD' }));
  assert.match(noRuntime.reasons.join(), /时长/);
});

test('screening drops tutorial and workflow clips while keeping the film itself', async (t) => {
  const dir = await dataDir(t);
  const store = createLibraryStore({ dataDir: dir });
  const check = (item) => screenCandidate(item, { config, films: store.listFilms(), candidates: store.listCandidates() });

  // 抖音上一大批「制作分享／全流程／流程解析」其实是教程，不是片子。
  for (const [index, title] of [
    'AI短片《骸上城》制作分享',
    'AIGC短片流程解析EP01',
    '一条视频讲透AIGC从0到1制作全流程',
    '我的 AIGC 短片制作流程大公开',
    '第一次做AI动画就能获奖？丨AI动画创作全流程分享',
  ].entries()) {
    const result = check(candidate({ title, url: `https://www.bilibili.com/video/BV1tt${index}00000`, runtime: '08:00' }));
    assert.equal(result.status, 'rejected', `${title} 应被排除`);
    assert.match(result.reasons.join(), /排除词/);
  }

  // 片子本身带「分享」「解析」这类字眼不算教程，关键词不能收得太宽。
  const film = check(candidate({ title: 'AI短片《潮不语》 讲述妈祖的经典传奇故事', url: 'https://www.bilibili.com/video/BV1uu6666666' }));
  assert.equal(film.status, 'accepted');
});

test('rescreen re-applies todays rules to candidates that entered the pool earlier', async (t) => {
  const dir = await dataDir(t);
  const store = createLibraryStore({ dataDir: dir });
  store.addCandidate({ title: 'AI短片《骸上城》制作分享', author: '甲', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1ee5555555' });
  store.addCandidate({ title: 'AI短片《潮不语》', author: '乙', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1ff6666666' });

  const preview = JSON.parse(cli(dir, ['rescreen', '--json']));
  assert.equal(preview.scanned, 2);
  assert.equal(preview.hits, 1);
  assert.equal(store.listCandidates().find((item) => item.author === '甲').status, 'new', '默认只报告，不动状态');

  JSON.parse(cli(dir, ['rescreen', '--apply', '--json']));
  const pool = createLibraryStore({ dataDir: dir }).listCandidates();
  assert.equal(pool.find((item) => item.author === '甲').status, 'rejected');
  assert.equal(pool.find((item) => item.author === '乙').status, 'new');
});

test('intake writes screened candidates into the pool and refuses duplicates', async (t) => {
  const dir = await dataDir(t);
  const file = path.join(dir, 'found.json');
  fs.writeFileSync(file, JSON.stringify({
    runAt: '2026-11-03T09:00:00+08:00', runBy: 'ai',
    candidates: [
      candidate({ title: '甲', url: 'https://www.bilibili.com/video/BV1aa1111111' }),
      candidate({ title: '乙', url: 'https://www.bilibili.com/video/BV1bb2222222', runtime: '01:20' }),
      candidate({ title: '甲', url: 'https://www.bilibili.com/video/BV1aa1111111' }),
    ],
  }, null, 2), 'utf8');

  const first = JSON.parse(cli(dir, ['add', '--file', file, '--json']));
  assert.equal(first.added, 1);
  assert.equal(first.rejected, 1);
  assert.equal(first.duplicates, 1, 'second copy of the same link is a duplicate, not a new candidate');

  const store = createLibraryStore({ dataDir: dir });
  const pool = store.listCandidates();
  assert.equal(pool.length, 1);
  assert.equal(pool[0].discoveredBy, 'ai');
  assert.equal(pool[0].status, 'new');
  assert.match(pool[0].note, /AI 制作/);
  assert.ok(store.log(10).some((entry) => entry.action === 'candidate.add' && entry.actor === 'discovery:ai'));

  // A film already in the catalogue is treated as a duplicate, never re-added.
  const filmFile = path.join(dir, 'film.json');
  fs.writeFileSync(filmFile, JSON.stringify({
    id: 'jiayi', title: '甲', author: '测试作者', source: 'bilibili',
    sourceUrl: 'https://www.bilibili.com/video/BV1cc3333333', category: 'short', genres: ['scifi'],
    kind: '科幻', access: 'free', runtime: '12:30', cover: 'img/jiayi-640w.webp',
    description: '深海观测站失联第 41 天。', intakeDate: '2026-11-03',
  }), 'utf8');
  execFileSync(node, ['scripts/framepick-library-cli.mjs', 'add', '--file', filmFile], { cwd: root, env: { ...process.env, FRAMEPICK_LIBRARY_DATA_DIR: dir } });
  const second = JSON.parse(cli(dir, ['add', '--file', file, '--json']));
  assert.equal(second.duplicates, 2, 'same title+author as an existing film counts as duplicate');
  assert.equal(second.added, 0);
});

test('verification reports platforms that need a login instead of guessing', async (t) => {
  const dir = await dataDir(t);
  const file = path.join(dir, 'found.json');
  fs.writeFileSync(file, JSON.stringify({
    runAt: '2026-11-03T09:00:00+08:00', runBy: 'ai',
    candidates: [candidate({ source: 'douyin', url: 'https://www.douyin.com/video/7698714697905868032' })],
  }, null, 2), 'utf8');
  cli(dir, ['add', '--file', file, '--json']);
  const results = JSON.parse(cli(dir, ['verify', '--json'])).results;
  assert.equal(results.length, 1);
  assert.equal(results[0].verifiable, false);
  assert.match(results[0].reason, /需登录/);
});

test('report writes a run file and never publishes anything', async (t) => {
  const dir = await dataDir(t);
  const file = path.join(dir, 'found.json');
  fs.writeFileSync(file, JSON.stringify({
    runAt: '2026-11-03T09:00:00+08:00', runBy: 'ai',
    candidates: [candidate({ title: '丙', url: 'https://www.bilibili.com/video/BV1dd4444444' })],
  }, null, 2), 'utf8');
  cli(dir, ['add', '--file', file, '--json']);
  const output = JSON.parse(cli(dir, ['report', '--json']));
  assert.match(output.report, /^docs\/framepick-discovery-20261103\/runs\/.+\.md$/);
  const markdown = fs.readFileSync(path.join(root, output.report), 'utf8');
  assert.match(markdown, /待处理候选/);
  assert.match(markdown, /丙/);
  assert.match(markdown, /未自动上架/);
  fs.rmSync(path.join(root, output.report));
  assert.equal(createLibraryStore({ dataDir: dir }).listFilms('published').length, 0);
});

test('plan lists the search surface without inventing anything', async (t) => {
  const dir = await dataDir(t);
  const output = cli(dir, ['plan']);
  assert.match(output, /哔哩哔哩/);
  assert.match(output, /search\.bilibili\.com/);
  assert.match(output, /抖音/);
  assert.match(output, /硬门槛/);
  assert.match(output, /池内现状/);
});

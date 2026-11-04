import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createLibraryStore } = require('../server/framepick-library.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const node = process.execPath;

const film = (overrides = {}) => ({
  id: 'guiyuan', title: '归渊', author: '沉舟计划', source: 'bilibili',
  sourceUrl: 'https://www.bilibili.com/video/BV1xx411c7mD', category: 'short', genres: ['scifi'],
  runtime: '18:24', cover: 'img/guiyuan-640w.webp', description: '深海观测站失联第 41 天。',
  intakeDate: '2026-11-02', ...overrides,
});

async function store(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-library-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return createLibraryStore({ dataDir });
}

function publish(s, id) {
  for (const status of ['reviewing', 'approved', 'scheduled', 'published']) s.setStatus(id, status);
}

test('films start as drafts and only published films reach the public list', async (t) => {
  const s = await store(t);
  const added = s.addFilm(film());
  assert.equal(added.status, 'draft');
  assert.equal(s.publishedFilms().length, 0);
  publish(s, 'guiyuan');
  const [public1] = s.publishedFilms();
  assert.equal(public1.id, 'guiyuan');
  // Private material never leaves the store.
  assert.equal('rights' in public1, false);
  assert.equal('priceCents' in public1, false);
  assert.equal('updatedAt' in public1, false);
});

test('status transitions follow the review flow and reject shortcuts', async (t) => {
  const s = await store(t);
  s.addFilm(film());
  assert.throws(() => s.setStatus('guiyuan', 'published'), /不能从 draft 直接变为 published/);
  s.setStatus('guiyuan', 'reviewing');
  assert.throws(() => s.setStatus('guiyuan', 'delisted'), /不能从 reviewing 直接变为 delisted/);
  publish(s, 'guiyuan');
  s.setStatus('guiyuan', 'delisted');
  assert.equal(s.getFilm('guiyuan').status, 'delisted');
  assert.equal(s.publishedFilms().length, 0);
  s.setStatus('guiyuan', 'reviewing');
  assert.equal(s.getFilm('guiyuan').status, 'reviewing');
});

test('duplicate detection matches the same link or the same title and author', async (t) => {
  const s = await store(t);
  s.addFilm(film());
  assert.throws(() => s.addFilm(film({ id: 'other' })), /重复/);
  // Same title and author under a different link is still the same work.
  assert.throws(() => s.addFilm(film({ id: 'third', sourceUrl: 'https://www.bilibili.com/video/BVzzzz1111' })), /重复/);
  assert.equal(s.listFilms().length, 1);
});

test('paid films require a complete film and confirmed rights', async (t) => {
  const s = await store(t);
  assert.throws(() => s.addFilm(film({ access: 'paid' })), /只有完整电影/);
  assert.throws(() => s.addFilm(film({ access: 'paid', category: 'film' })), /必须先确认授权/);
  const paid = s.addFilm(film({ access: 'paid', category: 'film', rights: { status: 'confirmed', scope: '中国大陆线上放映', end: '2027-11-02' } }));
  assert.equal(paid.access, 'paid');
  // Changing rights after scheduling must go back through review (CRE-06).
  s.setStatus('guiyuan', 'reviewing'); s.setStatus('guiyuan', 'approved'); s.setStatus('guiyuan', 'scheduled');
  assert.throws(() => s.updateFilm('guiyuan', { rights: { status: 'pending' } }), /必须先退回审核/);
  s.setStatus('guiyuan', 'reviewing');
  s.updateFilm('guiyuan', { rights: { status: 'confirmed', scope: '中国大陆线上放映' } });
  assert.equal(s.getFilm('guiyuan').rights.status, 'confirmed');
});

test('a serialised episode without an episode note cannot be published', async (t) => {
  const s = await store(t);
  s.addFilm(film({ id: 'ep', category: 'series' }));
  s.setStatus('ep', 'reviewing'); s.setStatus('ep', 'approved'); s.setStatus('ep', 'scheduled');
  assert.throws(() => s.setStatus('ep', 'published'), /缺少集号说明/);
  s.updateFilm('ep', { episode: '第 01 集' });
  s.setStatus('ep', 'published');
  assert.equal(s.publishedFilms().length, 1);
});

test('source, host, runtime, score and intake date are validated', async (t) => {
  const s = await store(t);
  assert.throws(() => s.addFilm(film({ id: 'a', source: 'youtube' })), /来源必须是/);
  assert.throws(() => s.addFilm(film({ id: 'b', sourceUrl: 'https://www.douyin.com/video/1' })), /与来源/);
  assert.throws(() => s.addFilm(film({ id: 'c', sourceUrl: 'http://www.bilibili.com/video/BV1' })), /必须使用 HTTPS/);
  assert.throws(() => s.addFilm(film({ id: 'd', runtime: '18 分钟' })), /时长格式/);
  assert.throws(() => s.addFilm(film({ id: 'e', editorScore: 12 })), /0–10/);
  assert.throws(() => s.addFilm(film({ id: 'f', intakeDate: '2099-01-01' })), /未来日期/);
  assert.throws(() => s.addFilm(film({ id: 'g', genres: [] })), /至少需要一个题材/);
  assert.throws(() => s.addFilm(film({ id: 'Bad Id' })), /只能包含小写字母/);
});

test('the original release date is recorded separately from the intake date', async (t) => {
  const s = await store(t);
  // 三种精度都接受：日、月、年。
  const variant = (id, url, extra = {}) => film({ id, title: `作品${id}`, author: `作者${id}`, sourceUrl: url, ...extra });
  assert.equal(s.addFilm(variant('day', 'https://www.bilibili.com/video/BV1dd411c7mD', { originalReleaseDate: '2026-09-10' })).originalReleaseDate, '2026-09-10');
  assert.equal(s.addFilm(variant('month', 'https://www.bilibili.com/video/BV1mm411c7mD', { originalReleaseDate: '2026-09' })).originalReleaseDate, '2026-09');
  assert.equal(s.addFilm(variant('year', 'https://www.bilibili.com/video/BV1yy411c7mD', { originalReleaseDate: '2026.9' })).originalReleaseDate, '2026-09');
  // 未记录时是空字符串，不猜日期。
  assert.equal(s.addFilm(variant('none', 'https://www.bilibili.com/video/BV1nn411c7mD')).originalReleaseDate, '');
  assert.throws(() => s.addFilm(variant('bad', 'https://www.bilibili.com/video/BV1bb411c7mD', { originalReleaseDate: '去年春天' })), /格式应为/);
  assert.throws(() => s.addFilm(variant('future', 'https://www.bilibili.com/video/BV1ff411c7mD', { originalReleaseDate: '2099-01-01' })), /未来日期/);
  assert.throws(() => s.addFilm(variant('month13', 'https://www.bilibili.com/video/BV1tt411c7mD', { originalReleaseDate: '2026-13' })), /月份无效/);
  // 原片发布日期与收录日期互不影响，也一起进入公开字段。
  const published = s.publishedFilms().find((item) => item.id === 'day');
  assert.equal(published, undefined, 'still a draft');
  s.setStatus('day', 'reviewing'); s.setStatus('day', 'approved'); s.setStatus('day', 'scheduled'); s.setStatus('day', 'published');
  const [publicFilm] = s.publishedFilms();
  assert.equal(publicFilm.originalReleaseDate, '2026-09-10');
  assert.equal(publicFilm.intakeDate, film().intakeDate);
});

test('candidates move through verification and convert into a film once', async (t) => {
  const s = await store(t);
  const candidate = s.addCandidate({ title: '归渊', author: '沉舟计划', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD', discoveredBy: 'manual' });
  assert.equal(candidate.status, 'new');
  assert.throws(() => s.addCandidate({ title: '归渊', author: '沉舟计划', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }), /候选池已有同一链接/);
  assert.throws(() => s.setCandidateStatus(candidate.id, 'watching'), /不能从 new 直接变为 watching/);
  s.setCandidateStatus(candidate.id, 'verifying');
  s.setCandidateStatus(candidate.id, 'watching');
  const converted = s.convertCandidate(candidate.id, film());
  assert.equal(converted.status, 'draft');
  assert.equal(s.listCandidates()[0].filmId, 'guiyuan');
  assert.throws(() => s.convertCandidate(candidate.id, film({ id: 'again' })), /已转换/);
  // A converted candidate blocks the same link from entering the pool again.
  assert.throws(() => s.addCandidate({ title: '归渊', author: '沉舟计划', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }), /已在作品表中/);
});

test('candidate ids come from the platform clip id, not from the chinese title', async (t) => {
  const s = await store(t);
  // 中文片名抠不出字母时，旧写法会把十几条候选都命名成「ai」；平台编号稳定且唯一。
  const douyin = s.addCandidate({ title: 'AI短片《本体》 国产爱死机有没有说法', author: 'todo', source: 'douyin', url: 'https://www.douyin.com/video/7699342435985476905' });
  assert.equal(douyin.id, 'dy-7699342435985476905');
  const bili = s.addCandidate({ title: '归渊', author: '沉舟计划', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' });
  assert.equal(bili.id, 'bili-bv1xx411c7md');
  // 短链里没有平台编号时退回 cand-N，而不是一个随时会撞号的单字母。
  const shortLink = s.addCandidate({ title: '某一集', author: '甲', source: 'bilibili', url: 'https://b23.tv/abcd12' });
  assert.match(shortLink.id, /^cand-\d+$/);
});

test('candidate ids stay unique and can be reindexed from the clip id', async (t) => {
  const s = await store(t);
  const first = s.addCandidate({ id: 'ai', title: '第一条', author: '甲', source: 'douyin', url: 'https://www.douyin.com/video/7000000000000000001' });
  const second = s.addCandidate({ id: 'ai', title: '第二条', author: '乙', source: 'douyin', url: 'https://www.douyin.com/video/7000000000000000002' });
  assert.equal(first.id, 'ai');
  assert.equal(second.id, 'ai-2', '同一个显式 ID 第二次出现时补序号，不能两条候选共用一个 ID');
  const changes = s.reindexCandidates({ dryRun: true });
  assert.equal(changes.length, 2);
  assert.equal(s.listCandidates()[0].id, 'ai', 'dryRun 不改数据');
  assert.deepEqual(s.reindexCandidates().map((item) => item.to), ['dy-7000000000000000001', 'dy-7000000000000000002']);
  assert.deepEqual(s.listCandidates().map((item) => item.id), ['dy-7000000000000000001', 'dy-7000000000000000002']);
  assert.deepEqual(s.reindexCandidates(), [], '重算是幂等的');
  assert.ok(s.log(10).some((entry) => entry.action === 'candidate.reindex'));
});

test('every change is recorded with an actor and survives a reload', async (t) => {
  const s = await store(t);
  s.addFilm(film(), { actor: 'operator' });
  s.setStatus('guiyuan', 'reviewing', { actor: 'reviewer', note: '人工审片' });
  const entries = s.log(10);
  assert.ok(entries.some((entry) => entry.action === 'film.add' && entry.actor === 'operator'));
  assert.ok(entries.some((entry) => entry.detail.includes('人工审片')));
  const reloaded = createLibraryStore({ dataDir: s.dataDir });
  assert.equal(reloaded.getFilm('guiyuan').status, 'reviewing');
  assert.equal(reloaded.log(10).length, entries.length);
});

test('the builder reproduces the shipped catalogue byte for byte', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-build-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const site = await mkdtemp(path.join(os.tmpdir(), 'framepick-site-test-'));
  t.after(() => rm(site, { recursive: true, force: true }));
  fs.cpSync(root, site, { recursive: true, filter: (src) => !src.includes('/.git') && !src.includes('/node_modules') });

  const env = { ...process.env, FRAMEPICK_LIBRARY_DATA_DIR: dataDir };
  const run = (args) => execFileSync(node, args, { cwd: root, env, encoding: 'utf8' });
  run(['scripts/framepick-library-cli.mjs', 'seed', '--site', site]);
  run(['scripts/build-framepick-library.mjs', '--site', site]);
  const regenerated = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  assert.equal(regenerated, fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  // A second pass is a no-op, so the page can be rebuilt from CI safely.
  run(['scripts/build-framepick-library.mjs', '--site', site, '--check']);
});

test('publishing a new film adds its card and updates the counts', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-grow-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const site = await mkdtemp(path.join(os.tmpdir(), 'framepick-site-test-'));
  t.after(() => rm(site, { recursive: true, force: true }));
  fs.cpSync(root, site, { recursive: true, filter: (src) => !src.includes('/.git') && !src.includes('/node_modules') });

  const env = { ...process.env, FRAMEPICK_LIBRARY_DATA_DIR: dataDir };
  const run = (args) => execFileSync(node, args, { cwd: root, env, encoding: 'utf8' });
  run(['scripts/framepick-library-cli.mjs', 'seed', '--site', site]);
  run(['scripts/framepick-library-cli.mjs', 'add', '--json', JSON.stringify(film({
    id: 'guiyuan', category: 'short', genres: ['scifi'], intakeDate: '2026-11-02',
  }))]);
  publish(createLibraryStore({ dataDir }), 'guiyuan');
  run(['scripts/build-framepick-library.mjs', '--site', site]);

  // Counts follow the shipped catalogue, so adding a work never hardcodes a total.
  const shipped = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const cardsOf = (html) => [...html.matchAll(/<article\b[^>]*\bdata-film="/g)].length;
  const shortsOf = (html) => [...html.matchAll(/<article\b[^>]*\bdata-category="short"/g)].length;
  const total = cardsOf(shipped) + 1;
  const shorts = shortsOf(shipped) + 1;

  const page = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  assert.match(page, /data-film="guiyuan"/);
  assert.equal(cardsOf(page), total);
  assert.match(page, new RegExp(`${total} 部公开精选`));
  assert.match(page, new RegExp(`已收录 ${total} 部`));
  assert.match(page, new RegExp(`data-category="short" aria-pressed="false">剧情短片 <span>${shorts}<\\/span>`));
  // Delisting removes the card again without deleting the record.
  const s = createLibraryStore({ dataDir });
  s.setStatus('guiyuan', 'delisted');
  run(['scripts/build-framepick-library.mjs', '--site', site]);
  const after = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  assert.doesNotMatch(after, /data-film="guiyuan"/);
  assert.equal(s.getFilm('guiyuan').status, 'delisted');
});

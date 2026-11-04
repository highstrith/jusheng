import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createCreatorStore } = require('../server/framepick-creators.cjs');

async function store(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-creators-test-'));
  const libraryDataDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-creators-library-'));
  t.after(() => Promise.all([rm(dataDir, { recursive: true, force: true }), rm(libraryDataDir, { recursive: true, force: true })]));
  return createCreatorStore({ dataDir, libraryDataDir });
}

const application = (overrides = {}) => ({
  accountId: 'acc_test',
  name: '张小千',
  email: 'creator@example.com',
  contact: 'https://www.douyin.com/user/abc',
  intro: '一人包办导演、编剧与后期的 AI 影像作者。',
  aiUsage: '画面由自训练模型生成，配乐使用自有素材。',
  samples: ['https://www.douyin.com/video/7675665548755176758'],
  ...overrides,
});

const submission = (overrides = {}) => ({
  title: '归渊',
  author: '张小千',
  source: 'bilibili',
  sourceUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
  category: 'film',
  genres: ['scifi'],
  runtime: '42:10',
  synopsis: '深海观测站失联第 41 天，值守员收到自己三天前发出的求救信号。',
  access: 'free',
  materials: {
    completeFilm: true,
    previewUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    aiUsage: '画面由自训练模型生成，声音为原创。',
    rightsEvidence: '已签署授权确认邮件，转载与放映范围待运营复核。',
  },
  ...overrides,
});

function approve(store_) {
  const app = store_.addApplication(application(), { actor: 'creator' });
  store_.setApplicationStatus(app.id, 'reviewing', { actor: 'operator' });
  store_.setApplicationStatus(app.id, 'approved', { actor: 'operator' });
  return app;
}

test('applications start as submitted and only move along the review flow', async (t) => {
  const s = await store(t);
  const app = s.addApplication(application(), { actor: 'creator' });
  assert.equal(app.status, 'submitted');
  assert.throws(() => s.setApplicationStatus(app.id, 'approved'), /不能从 submitted 直接变为 approved/);
  s.setApplicationStatus(app.id, 'reviewing');
  s.setApplicationStatus(app.id, 'approved');
  assert.equal(s.getApplication(app.id).status, 'approved');
  assert.throws(() => s.setApplicationStatus(app.id, 'rejected'), /不能从 approved/);
});

test('one account cannot stack applications while one is still open', async (t) => {
  const s = await store(t);
  s.addApplication(application(), { actor: 'creator' });
  assert.throws(() => s.addApplication(application({ name: '另一个名字' }), { actor: 'creator' }), /已有一份申请/);
  // A rejected application frees the account to apply again.
  const first = s.listApplications()[0];
  s.setApplicationStatus(first.id, 'rejected');
  const again = s.addApplication(application(), { actor: 'creator' });
  assert.equal(again.status, 'submitted');
});

test('an invited creator starts approved, because the operator vouched for them', async (t) => {
  const s = await store(t);
  const app = s.addApplication(application({ invited: true, accountId: '' }), { actor: 'operator' });
  assert.equal(app.status, 'approved');
  assert.equal(app.invited, true);
  assert.match(s.log().map((entry) => entry.action).join(','), /application\.invite/);
});

test('CRE-01: only an approved creator can submit, and approval alone does not publish', async (t) => {
  const s = await store(t);
  const app = s.addApplication(application(), { actor: 'creator' });
  assert.throws(() => s.addSubmission(submission({ applicationId: app.id })), /尚未通过/);
  s.setApplicationStatus(app.id, 'reviewing');
  s.setApplicationStatus(app.id, 'approved');
  const sub = s.addSubmission(submission({ applicationId: app.id }), { actor: 'creator' });
  assert.equal(sub.status, 'submitted');
  // Nothing reaches the public catalogue until an operator converts it.
  assert.equal(s.getSubmission(sub.id).filmId, null);
});

test('CRE-02: intake refuses a submission without materials, AI usage or rights evidence', async (t) => {
  const s = await store(t);
  const app = approve(s);
  assert.throws(() => s.addSubmission(submission({ applicationId: app.id, materials: {} })), /AI 使用情况说明不能为空/);
  assert.throws(() => s.addSubmission(submission({ applicationId: app.id, materials: { completeFilm: true, aiUsage: '有' } })), /权利材料说明不能为空/);
  assert.throws(() => s.addSubmission(submission({ applicationId: app.id, runtime: '42' })), /时长格式/);
  assert.throws(() => s.addSubmission(submission({ applicationId: app.id, source: 'youtube' })), /来源必须是/);
});

test('CRE-05: paid submissions require a complete film with confirmed rights', async (t) => {
  const s = await store(t);
  const app = approve(s);
  assert.throws(() => s.addSubmission(submission({ applicationId: app.id, access: 'paid' })), /必须先确认授权/);
  assert.throws(() => s.addSubmission(submission({
    applicationId: app.id,
    access: 'paid',
    rights: { status: 'confirmed' },
    materials: { completeFilm: false, previewUrl: 'https://www.bilibili.com/video/BV1xx411c7mD', aiUsage: '有', rightsEvidence: '有' },
  })), /必须是完整成片/);
  const ok = s.addSubmission(submission({
    applicationId: app.id,
    access: 'paid',
    rights: { status: 'confirmed', scope: '中国大陆地区线上放映' },
  }), { actor: 'creator' });
  assert.equal(ok.access, 'paid');
});

test('LIB-04: a serialised episode must carry its episode note', async (t) => {
  const s = await store(t);
  const app = approve(s);
  assert.throws(() => s.addSubmission(submission({ applicationId: app.id, category: 'series' })), /集号说明/);
  const ok = s.addSubmission(submission({ applicationId: app.id, category: 'series', episode: '第 01 集' }), { actor: 'creator' });
  assert.equal(ok.episode, '第 01 集');
});

test('submissions follow the review flow and can be sent back for changes', async (t) => {
  const s = await store(t);
  const app = approve(s);
  const sub = s.addSubmission(submission({ applicationId: app.id }), { actor: 'creator' });
  assert.throws(() => s.setSubmissionStatus(sub.id, 'accepted'), /不能从 submitted 直接变为 accepted/);
  s.setSubmissionStatus(sub.id, 'reviewing');
  s.setSubmissionStatus(sub.id, 'need-changes', { note: '声音需要重混' });
  assert.equal(s.getSubmission(sub.id).reviewNote, '');
  s.addSubmissionNote(sub.id, '声音需要重混');
  assert.equal(s.getSubmission(sub.id).reviewNote, '声音需要重混');
  s.setSubmissionStatus(sub.id, 'submitted');
  s.setSubmissionStatus(sub.id, 'reviewing');
  s.setSubmissionStatus(sub.id, 'accepted');
  assert.equal(s.getSubmission(sub.id).status, 'accepted');
});

test('editing an accepted submission sends it back to review (CRE-06)', async (t) => {
  const s = await store(t);
  const app = approve(s);
  const sub = s.addSubmission(submission({ applicationId: app.id }), { actor: 'creator' });
  s.setSubmissionStatus(sub.id, 'reviewing');
  s.setSubmissionStatus(sub.id, 'accepted');
  const edited = s.updateSubmission(sub.id, { synopsis: '换了一段更准确的简介。' }, { actor: 'creator' });
  assert.equal(edited.status, 'reviewing');
  assert.equal(edited.synopsis, '换了一段更准确的简介。');
});

test('conversion needs an accepted submission and a cover, and links the film back', async (t) => {
  const s = await store(t);
  const app = approve(s);
  const sub = s.addSubmission(submission({ applicationId: app.id }), { actor: 'creator' });
  assert.throws(() => s.convertSubmission(sub.id), /只有通过审核/);
  s.setSubmissionStatus(sub.id, 'reviewing');
  s.setSubmissionStatus(sub.id, 'accepted');
  assert.throws(() => s.convertSubmission(sub.id), /转入片库需要封面路径/);
  const { submission: converted, film } = s.convertSubmission(sub.id, { cover: 'img/guiyuan-640w.webp', id: 'guiyuan' }, { actor: 'operator' });
  assert.equal(converted.status, 'converted');
  assert.equal(converted.filmId, 'guiyuan');
  assert.equal(film.status, 'draft');
  assert.deepEqual(film.creator, { id: app.id, name: '张小千', submissionId: sub.id });
  // The film lives in the catalogue, so the normal review flow applies from here.
  const { createLibraryStore } = require('../server/framepick-library.cjs');
  const catalogue = createLibraryStore({ dataDir: s.libraryDir });
  assert.equal(catalogue.getFilm('guiyuan').creator.id, app.id);
  assert.throws(() => s.convertSubmission(sub.id, { cover: 'img/guiyuan-640w.webp' }), /只有通过审核/);
});

test('the private intake trail is logged and never leaks into the public film', async (t) => {
  const s = await store(t);
  const app = approve(s);
  const sub = s.addSubmission(submission({ applicationId: app.id, access: 'paid', rights: { status: 'confirmed' } }), { actor: 'creator' });
  const actions = s.log().map((entry) => entry.action);
  assert.deepEqual(actions.includes('application.add'), true);
  assert.deepEqual(actions.includes('submission.add'), true);
  const { createLibraryStore } = require('../server/framepick-library.cjs');
  const catalogue = createLibraryStore({ dataDir: s.libraryDir });
  s.setSubmissionStatus(sub.id, 'reviewing');
  s.setSubmissionStatus(sub.id, 'accepted');
  s.convertSubmission(sub.id, { cover: 'img/guiyuan-640w.webp', id: 'guiyuan' });
  for (const status of ['reviewing', 'approved', 'scheduled', 'published']) catalogue.setStatus('guiyuan', status);
  const [public1] = catalogue.publishedFilms();
  assert.equal(public1.id, 'guiyuan');
  assert.equal('creator' in public1, false);
  assert.equal('rights' in public1, false);
});

test('a corrupt store refuses to start instead of quietly resetting', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-creators-corrupt-'));
  const libraryDataDir = await mkdtemp(path.join(os.tmpdir(), 'framepick-creators-library-'));
  t.after(() => Promise.all([rm(dataDir, { recursive: true, force: true }), rm(libraryDataDir, { recursive: true, force: true })]));
  const fs = require('node:fs');
  fs.writeFileSync(path.join(dataDir, 'creators.json'), '{ not json');
  assert.throws(() => createCreatorStore({ dataDir, libraryDataDir }).listApplications(), /已拒绝覆盖/);
});

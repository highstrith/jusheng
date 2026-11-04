'use strict';
// Framepick creator applications and work submissions (PRD section 9: CRE-01..CRE-06).
//
// Stage B scope: an approved creator identity, plus a submission an operator can
// review before it becomes a catalogue film. The self-service workbench with
// earnings is stage D, so nothing here shows prices or payouts.
//
// Private material - contact details, rights evidence, reviewer notes - lives
// outside the repository (default ~/.framepick/creators) and never reaches Git
// or the published Pages artifact.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createLibraryStore,
  LibraryError,
  validateSourceUrl,
  RUNTIME,
  SOURCES,
  CATEGORIES,
  GENRES,
  ACCESS,
} = require('./framepick-library.cjs');

// CRE-03: 已提交 → 审核中 → 通过／未通过／需补充。
const APPLICATION_STATUSES = ['submitted', 'reviewing', 'approved', 'rejected', 'need-info'];
const APPLICATION_TRANSITIONS = {
  submitted: ['reviewing', 'rejected'],
  reviewing: ['approved', 'rejected', 'need-info'],
  'need-info': ['reviewing', 'rejected'],
  rejected: ['reviewing'],
  approved: [],
};

// CRE-03 continued: 草稿 → 已提交 → 审核中 → 通过／未通过／需修改 → 转入片库。
// After "converted" the catalogue state machine owns the film.
const SUBMISSION_STATUSES = ['draft', 'submitted', 'reviewing', 'accepted', 'rejected', 'need-changes', 'withdrawn', 'converted'];
const SUBMISSION_TRANSITIONS = {
  draft: ['submitted', 'withdrawn'],
  submitted: ['reviewing', 'withdrawn'],
  reviewing: ['accepted', 'rejected', 'need-changes', 'withdrawn'],
  'need-changes': ['submitted', 'withdrawn'],
  rejected: ['submitted', 'withdrawn'],
  accepted: ['converted', 'withdrawn'],
  withdrawn: [],
  converted: [],
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

class CreatorError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CreatorError';
    this.status = status;
  }
}

const fail = (message) => { throw new CreatorError(400, message); };

function text(value, field, { max = 400, required = true } = {}) {
  const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!normalized && required) fail(`${field}不能为空`);
  return normalized.slice(0, max);
}

function optionalUrl(value, field) {
  const raw = text(value, '', { required: false, max: 300 });
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    fail(`${field}不是合法 URL：${raw}`);
  }
  if (parsed.protocol !== 'https:') fail(`${field}必须使用 HTTPS`);
  return raw;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function intakeToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// The catalogue owns the real field rules; reuse them so a submission cannot
// carry something the library would reject at conversion time.
function throughLibrary(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof LibraryError) throw new CreatorError(400, error.message);
    throw error;
  }
}

function validateApplicationInput(input) {
  const name = text(input?.name, '创作者名称', { max: 80 });
  const email = text(input?.email, '', { required: false, max: 200 });
  if (email && !EMAIL.test(email)) fail('联系邮箱格式不正确');
  const contact = optionalUrl(input?.contact, '联系或主页链接');
  const intro = text(input?.intro, '创作简介', { max: 600 });
  const aiUsage = text(input?.aiUsage, 'AI 使用情况说明', { max: 600 });
  const samples = (Array.isArray(input?.samples) ? input.samples : [])
    .map((item) => optionalUrl(item, '作品链接'))
    .filter(Boolean)
    .slice(0, 5);
  if (!samples.length && !contact) fail('至少提供一个作品链接或主页，便于核实身份');
  return { name, email, contact, intro, aiUsage, samples };
}

function validateSubmissionInput(input) {
  const title = text(input?.title, '片名', { max: 80 });
  const author = text(input?.author, '作者署名', { max: 80 });
  const source = text(input?.source, '来源');
  if (!SOURCES[source]) fail(`来源必须是 ${Object.keys(SOURCES).join(' / ')} 之一`);
  const sourceUrl = throughLibrary(() => validateSourceUrl(source, input?.sourceUrl));
  const category = text(input?.category, '作品类型');
  if (!CATEGORIES[category]) fail(`作品类型必须是 ${Object.keys(CATEGORIES).join(' / ')} 之一`);
  const genres = [...new Set((Array.isArray(input?.genres) ? input.genres : []).map((genre) => String(genre).trim()).filter(Boolean))];
  if (!genres.length) fail('至少需要一个题材');
  if (genres.some((genre) => !GENRES[genre])) fail(`题材必须是 ${Object.keys(GENRES).join(' / ')} 之一`);
  const access = input?.access || 'free';
  if (!ACCESS[access]) fail('观看方式只能是 free 或 paid');
  const runtime = text(input?.runtime, '时长', { max: 12 });
  if (!RUNTIME.test(runtime)) fail(`时长格式应为 mm:ss 或 h:mm:ss，当前为「${runtime}」`);
  const synopsis = text(input?.synopsis, '简介', { max: 600 });
  // LIB-04: a serialised episode must never travel without its episode note.
  const episode = text(input?.episode, '', { required: false, max: 120 }) || '';
  if (category === 'series' && !episode) fail('系列短剧必须填写集号说明，连载的一集不得被描述成完整电影');

  const rights = {
    status: input?.rights?.status || 'none',
    scope: text(input?.rights?.scope, '', { required: false, max: 200 }) || '',
    start: text(input?.rights?.start, '', { required: false, max: 10 }) || '',
    end: text(input?.rights?.end, '', { required: false, max: 10 }) || '',
    note: text(input?.rights?.note, '', { required: false, max: 400 }) || '',
  };
  if (!['none', 'pending', 'confirmed'].includes(rights.status)) fail('授权状态只能是 none / pending / confirmed');

  // CRE-02: materials are part of the intake, not an afterthought.
  const previewUrl = optionalUrl(input?.materials?.previewUrl, '试看物料链接');
  const aiUsage = text(input?.materials?.aiUsage, 'AI 使用情况说明', { max: 600 });
  const rightsEvidence = text(input?.materials?.rightsEvidence, '权利材料说明', { max: 600 });
  const materials = {
    completeFilm: Boolean(input?.materials?.completeFilm),
    previewUrl,
    aiUsage,
    rightsEvidence,
    note: text(input?.materials?.note, '', { required: false, max: 600 }) || '',
  };

  // CRE-05 / LIB-08: no paid episode, no paid film without confirmed rights.
  if (access === 'paid') {
    if (category !== 'film') fail('只有完整电影（category=film）可以标为付费，单集不得作为付费正片');
    if (!materials.completeFilm) fail('付费投稿必须是完整成片，片段或单集不能作为付费正片');
    if (rights.status !== 'confirmed') fail('付费放映必须先确认授权（rights.status=confirmed），不能仅凭公开链接收费');
  }

  return {
    title,
    author,
    source,
    sourceUrl,
    category,
    genres,
    kind: text(input?.kind, '', { required: false, max: 60 }) || genres.map((genre) => GENRES[genre] || genre).join(' / '),
    access,
    runtime,
    cover: text(input?.cover, '', { required: false, max: 200 }) || '',
    synopsis,
    episode,
    rights,
    materials,
  };
}

function createCreatorStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.FRAMEPICK_CREATORS_DATA_DIR || path.join(os.homedir(), '.framepick', 'creators'));
  const file = path.join(dataDir, 'creators.json');
  const library = options.library || createLibraryStore({ dataDir: options.libraryDataDir });
  fs.mkdirSync(dataDir, { recursive: true });

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        version: 1,
        applications: Array.isArray(parsed.applications) ? parsed.applications : [],
        submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [],
        log: Array.isArray(parsed.log) ? parsed.log : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new CreatorError(500, `创作者数据无法读取，已拒绝覆盖：${error.message}`);
      return { version: 1, applications: [], submissions: [], log: [] };
    }
  }

  function write(data) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = path.join(dataDir, `.creators-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  }

  function appendLog(data, entry) {
    data.log.push({ at: new Date().toISOString(), ...entry });
    if (data.log.length > 2000) data.log = data.log.slice(-2000);
  }

  function findApplication(data, id) {
    const application = data.applications.find((item) => item.id === id);
    if (!application) throw new CreatorError(404, `找不到创作者申请 ${id}`);
    return application;
  }

  function findSubmission(data, id) {
    const submission = data.submissions.find((item) => item.id === id);
    if (!submission) throw new CreatorError(404, `找不到投稿 ${id}`);
    return submission;
  }

  function transition(kind, table, current, next, label) {
    if (current === next) return;
    const allowed = table[current] || [];
    if (!allowed.includes(next)) {
      fail(`不能从 ${current} 直接变为 ${next}（${label}），允许：${allowed.join(' / ') || '无'}`);
    }
  }

  return {
    dataDir,
    libraryDir: library.dataDir,

    listApplications(status) {
      const data = read();
      return data.applications.filter((item) => !status || item.status === status);
    },

    getApplication(id) {
      return findApplication(read(), id);
    },

    applicationForAccount(accountId) {
      const data = read();
      return data.applications.find((item) => item.accountId === accountId) || null;
    },

    // CRE-01: applying does not make a work sellable - approval is separate, and
    // an invitation from the operator starts already approved.
    addApplication(input, meta = {}) {
      const data = read();
      const fields = validateApplicationInput(input);
      const accountId = text(input?.accountId, '', { required: false, max: 40 }) || '';
      if (accountId) {
        const pending = data.applications.find((item) => item.accountId === accountId && item.status !== 'rejected');
        if (pending) fail(`该账号已有一份申请（${pending.id}，状态 ${pending.status}），请等待审核结果`);
      }
      const invited = Boolean(input?.invited);
      const now = new Date().toISOString();
      const record = {
        id: newId('app'),
        accountId,
        invited,
        status: invited ? 'approved' : 'submitted',
        reviewNote: '',
        createdAt: now,
        updatedAt: now,
        ...fields,
      };
      data.applications.push(record);
      appendLog(data, { action: invited ? 'application.invite' : 'application.add', target: record.id, actor: meta.actor || (invited ? 'operator' : 'creator'), detail: `${fields.name}${record.accountId ? ` · ${record.accountId}` : ''}` });
      write(data);
      return record;
    },

    setApplicationStatus(id, status, meta = {}) {
      const data = read();
      const application = findApplication(data, id);
      if (!APPLICATION_STATUSES.includes(status)) fail(`申请状态必须是 ${APPLICATION_STATUSES.join(' / ')} 之一`);
      transition('申请', APPLICATION_TRANSITIONS, application.status, status, 'CRE-03');
      const from = application.status;
      application.status = status;
      application.updatedAt = new Date().toISOString();
      appendLog(data, { action: 'application.status', target: id, actor: meta.actor || 'operator', detail: `${from} → ${status}${meta.note ? ` · ${meta.note}` : ''}` });
      write(data);
      return application;
    },

    addApplicationNote(id, note, meta = {}) {
      const data = read();
      const application = findApplication(data, id);
      const clean = text(note, '审核意见', { max: 600 });
      application.reviewNote = clean;
      application.updatedAt = new Date().toISOString();
      appendLog(data, { action: 'application.note', target: id, actor: meta.actor || 'operator', detail: clean });
      write(data);
      return application;
    },

    listSubmissions({ status, applicationId } = {}) {
      const data = read();
      return data.submissions
        .filter((item) => !status || item.status === status)
        .filter((item) => !applicationId || item.applicationId === applicationId);
    },

    getSubmission(id) {
      return findSubmission(read(), id);
    },

    // CRE-01: only an approved creator submits. The operator can file on behalf of
    // an invited creator, which is the "人工投稿" path.
    addSubmission(input, meta = {}) {
      const data = read();
      const applicationId = text(input?.applicationId, '创作者申请');
      const application = findApplication(data, applicationId);
      if (application.status !== 'approved') fail(`该创作者申请尚未通过（当前 ${application.status}），通过审核后才能投稿`);
      const fields = validateSubmissionInput(input);
      const status = input?.status === 'draft' ? 'draft' : 'submitted';
      const now = new Date().toISOString();
      const record = {
        id: newId('sub'),
        applicationId,
        creator: { accountId: application.accountId, name: application.name, email: application.email },
        status,
        reviewNote: '',
        filmId: null,
        createdAt: now,
        updatedAt: now,
        ...fields,
      };
      data.submissions.push(record);
      appendLog(data, { action: 'submission.add', target: record.id, actor: meta.actor || 'creator', detail: `${fields.title} · ${application.name}` });
      write(data);
      return record;
    },

    updateSubmission(id, patch, meta = {}) {
      const data = read();
      const submission = findSubmission(data, id);
      if (['converted'].includes(submission.status)) fail('已转入片库的投稿不能再修改，请改作品表');
      const next = validateSubmissionInput({ ...submission, ...patch, materials: { ...submission.materials, ...(patch?.materials || {}) }, rights: { ...submission.rights, ...(patch?.rights || {}) } });
      Object.assign(submission, next, { updatedAt: new Date().toISOString() });
      // CRE-06 spirit: editing a live submission sends it back through review.
      if (submission.status === 'accepted') submission.status = 'reviewing';
      appendLog(data, { action: 'submission.update', target: id, actor: meta.actor || 'creator', detail: Object.keys(patch).join(',') });
      write(data);
      return submission;
    },

    setSubmissionStatus(id, status, meta = {}) {
      const data = read();
      const submission = findSubmission(data, id);
      if (!SUBMISSION_STATUSES.includes(status)) fail(`投稿状态必须是 ${SUBMISSION_STATUSES.join(' / ')} 之一`);
      if (status === 'converted') fail('请通过 convertSubmission 转入片库，避免跳过封面与授权检查');
      transition('投稿', SUBMISSION_TRANSITIONS, submission.status, status, 'CRE-03');
      const from = submission.status;
      submission.status = status;
      submission.updatedAt = new Date().toISOString();
      appendLog(data, { action: 'submission.status', target: id, actor: meta.actor || 'operator', detail: `${from} → ${status}${meta.note ? ` · ${meta.note}` : ''}` });
      write(data);
      return submission;
    },

    addSubmissionNote(id, note, meta = {}) {
      const data = read();
      const submission = findSubmission(data, id);
      const clean = text(note, '审核意见', { max: 600 });
      submission.reviewNote = clean;
      submission.updatedAt = new Date().toISOString();
      appendLog(data, { action: 'submission.note', target: id, actor: meta.actor || 'operator', detail: clean });
      write(data);
      return submission;
    },

    // CRE-05: conversion is where a submission becomes a sellable candidate, so
    // the paid gates run again here even though submission intake already ran them.
    convertSubmission(id, filmInput = {}, meta = {}) {
      const submission = findSubmission(read(), id);
      if (submission.status !== 'accepted') fail(`只有通过审核（accepted）的投稿才能转入片库，当前为 ${submission.status}`);
      if (submission.access === 'paid') {
        if (!submission.materials.completeFilm) fail('付费投稿必须是完整成片');
        if (submission.rights.status !== 'confirmed') fail('付费放映必须先确认授权（rights.status=confirmed）');
      }
      const cover = filmInput.cover || submission.cover;
      if (!cover) fail('转入片库需要封面路径：投稿时可先留空，转换时用 cover 指定');
      const application = findApplication(read(), submission.applicationId);
      const film = throughLibrary(() => library.addFilm({
        ...filmInput,
        title: filmInput.title || submission.title,
        author: filmInput.author || submission.author,
        source: submission.source,
        sourceUrl: submission.sourceUrl,
        category: submission.category,
        genres: submission.genres,
        kind: filmInput.kind || submission.kind,
        access: submission.access,
        runtime: submission.runtime,
        cover,
        coverAlt: filmInput.coverAlt || `${submission.title} 封面`,
        description: filmInput.description || submission.synopsis,
        episode: submission.episode,
        intakeDate: filmInput.intakeDate || intakeToday(),
        rights: submission.rights,
        creator: { id: application.id, name: application.name, submissionId: submission.id },
        priceCents: filmInput.priceCents ?? null,
      }, { actor: meta.actor || 'operator' }));

      const data = read();
      const stored = findSubmission(data, id);
      stored.status = 'converted';
      stored.filmId = film.id;
      stored.updatedAt = new Date().toISOString();
      appendLog(data, { action: 'submission.convert', target: id, actor: meta.actor || 'operator', detail: `→ ${film.id}` });
      write(data);
      return { submission: stored, film };
    },

    log(limit = 50) {
      const data = read();
      return data.log.slice(-limit);
    },
  };
}

function publicApplication(application) {
  return {
    id: application.id,
    status: application.status,
    name: application.name,
    contact: application.contact,
    samples: application.samples,
    reviewNote: application.reviewNote,
    invited: Boolean(application.invited),
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
  };
}

function publicSubmission(submission) {
  return {
    id: submission.id,
    applicationId: submission.applicationId,
    status: submission.status,
    reviewNote: submission.reviewNote,
    title: submission.title,
    author: submission.author,
    source: submission.source,
    sourceUrl: submission.sourceUrl,
    category: submission.category,
    genres: submission.genres,
    access: submission.access,
    runtime: submission.runtime,
    episode: submission.episode,
    synopsis: submission.synopsis,
    rights: { status: submission.rights.status, scope: submission.rights.scope },
    materials: { completeFilm: submission.materials.completeFilm, previewUrl: submission.materials.previewUrl },
    filmId: submission.filmId,
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt,
  };
}

const CREATOR_RATE_LIMITS = {
  apply: { windowMs: 60 * 60 * 1000, limit: 3 },
  submit: { windowMs: 60 * 60 * 1000, limit: 12 },
};

// HTTP surface for the same store. Mounted before the review handler, which
// claims every /api/framepick path.
function createCreatorHandler({
  dataDir = process.env.FRAMEPICK_CREATORS_DATA_DIR || path.join(os.homedir(), '.framepick', 'creators'),
  libraryDataDir = process.env.FRAMEPICK_LIBRARY_DATA_DIR,
  allowedOrigin = process.env.FRAMEPICK_REVIEWS_ALLOWED_ORIGIN || '',
  accounts = null,
  clock = Date.now,
} = {}) {
  const store = createCreatorStore({ dataDir, libraryDataDir });
  const attempts = new Map();

  function rateLimit(key, kind) {
    const rule = CREATOR_RATE_LIMITS[kind];
    const now = clock();
    const recent = (attempts.get(key) || []).filter((at) => now - at < rule.windowMs);
    if (recent.length >= rule.limit) {
      attempts.set(key, recent);
      throw new CreatorError(429, '提交过于频繁，请稍后再试。');
    }
    recent.push(now);
    attempts.set(key, recent);
    if (attempts.size > 5000) attempts.clear();
  }

  async function readJsonBody(req, maxBytes = 16384) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) throw new CreatorError(413, '请求内容过大。');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_) {
      throw new CreatorError(400, '请求格式不正确。');
    }
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  async function currentAccount(req) {
    if (!accounts) throw new CreatorError(501, '账号服务未接入，无法核验创作者身份。');
    return accounts.resolveAccount(req);
  }

  return {
    store,

    async handle(req, res, url) {
      const pathname = url.pathname;
      if (pathname !== '/api/framepick/creators' && !pathname.startsWith('/api/framepick/creators/')) return false;
      res.setHeader('Vary', 'Origin');
      try {
        const origin = req.headers.origin;
        const ownOrigin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
        if (origin && origin !== ownOrigin && origin !== allowedOrigin) throw new CreatorError(403, '请求来源不受信任。');
        if (origin && origin === allowedOrigin) res.setHeader('Access-Control-Allow-Origin', origin);
        if (req.method !== 'GET' && req.headers['sec-fetch-site'] === 'cross-site' && (!origin || origin !== allowedOrigin)) {
          throw new CreatorError(403, '不允许跨站提交。');
        }

        if (req.method === 'GET' && pathname === '/api/framepick/creators/me') {
          const account = await currentAccount(req);
          if (!account) {
            sendJson(res, 200, { signedIn: false, account: null, application: null, isCreator: false });
            return true;
          }
          const application = store.applicationForAccount(account.id);
          sendJson(res, 200, {
            signedIn: true,
            account,
            application: application ? publicApplication(application) : null,
            isCreator: Boolean(application && application.status === 'approved'),
          });
          return true;
        }

        // CRE-01: applications come from signed-in accounts so the identity can be
        // restored on another device.
        if (req.method === 'POST' && pathname === '/api/framepick/creators/applications') {
          const account = await currentAccount(req);
          if (!account) throw new CreatorError(401, '请先登录后再申请创作者身份。');
          rateLimit(`apply:${account.id}`, 'apply');
          const body = await readJsonBody(req);
          const application = store.addApplication({ ...body, accountId: account.id, email: body?.email || account.email, invited: false }, { actor: account.id });
          sendJson(res, 201, { application: publicApplication(application) });
          return true;
        }

        if (req.method === 'GET' && pathname === '/api/framepick/creators/applications/mine') {
          const account = await currentAccount(req);
          if (!account) throw new CreatorError(401, '请先登录。');
          const application = store.applicationForAccount(account.id);
          sendJson(res, 200, { application: application ? publicApplication(application) : null });
          return true;
        }

        if (req.method === 'POST' && pathname === '/api/framepick/creators/submissions') {
          const account = await currentAccount(req);
          if (!account) throw new CreatorError(401, '请先登录后再投稿。');
          const application = store.applicationForAccount(account.id);
          if (!application) throw new CreatorError(403, '请先申请创作者身份。');
          if (application.status !== 'approved') throw new CreatorError(403, `创作者申请还在审核中（${application.status}），通过后即可投稿。`);
          rateLimit(`submit:${account.id}`, 'submit');
          const body = await readJsonBody(req);
          const submission = store.addSubmission({ ...body, applicationId: application.id }, { actor: account.id });
          sendJson(res, 201, { submission: publicSubmission(submission) });
          return true;
        }

        if (req.method === 'GET' && pathname === '/api/framepick/creators/submissions/mine') {
          const account = await currentAccount(req);
          if (!account) throw new CreatorError(401, '请先登录。');
          const application = store.applicationForAccount(account.id);
          const submissions = application ? store.listSubmissions({ applicationId: application.id }).map(publicSubmission) : [];
          sendJson(res, 200, { submissions });
          return true;
        }

        sendJson(res, 404, { error: 'Not found' });
        return true;
      } catch (error) {
        const status = error instanceof CreatorError ? error.status : 500;
        sendJson(res, status, { error: status === 500 ? '服务暂时不可用。' : error.message });
        if (status === 500) console.error(error);
        return true;
      }
    },
  };
}

module.exports = {
  createCreatorStore,
  createCreatorHandler,
  CreatorError,
  APPLICATION_STATUSES,
  SUBMISSION_STATUSES,
};

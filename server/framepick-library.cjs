'use strict';
// Framepick catalogue store: films + candidate pool + audit log.
//
// Data lives outside the repository (default ~/.framepick/library) so private
// material - rights evidence, reviewer notes, pricing drafts - never reaches Git
// or the published Pages artifact. Only films with status "published" reach the
// static site, and only their public fields do.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { overseasVideoKey } = require('./framepick-source-url.cjs');

const SOURCES = {
  youtube: { label: 'YouTube', hosts: ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'] },
  x: { label: 'X', hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'] },
  douyin: { label: '抖音', hosts: ['www.douyin.com', 'douyin.com', 'v.douyin.com', 'www.iesdouyin.com'] },
  xiaohongshu: { label: '小红书', hosts: ['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com'] },
  bilibili: { label: '哔哩哔哩', hosts: ['www.bilibili.com', 'bilibili.com', 'b23.tv'] },
};
const CATEGORIES = { film: '完整电影', series: '系列短剧', short: '剧情短片', ad: '商业广告', music: '音乐影像', experimental: '实验影像' };
// 题材对不上就无法筛选：AI 短片里除了奇幻／科幻／武侠／仙侠，还有大量都市、
// 情感与悬疑，标签要跟着内容长，不能逼着把片子塞进四个框。
const GENRES = { fantasy: '奇幻', scifi: '科幻', wuxia: '武侠', xianxia: '仙侠', urban: '都市', romance: '情感', healing: '治愈', thriller: '悬疑' };
const ACCESS = { free: '免费精选', paid: '付费放映' };
// 连载状态：单部完整 / 连载中 / 多集已完结。留空 = 尚未核实。
const COMPLETIONS = ['standalone', 'ongoing', 'completed'];
const COMPLETION_LABELS = { standalone: '单部', ongoing: '连载中', completed: '已完结' };

// Roadmap flow: 待核实 → 待看片 → 待补资料／不收录／通过 → 排期 → 上架 → 下架.
const FILM_STATUSES = ['draft', 'reviewing', 'rejected', 'approved', 'scheduled', 'published', 'delisted'];
const FILM_TRANSITIONS = {
  draft: ['reviewing', 'rejected'],
  reviewing: ['approved', 'rejected', 'draft'],
  rejected: ['reviewing'],
  approved: ['scheduled', 'reviewing'],
  scheduled: ['published', 'approved', 'reviewing'],
  published: ['delisted', 'reviewing'],
  delisted: ['reviewing'],
};
const CANDIDATE_STATUSES = ['new', 'verifying', 'watching', 'need-material', 'rejected', 'converted'];
const CANDIDATE_TRANSITIONS = {
  new: ['verifying', 'rejected'],
  verifying: ['watching', 'need-material', 'rejected'],
  watching: ['need-material', 'rejected', 'converted'],
  'need-material': ['watching', 'rejected'],
  rejected: ['verifying'],
  converted: [],
};

const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RUNTIME = /^(?:\d+:)?\d{1,2}:\d{2}$/;
// 原片发布日期：允许年到日、年月、年三种精度（2026-10-20 / 2026-10 / 2026）。
const RELEASE_DATE = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/;

class LibraryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
  }
}

const fail = (message) => { throw new LibraryError('invalid', message); };

function today() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function slug(value, fallback) {
  const base = String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const result = (base || fallback || '').slice(0, 40);
  // 中文片名抠不出字母时 base 会只剩一两个字符（甚至空），ID 规则要求至少两位，
  // 这种时候退回 fallback，别把一个随时会撞号的短 ID 写进库里。
  return result.length >= 2 ? result : String(fallback || 'candidate').slice(0, 40);
}

// 抖音、B站、小红书的链接里都带着平台自己的作品编号。用它拼候选 ID，比从中文
// 片名里抠 ASCII 稳：不会出现 21 条候选都叫「ai」，也不会因为片名重复而撞号。
const PLATFORM_IDS = [
  { source: 'douyin', prefix: 'dy', pattern: /\/video\/(\d{6,})/ },
  { source: 'bilibili', prefix: 'bili', pattern: /(BV[0-9A-Za-z]{8,12})/ },
  { source: 'xiaohongshu', prefix: 'xhs', pattern: /\/(?:explore|discovery\/item)\/([0-9a-f]{16,})/ },
];

function candidateBaseId(source, url) {
  const raw = String(url || '');
  for (const rule of PLATFORM_IDS) {
    if (rule.source !== source) continue;
    const matched = raw.match(rule.pattern);
    if (matched) return slug(`${rule.prefix}-${matched[1]}`, '');
  }
  return '';
}

function uniqueCandidateId(data, desired) {
  const taken = new Set(data.candidates.map((item) => item.id));
  if (!taken.has(desired)) return desired;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${desired.slice(0, 34)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return fail(`候选 ID ${desired} 已用尽编号`);
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function text(value, field, { max = 400, required = true } = {}) {
  const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!normalized && required) fail(`${field}不能为空`);
  return normalized.slice(0, max);
}

function validateSourceUrl(source, url) {
  const raw = text(url, '原作链接');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    fail(`原作链接不是合法 URL：${raw}`);
  }
  if (parsed.protocol !== 'https:') fail('原作链接必须使用 HTTPS');
  const allowed = SOURCES[source]?.hosts || [];
  if (allowed.length && !allowed.includes(parsed.host)) {
    fail(`原作链接域名 ${parsed.host} 与来源「${SOURCES[source].label}」不一致`);
  }
  return raw;
}

// 原片发布日期：作品在作者原平台发布的日期，和「收录日期」（intakeDate，只用于
// 今日更新榜分组）分开存。允许三种精度：2026-10-20 / 2026-10 / 2026，也接受
// 2026.9 这类单数字写法，统一补齐成两位。
function releaseDate(value) {
  const raw = text(value, '', { required: false, max: 10 });
  if (!raw) return '';
  const matched = raw.replace(/[./]/g, '-').match(RELEASE_DATE);
  if (!matched) fail(`原片发布日期格式应为 YYYY、YYYY-MM 或 YYYY-MM-DD，当前为「${raw}」`);
  const [, year, month, day] = matched;
  if (month && (Number(month) < 1 || Number(month) > 12)) fail(`原片发布日期月份无效：${raw}`);
  if (day && (Number(day) < 1 || Number(day) > 31)) fail(`原片发布日期日期无效：${raw}`);
  const normalized = [year, month, day].filter(Boolean).map((part, index) => (index ? part.padStart(2, '0') : part)).join('-');
  if (day && normalized > today()) fail(`原片发布日期 ${raw} 是未来日期`);
  return normalized;
}

function validateFilmInput(input) {
  const source = text(input?.source, '来源');
  if (!SOURCES[source]) fail(`来源必须是 ${Object.keys(SOURCES).join(' / ')} 之一`);
  const category = text(input?.category, '作品类型');
  if (!CATEGORIES[category]) fail(`作品类型必须是 ${Object.keys(CATEGORIES).join(' / ')} 之一`);
  const genres = Array.isArray(input?.genres) ? [...new Set(input.genres.map((genre) => String(genre).trim()).filter(Boolean))] : [];
  if (!genres.length) fail('至少需要一个题材');
  const access = input?.access || 'free';
  if (!ACCESS[access]) fail('观看方式只能是 free 或 paid');
  const runtime = text(input?.runtime, '时长', { max: 12 });
  if (!RUNTIME.test(runtime)) fail(`时长格式应为 mm:ss 或 h:mm:ss，当前为「${runtime}」`);
  const intakeDate = text(input?.intakeDate, '收录日期', { max: 10 });
  if (!DATE.test(intakeDate)) fail(`收录日期必须是 YYYY-MM-DD，当前为「${intakeDate}」`);
  if (intakeDate > today()) fail(`收录日期 ${intakeDate} 是未来日期`);

  let editorScore = null;
  if (input?.editorScore !== undefined && input?.editorScore !== null && input?.editorScore !== '') {
    editorScore = Number(input.editorScore);
    if (!Number.isFinite(editorScore) || editorScore < 0 || editorScore > 10) fail(`编辑评分 ${input.editorScore} 超出 0–10 分范围`);
    editorScore = Math.round(editorScore * 10) / 10;
  }

  const rights = {
    status: input?.rights?.status || 'none',
    scope: text(input?.rights?.scope, '', { required: false, max: 200 }) || '',
    start: input?.rights?.start || '',
    end: input?.rights?.end || '',
    note: text(input?.rights?.note, '', { required: false, max: 400 }) || '',
  };
  if (!['none', 'pending', 'confirmed'].includes(rights.status)) fail('授权状态只能是 none / pending / confirmed');

  // CRE-05 / LIB-08: never sell a serialised episode, never sell without confirmed rights.
  if (access === 'paid') {
    if (category !== 'film') fail('只有完整电影（category=film）可以标为付费，单集不得作为付费正片');
    if (rights.status !== 'confirmed') fail('付费放映必须先确认授权（rights.status=confirmed），不能仅凭公开链接收费');
  }
  if (category === 'series' && !text(input?.episode, '', { required: false, max: 120 })) {
    // Not fatal: many serials arrive before the episode note is written, but the
    // build refuses to publish a serial without one.
  }

  return {
    title: text(input?.title, '片名', { max: 80 }),
    author: text(input?.author, '作者', { max: 80 }),
    source,
    sourceUrl: validateSourceUrl(source, input?.sourceUrl),
    category,
    genres,
    kind: text(input?.kind, '', { required: false, max: 60 }) || genres.map((genre) => GENRES[genre] || genre).join(' / '),
    access,
    runtime,
    cover: text(input?.cover, '封面路径', { max: 200 }),
    // 平台原封面地址（B 站 pic 为永久链接；抖音为带签名的 CDN 链接，仅作取材线索）。
    // 站点不外链它，只作为素材下载的出处记录——封面是「引用原片」，不是自创作品。
    sourceCover: ((value) => {
      const clean = text(value, '', { required: false, max: 600 }) || '';
      if (clean && !/^https?:\/\//i.test(clean)) fail('sourceCover 必须是 http(s) 链接');
      return clean;
    })(input?.sourceCover),
    coverAlt: text(input?.coverAlt, '', { required: false, max: 200 }) || '',
    coverNote: text(input?.coverNote, '', { required: false, max: 40 }) || '',
    coverWidth: positiveInt(input?.coverWidth, 640),
    coverHeight: positiveInt(input?.coverHeight, 397),
    description: text(input?.description, '简介', { max: 600 }),
    recommendation: text(input?.recommendation, '', { required: false, max: 300 }) || '',
    episode: text(input?.episode, '', { required: false, max: 120 }) || '',
    // 连载状态。'' 表示还没核实（页面会写「状态待核实」，不假装知道）。
    //   standalone 单部完整 / ongoing 连载中 / completed 多集已完结
    completion: ((value) => {
      const clean = text(value, '', { required: false, max: 20 }) || '';
      if (clean && !COMPLETIONS.includes(clean)) fail(`连载状态只能是 ${COMPLETIONS.join(' / ')} 或留空`);
      return clean;
    })(input?.completion),
    // 体量，如「共 6 集」「上下两部」「合集 · 5 个短片」
    volume: text(input?.volume, '', { required: false, max: 60 }) || '',
    // 续集／前作关系，如「续作《星辰岛 2》」「《哑镖》续集」
    relation: text(input?.relation, '', { required: false, max: 120 }) || '',
    originalReleaseDate: releaseDate(input?.originalReleaseDate),
    editorScore,
    intakeDate,
    rights,
    priceCents: input?.priceCents ?? null,
    // Traceability back to a creator submission (PRD 9). Not a public field: it
    // never reaches publishedFilms() or the generated page.
    creator: input?.creator?.id
      ? {
        id: text(input.creator.id, '创作者申请 ID', { max: 40 }),
        name: text(input.creator.name, '', { required: false, max: 80 }) || '',
        submissionId: text(input.creator.submissionId, '', { required: false, max: 40 }) || '',
      }
      : null,
  };
}

function createLibraryStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.join(os.homedir(), '.framepick', 'library'));
  const file = path.join(dataDir, 'library.json');
  fs.mkdirSync(dataDir, { recursive: true });

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        version: 1,
        films: Array.isArray(parsed.films) ? parsed.films : [],
        candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
        log: Array.isArray(parsed.log) ? parsed.log : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new LibraryError('unreadable', `片库数据无法读取，已拒绝覆盖：${error.message}`);
      return { version: 1, films: [], candidates: [], log: [] };
    }
  }

  function write(data) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = path.join(dataDir, `.library-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  }

  function appendLog(data, entry) {
    data.log.push({ at: new Date().toISOString(), ...entry });
    if (data.log.length > 2000) data.log = data.log.slice(-2000);
  }

  function normalizeUrl(value) {
    const overseas = overseasVideoKey(value);
    if (overseas) return overseas;
    try {
      const url = new URL(value);
      return `${url.host}${url.pathname}`.replace(/\/+$/, '');
    } catch (_) {
      return String(value || '');
    }
  }

  function findDuplicate(data, film) {
    const url = normalizeUrl(film.sourceUrl);
    return data.films.find((item) => normalizeUrl(item.sourceUrl) === url
      || (item.title === film.title && item.author === film.author)) || null;
  }

  function findFilm(data, id) {
    const film = data.films.find((item) => item.id === id);
    if (!film) throw new LibraryError('not-found', `找不到作品 ${id}`);
    return film;
  }

  function findCandidate(data, id) {
    const candidate = data.candidates.find((item) => item.id === id);
    if (!candidate) throw new LibraryError('not-found', `找不到候选 ${id}`);
    return candidate;
  }

  return {
    dataDir,

    listFilms(status) {
      const data = read();
      return data.films.filter((film) => !status || film.status === status);
    },

    getFilm(id) {
      return findFilm(read(), id);
    },

    addFilm(input, meta = {}) {
      const data = read();
      const film = validateFilmInput(input);
      const id = text(input?.id, '', { required: false, max: 40 }) || slug(film.title, `film-${data.films.length + 1}`);
      if (!ID.test(id)) fail(`作品 ID「${id}」只能包含小写字母、数字与连字符`);
      if (data.films.some((item) => item.id === id)) fail(`作品 ID ${id} 已存在`);
      const duplicate = findDuplicate(data, film);
      if (duplicate) fail(`与已有作品「${duplicate.title}」(${duplicate.id}) 重复，请确认是否是同一部作品`);
      const now = new Date().toISOString();
      const record = { id, status: 'draft', curatedOrder: data.films.length + 1, ...film, createdAt: now, updatedAt: now };
      data.films.push(record);
      appendLog(data, { action: 'film.add', target: id, actor: meta.actor || 'operator', detail: film.title });
      write(data);
      return record;
    },

    updateFilm(id, patch, meta = {}) {
      const data = read();
      const film = findFilm(data, id);
      // CRE-06: commercial terms of a scheduled or published film cannot change
      // silently; check before validation so the operator gets the real reason.
      if (['scheduled', 'published'].includes(film.status)) {
        const accessChanged = patch?.access !== undefined && patch.access !== film.access;
        const rightsChanged = patch?.rights?.status !== undefined && patch.rights.status !== film.rights.status;
        if (accessChanged || rightsChanged) {
          throw new LibraryError('needs-review', '已排期或已上架的作品变更收费与授权，必须先退回审核（status=reviewing）');
        }
      }
      const next = validateFilmInput({ ...film, ...patch });
      Object.assign(film, next, { updatedAt: new Date().toISOString() });
      appendLog(data, { action: 'film.update', target: id, actor: meta.actor || 'operator', detail: Object.keys(patch).join(',') });
      write(data);
      return film;
    },

    setStatus(id, status, meta = {}) {
      const data = read();
      const film = findFilm(data, id);
      if (!FILM_STATUSES.includes(status)) fail(`状态必须是 ${FILM_STATUSES.join(' / ')} 之一`);
      if (film.status !== status && !FILM_TRANSITIONS[film.status].includes(status)) {
        fail(`不能从 ${film.status} 直接变为 ${status}，允许：${FILM_TRANSITIONS[film.status].join(' / ') || '无'}`);
      }
      if ((status === 'scheduled' || status === 'published') && film.access === 'paid' && film.rights.status !== 'confirmed') {
        fail('付费作品未完成授权确认，不能排期或上架');
      }
      if (status === 'published' && film.category === 'series' && !film.episode) {
        fail('系列单集缺少集号说明，不能上架：连载的一集不得被描述成完整电影');
      }
      const from = film.status;
      film.status = status;
      film.updatedAt = new Date().toISOString();
      appendLog(data, { action: 'film.status', target: id, actor: meta.actor || 'operator', detail: `${from} → ${status}${meta.note ? ` · ${meta.note}` : ''}` });
      write(data);
      return film;
    },

    addNote(id, note, meta = {}) {
      const data = read();
      const film = findFilm(data, id);
      const clean = text(note, '审核意见', { max: 600 });
      film.updatedAt = new Date().toISOString();
      appendLog(data, { action: 'film.note', target: id, actor: meta.actor || 'operator', detail: clean });
      write(data);
      return film;
    },

    listCandidates(status) {
      const data = read();
      return data.candidates.filter((item) => !status || item.status === status);
    },

    addCandidate(input, meta = {}) {
      const data = read();
      const title = text(input?.title, '候选片名', { max: 80 });
      const author = text(input?.author, '候选作者', { max: 80 });
      const source = text(input?.source, '来源');
      if (!SOURCES[source]) fail(`来源必须是 ${Object.keys(SOURCES).join(' / ')} 之一`);
      const url = validateSourceUrl(source, input?.url);
      const duplicateFilm = data.films.find((film) => normalizeUrl(film.sourceUrl) === normalizeUrl(url)
        || (film.title === title && film.author === author));
      if (duplicateFilm) fail(`该候选已在作品表中：${duplicateFilm.title} (${duplicateFilm.id})`);
      const duplicateCandidate = data.candidates.find((item) => normalizeUrl(item.url) === normalizeUrl(url));
      if (duplicateCandidate) fail(`候选池已有同一链接：${duplicateCandidate.id}（${duplicateCandidate.title}）`);
      const now = new Date().toISOString();
      const record = {
        id: uniqueCandidateId(data, text(input?.id, '', { required: false, max: 40 })
          || candidateBaseId(source, url)
          || slug(`${author}-${title}`, `cand-${data.candidates.length + 1}`)),
        title, author, source, url,
        discoveredBy: ['ai', 'manual', 'creator'].includes(input?.discoveredBy) ? input.discoveredBy : 'manual',
        discoveredAt: input?.discoveredAt || now,
        evidence: Array.isArray(input?.evidence) ? input.evidence.slice(0, 20).map((item) => ({
          kind: text(item?.kind, '证据类型', { required: false, max: 40 }) || 'link',
          url: text(item?.url, '证据链接', { required: false, max: 300 }),
          note: text(item?.note, '', { required: false, max: 300 }) || '',
          capturedAt: item?.capturedAt || now,
        })) : [],
        popularity: input?.popularity ? { metric: text(input.popularity.metric, '热度指标', { required: false, max: 40 }), value: text(input.popularity.value, '热度数值', { required: false, max: 40 }), capturedAt: input.popularity.capturedAt || now } : null,
        sourceCover: ((value) => {
          const clean = text(value, '', { required: false, max: 600 }) || '';
          if (clean && !/^https?:\/\//i.test(clean)) fail('sourceCover 必须是 http(s) 链接');
          return clean;
        })(input?.sourceCover),
        note: text(input?.note, '', { required: false, max: 600 }) || '',
        status: 'new',
        filmId: null,
        createdAt: now,
        updatedAt: now,
      };
      if (!ID.test(record.id)) fail(`候选 ID「${record.id}」只能包含小写字母、数字与连字符`);
      data.candidates.push(record);
      appendLog(data, { action: 'candidate.add', target: record.id, actor: meta.actor || 'operator', detail: `${title} · ${source}` });
      write(data);
      return record;
    },

    // 早期候选 ID 是从「作者-片名」里抠 ASCII 得来的，中文片名会退化成 ai / aigc /
    // 单个字母，几十条重号。这个操作用平台编号重算一遍，幂等，可反复跑。
    reindexCandidates({ dryRun = false, actor = 'operator' } = {}) {
      const data = read();
      const taken = new Set();
      const changes = [];
      data.candidates.forEach((item, index) => {
        const desired = candidateBaseId(item.source, item.url)
          || slug(`${item.author}-${item.title}`, `cand-${index + 1}`);
        let next = desired;
        for (let n = 2; taken.has(next); n += 1) next = `${desired.slice(0, 34)}-${n}`;
        taken.add(next);
        if (next === item.id) return;
        changes.push({ from: item.id, to: next, title: item.title, status: item.status });
        if (dryRun) return;
        item.id = next;
        item.updatedAt = new Date().toISOString();
      });
      if (!dryRun && changes.length) {
        appendLog(data, {
          action: 'candidate.reindex',
          target: `${changes.length} 条`,
          actor,
          detail: changes.slice(0, 8).map((item) => `${item.from}→${item.to}`).join('，') + (changes.length > 8 ? ` …共 ${changes.length} 条` : ''),
        });
        write(data);
      }
      return changes;
    },

    setCandidateStatus(id, status, meta = {}) {
      const data = read();
      const candidate = findCandidate(data, id);
      if (!CANDIDATE_STATUSES.includes(status)) fail(`候选状态必须是 ${CANDIDATE_STATUSES.join(' / ')} 之一`);
      if (candidate.status !== status && !CANDIDATE_TRANSITIONS[candidate.status].includes(status)) {
        fail(`不能从 ${candidate.status} 直接变为 ${status}，允许：${CANDIDATE_TRANSITIONS[candidate.status].join(' / ') || '无'}`);
      }
      const from = candidate.status;
      candidate.status = status;
      candidate.updatedAt = new Date().toISOString();
      appendLog(data, { action: 'candidate.status', target: id, actor: meta.actor || 'operator', detail: `${from} → ${status}${meta.note ? ` · ${meta.note}` : ''}` });
      write(data);
      return candidate;
    },

    convertCandidate(id, filmInput, meta = {}) {
      const data = read();
      const candidate = findCandidate(data, id);
      if (candidate.status === 'converted') fail(`候选 ${id} 已转换`);
      const film = validateFilmInput({ ...filmInput, source: filmInput?.source || candidate.source, sourceUrl: filmInput?.sourceUrl || candidate.url, title: filmInput?.title || candidate.title, author: filmInput?.author || candidate.author, sourceCover: filmInput?.sourceCover || candidate.sourceCover || '' });
      const filmId = text(filmInput?.id, '', { required: false, max: 40 }) || slug(film.title, `film-${data.films.length + 1}`);
      if (!ID.test(filmId)) fail(`作品 ID「${filmId}」只能包含小写字母、数字与连字符`);
      if (data.films.some((item) => item.id === filmId)) fail(`作品 ID ${filmId} 已存在`);
      const duplicate = findDuplicate(data, film);
      if (duplicate) fail(`与已有作品「${duplicate.title}」(${duplicate.id}) 重复`);
      const now = new Date().toISOString();
      const record = { id: filmId, status: 'draft', curatedOrder: data.films.length + 1, ...film, createdAt: now, updatedAt: now };
      data.films.push(record);
      candidate.status = 'converted';
      candidate.filmId = filmId;
      candidate.updatedAt = now;
      appendLog(data, { action: 'candidate.convert', target: id, actor: meta.actor || 'operator', detail: `→ ${filmId}` });
      write(data);
      return record;
    },

    // Only published films, in curated order, with public fields only.
    publishedFilms() {
      return this.listFilms('published')
        .sort((a, b) => (a.curatedOrder ?? 0) - (b.curatedOrder ?? 0) || b.intakeDate.localeCompare(a.intakeDate))
        .map((film) => ({
          id: film.id, title: film.title, author: film.author, source: film.source, sourceUrl: film.sourceUrl,
          category: film.category, genres: film.genres, kind: film.kind, access: film.access, runtime: film.runtime,
          cover: film.cover, coverAlt: film.coverAlt, coverNote: film.coverNote,
          coverWidth: film.coverWidth, coverHeight: film.coverHeight,
          description: film.description, recommendation: film.recommendation, episode: film.episode,
          completion: film.completion || '', volume: film.volume || '', relation: film.relation || '',
          originalReleaseDate: film.originalReleaseDate,
          editorScore: film.editorScore, intakeDate: film.intakeDate,
        }));
    },

    log(limit = 50) {
      const data = read();
      return data.log.slice(-limit);
    },
  };
}

module.exports = {
  createLibraryStore,
  LibraryError,
  validateSourceUrl,
  RUNTIME,
  SOURCES,
  CATEGORIES,
  GENRES,
  ACCESS,
  COMPLETIONS,
  COMPLETION_LABELS,
  FILM_STATUSES,
  CANDIDATE_STATUSES,
};

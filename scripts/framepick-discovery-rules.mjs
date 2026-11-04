// Screening rules for discovered films. Pure functions, no store access and no
// side effects, so the CLI and the tests share exactly one implementation.
const SOURCE_HOSTS = {
  bilibili: ['www.bilibili.com', 'bilibili.com', 'b23.tv'],
  douyin: ['www.douyin.com', 'douyin.com', 'v.douyin.com', 'www.iesdouyin.com'],
  xiaohongshu: ['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com'],
};

export const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
export const normalizeUrl = (value) => String(value || '').trim()
  .replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/^\/+/, '').toLocaleLowerCase();

export function parseRuntimeSeconds(value) {
  const text = oneLine(value);
  const matched = text.match(/^(?:(\d+):)?(\d{1,3}):(\d{2})$/);
  if (matched) return Number(matched[1] || 0) * 3600 + Number(matched[2]) * 60 + Number(matched[3]);
  const seconds = Number(text);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLocaleLowerCase();
  } catch {
    return '';
  }
}

// Returns why an item was dropped so the run report can show the reason.
export function screenCandidate(item, { config, films = [], candidates = [] } = {}) {
  const reasons = [];
  const title = oneLine(item?.title);
  const author = oneLine(item?.author);
  if (!title) reasons.push('缺少片名');
  if (!author) reasons.push('缺少作者');

  const source = oneLine(item?.source);
  const url = oneLine(item?.url);
  if (!source || !SOURCE_HOSTS[source]) reasons.push(`来源不支持：${source || '（空）'}`);
  if (!url) reasons.push('缺少原片链接');
  if (source && SOURCE_HOSTS[source] && url) {
    const host = hostOf(url);
    if (!host || !SOURCE_HOSTS[source].includes(host)) reasons.push(`链接与来源不匹配：${host || url}`);
  }

  const [minSeconds, maxSeconds] = Array.isArray(config?.runtimeRangeSeconds) ? config.runtimeRangeSeconds : [180, 2400];
  const seconds = parseRuntimeSeconds(item?.runtime);
  if (seconds === null) reasons.push('缺少可核实的时长');
  else if (seconds < minSeconds || seconds > maxSeconds) {
    reasons.push(`时长 ${Math.floor(seconds / 60)} 分钟不在 ${Math.floor(minSeconds / 60)}–${Math.floor(maxSeconds / 60)} 分钟区间内`);
  }

  const haystack = `${title} ${oneLine(item?.note)}`.toLocaleLowerCase();
  const excluded = (config?.excludeKeywords || []).find((word) => haystack.includes(String(word).toLocaleLowerCase()));
  if (excluded) reasons.push(`命中排除词「${excluded}」（教程／解说／合集／预告等不收录）`);

  if (config?.requireAiEvidence) {
    const hasEvidence = item?.aiEvidence === true || Boolean(oneLine(item?.aiEvidenceNote));
    if (!hasEvidence) reasons.push('缺少 AI 制作属性证据（需原页表述，不能凭观感判断）');
  }

  if (url && films.some((film) => normalizeUrl(film.sourceUrl) === normalizeUrl(url))) reasons.push('作品表已有同一链接');
  if (title && author && films.some((film) => oneLine(film.title) === title && oneLine(film.author) === author)) reasons.push('作品表已有同名同作者作品');
  if (url && candidates.some((entry) => normalizeUrl(entry.url) === normalizeUrl(url))) reasons.push('候选池已有同一链接');
  if (title && author && candidates.some((entry) => oneLine(entry.title) === title && oneLine(entry.author) === author)) reasons.push('候选池已有同名同作者候选');

  const duplicate = reasons.some((reason) => reason.includes('已有'));
  return { status: reasons.length ? (duplicate ? 'duplicate' : 'rejected') : 'accepted', reasons };
}

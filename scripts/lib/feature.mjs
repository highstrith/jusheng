// 首屏主推的归属：生成器（写大图区块）和周榜（写榜单列表）必须用同一套规则，
// 否则大图上放的第一名会在榜单里再出现一次，同一部片首屏出现两遍。
import fs from 'node:fs';
import path from 'node:path';

export function pinnedFeatureId(siteDir) {
  try {
    const { id } = JSON.parse(fs.readFileSync(path.join(siteDir, 'data', 'feature-film.json'), 'utf8'));
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

// 手选（且确实已上架）优先；否则本周推荐第一部。
export function resolveHeroId({ siteDir, picks = [], publishedIds = null }) {
  const pinned = pinnedFeatureId(siteDir);
  if (pinned && (!publishedIds || publishedIds.has(pinned))) return pinned;
  return picks[0] || null;
}

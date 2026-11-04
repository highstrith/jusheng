// 抖音搜片：在 ego-browser 里运行，复用你已经登录的浏览器会话。
//
//   ego-browser nodejs < scripts/framepick-discovery-douyin.js
//
// 前置条件（只做一次）：
//   1. ego-browser 里打开 https://www.douyin.com 并手动登录（agent 看不到密码）。
//   2. 若脚本提示"未登录/无结果"，用 task.handOff() 把窗口交回自己登录后再跑一次。
//
// 行为边界：只读搜索结果列表（时长/播放/标题简介/作者/相对时间/链接），
// 不点赞、不关注、不评论、不私信、不下载原片；每关键词之间停 4.5 秒。
//
// 输出：/tmp/framepick-douyin.json，格式与 scripts/framepick-discovery-cli.mjs 的输入一致。
const fs = await import('node:fs/promises');

const CONFIG = '/Volumes/E61--/网站/jusheng/docs/framepick-discovery-20261103/sources.json';
const OUT = '/tmp/framepick-douyin.json';
const SPACE = 'framepick-douyin';
const MAX_PER_KEYWORD = 30;
const MAX_KEYWORDS = 6;

const AI_PATTERNS = [
  [/\bai\b/i, 'AI'], [/aigc/i, 'AIGC'], [/人工智能/, '人工智能'],
  [/ai\s*(生成|制作|短片|电影|动画|短剧|视频)/i, 'AI生成／制作'],
  [/即梦/, '即梦'], [/可灵/, '可灵'], [/midjourney/i, 'Midjourney'], [/\bsora\b/i, 'Sora'],
  [/runway/i, 'Runway'], [/seedance/i, 'Seedance'], [/海螺/, '海螺AI'], [/\bveo\b/i, 'Veo'],
];

function aiEvidence(...texts) {
  const haystack = texts.filter(Boolean).join(' ').toLowerCase();
  for (const [pattern, label] of AI_PATTERNS) {
    const found = pattern.exec(haystack);
    if (found) {
      const start = Math.max(0, found.index - 30);
      return { proved: true, note: `原页出现「${label}」：${haystack.slice(start, found.index + found[0].length + 30).trim().slice(0, 140)}` };
    }
  }
  return { proved: false, note: '标题与简介未出现 AI 制作表述' };
}

const config = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
// ego-browser 的 nodejs 运行时收不到 shell 环境变量（FOO=bar 传不进去），关键词统一
// 从 sources.json 取前 6 条；要换词就改配置，别指望 FRAMEPICK_DOUYIN_KEYWORDS。
const keywords = config.queries.slice(0, MAX_KEYWORDS);

const task = await taskSpace(SPACE);
const page = task.page('p1');
const seen = new Map();

for (const keyword of keywords) {
  await page.goto(`https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const rows = await page.evaluate(() => [...document.querySelectorAll('a[href*="/video/"]')].map((anchor) => {
    const card = anchor.closest('li') || anchor.parentElement;
    return {
      href: anchor.href.replace(/^\/\//, 'https://').split('?')[0],
      lines: (card?.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean),
    };
  }));
  let added = 0;
  for (const row of rows.slice(0, MAX_PER_KEYWORD)) {
    const id = (row.href.match(/\/video\/(\d+)/) || [])[1];
    if (!id || seen.has(id)) continue;
    const runtime = row.lines.find((line) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(line)) || '';
    const heat = row.lines.find((line) => /^[\d.]+万?$/.test(line)) || '';
    const body = row.lines.find((line) => line.length > 6
      && !/^\d{1,2}:\d{2}/.test(line) && !line.startsWith('@') && !/^[\d.]+万?$/.test(line)) || '';
    const author = (row.lines.find((line) => line.startsWith('@')) || '').replace(/^@/, '');
    const when = row.lines[row.lines.length - 1] || '';
    const cut = body.search(/[#。！？]/);
    const title = (cut > 4 ? body.slice(0, cut) : body.slice(0, 40)).trim().slice(0, 60);
    const evidence = aiEvidence(title, body);
    seen.set(id, {
      title,
      author: author || '（未取到作者）',
      source: 'douyin',
      url: row.href,
      runtime,
      publishedDisplay: when,
      popularity: heat ? { metric: '点赞', value: heat } : null,
      description: body.slice(0, 600),
      note: `抖音搜索「${keyword}」· ${when}`,
      aiEvidence: evidence.proved,
      aiEvidenceNote: evidence.note,
      evidence: [{ kind: '搜索页快照', url: row.href, note: `${author} · ${runtime} · ${heat} · ${when}` }],
    });
    added += 1;
  }
  console.log(`${keyword}：新增 ${added}，累计 ${seen.size}`);
}

const total = seen.size;
await fs.writeFile(OUT, JSON.stringify({
  runAt: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00',
  runBy: 'ai',
  candidates: [...seen.values()],
}, null, 2));

const withEvidence = [...seen.values()].filter((item) => item.aiEvidence).length;
console.log(`共 ${total} 条（含 AI 制作表述 ${withEvidence} 条）→ ${OUT}`);
if (!total) {
  console.log('没有抓到结果：多半是登录态失效（抖音搜索未登录只返回导航栏）。把窗口交回本人登录后再跑。');
}

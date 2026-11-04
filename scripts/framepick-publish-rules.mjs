// 「这条候选能不能直接上架」的判定。纯函数，不碰存储，测试与 CLI 共用。
//
// 背景：用户要求不再逐条人工看片，按「片子本身够长」放行。可是时长只是必要条件——
// 抖音上 8 分钟以上的结果里混着发布会回放、模型测评、同人二创、合集、连续剧第 9 集
// 和狗血擦边短剧。这道门把这几类挡掉，剩下的才允许上架。

// 资讯 / 工具 / 测评：讲别人做的事，或讲工具怎么用，本身不是片子。
const REPORTING = /(发布会|基准|白皮书|融资|招股|IPO|测评|实测|盘点|资讯|行业报告|开源|模型发布|大模型|参数|推出|版本更新|更新日志|预售|票房|院线|拉片|拆解|底层密码|解说|实机)/i;
// 二创：素材不是自己的，版权与署名都说不清。
const DERIVATIVE = /(同人|二创|鬼畜|混剪|MAD|reaction|搬运)/i;
// 合集：一条视频里塞好几支短片，没法当成单部作品。
const COMPILATION = /(精选集|合集|合辑|概念展示|世界观展示|花絮|预告片|片花)/i;
// 狗血 / 擦边：标题里就写着包养、代嫁、总裁、缅北这类卖点的短剧，不上。
const SALACIOUS = /(包养|小三|情妇|代嫁|逃婚|总裁|娇妻|宠妻|后宫|同居|婆媳|复仇|缅北|皮肉|擦边|福利|女大|丝袜|调教|换妻|偷情)/;
// 标题里没有片名，只有一句通用描述（「AI生成的科幻短片」），卡片无法呈现。
const NO_TITLE = /^(?:ai|aigc)\s*(?:生成|制作|创作)?的?\s*(?:科幻|奇幻|动画|真人|古风)?\s*(?:短片|电影|微电影|短剧|视频)?$/i;
// 抖音常见的"制作方声明"开头，后面跟的是简介而不是片名。
const PRODUCTION_NOTICE = /^(?:全片|本片|本篇作品|本条作品|整部片)\s*(?:由|均)/;

const MIN_SECONDS = 480; // 严格大于 8 分钟
const MAX_SECONDS = 2400;

const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

// 集号要按数值判断，不能按字符串：EP01 是入口，EP09 不是；写「01」不能因为两位数字
// 就被当成第 9 集那种情况。
function episodeNumber(title) {
  const chinese = title.match(/第\s*([一二三四五六七八九十]{1,3})\s*[集话期]/);
  if (chinese) {
    const raw = chinese[1];
    if (raw.length === 1) return CN_DIGITS[raw] ?? null;
    // 十一～九十九：十／十X／X十／X十X，够覆盖短剧标题里的集号。
    const tens = raw.startsWith('十') ? 1 : CN_DIGITS[raw[0]] ?? 0;
    const ones = raw.endsWith('十') ? 0 : CN_DIGITS[raw[raw.length - 1]] ?? 0;
    return tens * 10 + ones;
  }
  const spaced = title.match(/第\s*(\d{1,3})\s*[集话期]/);
  if (spaced) return Number(spaced[1]);
  // 「其六」这种章节写法也算集号。
  const chapter = title.match(/其\s*([一二三四五六七八九十]{1,3})/);
  if (chapter) return episodeNumber(`第${chapter[1]}集`);
  const episode = title.match(/\bEP?\s*0*(\d{1,3})\b/i);
  if (episode) return Number(episode[1]);
  return null;
}

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function runtimeSecondsFromNote(note) {
  const matched = oneLine(note).match(/时长\s*(\d{1,2}):(\d{2})/);
  return matched ? Number(matched[1]) * 60 + Number(matched[2]) : null;
}

// 片名要单独抠出来：抖音标题是「修饰语 + 《片名》 + 剧情简介」一长串，直接拿去比会漏。
// 有书名号就用书名号里的；没有就削掉「AI短片」「20分钟AIGC真人武侠电影」这类前后缀。
export function filmTitle(title) {
  const raw = oneLine(title);
  const quoted = raw.match(/[《「]([^》」]{1,40})[》」]/);
  if (quoted) return quoted[1].trim();
  return raw
    .replace(/^(?:ai|aigc|原创|自制|国产|全ai)[^，,。:：]{0,14}?(?:短片|电影|微电影|剧|动画)/i, '')
    .split(/[，,。！？!?｜|·]/)[0]
    .replace(/\s+/g, '')
    .slice(0, 30);
}

const normalizeTitle = (value) => oneLine(value).replace(/[《》「」\s·:：!！?？,，.。'"“”]/g, '').toLocaleLowerCase();

// 跨平台同片很常见：同一部片子抖音一条、B 站一条，标题还各写各的。只要抠出来的
// 片名和已有作品互相包含，就按重复处理，绝不让它在页面上出现两次。
function duplicatesExisting(title, films = [], siblings = []) {
  const core = normalizeTitle(filmTitle(title));
  if (!core || core.length < 2) return '';
  const clash = (other, label) => {
    const name = normalizeTitle(filmTitle(other));
    if (!name || name.length < 2) return '';
    if (name === core) return `${label}《${filmTitle(other)}》`;
    // 互相包含只在名字足够长时才算重复：「白昼」和「白昼禁区」是两部片的不同写法，
    // 但「烟花开在海的背面」被长标题包住就是同一部。
    const shorter = Math.min(name.length, core.length);
    if (shorter >= 4 && (name.includes(core) || core.includes(name))) return `${label}《${filmTitle(other)}》`;
    return '';
  };
  for (const film of films) {
    const hit = clash(film.title, '片库里已有');
    if (hit) return hit;
  }
  for (const other of siblings) {
    if (other === title) continue;
    const hit = clash(other, '候选池里已有同片');
    if (hit) return hit;
  }
  return '';
}

// 返回 { eligible, reasons }：reasons 为空才算能上架，否则就是不能上的理由。
export function publishability(item, { films = [], siblings = [] } = {}) {
  const title = oneLine(item?.title);
  const seconds = Number.isFinite(item?.runtimeSeconds) ? item.runtimeSeconds : runtimeSecondsFromNote(item?.note);
  const reasons = [];

  if (!title) reasons.push('缺少片名');
  else if (NO_TITLE.test(title)) reasons.push('标题里没有片名，只是一句通用描述');
  else if (PRODUCTION_NOTICE.test(title)) reasons.push('标题是制作方声明，没有片名');
  if (seconds === null) reasons.push('备注里没有可核实的时长');
  else if (seconds <= MIN_SECONDS) reasons.push(`时长 ${Math.floor(seconds / 60)} 分钟，不超过 8 分钟`);
  else if (seconds > MAX_SECONDS) reasons.push(`时长 ${Math.floor(seconds / 60)} 分钟，超过 40 分钟`);

  const hits = [
    [REPORTING, '资讯／工具／测评'],
    [DERIVATIVE, '同人二创'],
    [COMPILATION, '合集／预告'],
    [SALACIOUS, '狗血擦边'],
  ];
  for (const [pattern, label] of hits) {
    const found = title.match(pattern);
    if (found) reasons.push(`命中「${found[0]}」：${label}`);
  }
  const episode = episodeNumber(title);
  if (episode !== null && episode > 1) reasons.push(`第 ${episode} 集：系列中间集，只上第一集`);

  const duplicate = duplicatesExisting(title, films, siblings);
  if (duplicate) reasons.push(`重复：${duplicate}`);

  return { eligible: reasons.length === 0, reasons, runtimeSeconds: seconds, filmTitle: filmTitle(title) };
}

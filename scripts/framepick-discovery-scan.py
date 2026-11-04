#!/usr/bin/env python3
"""Bilibili discovery scanner for Framepick.

Primary backend is bilibili-api-python (public web API, wbi-signed by the library,
no login). A Playwright backend stays as a fallback for the day the API changes.

  python3 scripts/framepick-discovery-scan.py scan    --out /tmp/found.json [--pages 1] [--limit 20] [--backend api|browser]
  python3 scripts/framepick-discovery-scan.py channel --mid 123456 --out /tmp/found.json [--limit 30]
  python3 scripts/framepick-discovery-scan.py enrich  --file /tmp/found.json

Output is the input format of scripts/framepick-discovery-cli.mjs.

Why not yt-dlp: `bilisearch` returns ids only in flat mode, and per-video extraction
is answered with HTTP 412 by Bilibili's anti-bot unless cookies are supplied.
Why not Scrapy/Crawlee: they are crawling frameworks; here one documented public API
already returns clean structured fields, so a framework would only add moving parts.
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'docs' / 'framepick-discovery-20261103' / 'sources.json'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
EM = re.compile(r'</?em[^>]*>')


def to_seconds(value):
    """'12:30' / '1:02:03' / 750 -> seconds; None when unparseable."""
    if isinstance(value, (int, float)):
        return int(value) if value > 0 else None
    text = str(value or '').strip()
    parts = text.split(':')
    # A bare "12" is ambiguous (12 s or 12 min?) and "1:2" is malformed: require
    # mm:ss / h:mm:ss with a two-digit seconds field.
    if not text or len(parts) < 2 or len(parts) > 3 or len(parts[-1]) != 2 or not all(part.isdigit() for part in parts):
        return None
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + int(part)
    return seconds or None


def to_runtime(value):
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    seconds = to_seconds(value)
    if not seconds:
        return ''
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f'{hours}:{minutes:02d}:{secs:02d}' if hours else f'{minutes:02d}:{secs:02d}'


def clean_title(value):
    return EM.sub('', str(value or '')).replace('&quot;', '"').strip()


# Word-boundary matching: a bare "ai" substring also hits said/wait/email, which
# would make every page look like an AI production.
AI_PATTERNS = [
    (re.compile(r'\bai\b'), 'AI'), (re.compile(r'aigc'), 'AIGC'), (re.compile(r'人工智能'), '人工智能'),
    (re.compile(r'ai\s*(生成|制作|短片|电影|动画|短剧|视频|绘)'), 'AI生成／制作'),
    (re.compile(r'midjourney'), 'Midjourney'), (re.compile(r'\bsora\b'), 'Sora'), (re.compile(r'可灵'), '可灵'),
    (re.compile(r'runway'), 'Runway'), (re.compile(r'即梦'), '即梦'), (re.compile(r'stable\s*diffusion'), 'Stable Diffusion'),
    (re.compile(r'comfy\s*ui'), 'ComfyUI'), (re.compile(r'\bveo\b'), 'Veo'), (re.compile(r'seedance'), 'Seedance'),
    (re.compile(r'kling'), 'Kling'), (re.compile(r'hailuo'), 'Hailuo'), (re.compile(r'海螺ai'), '海螺AI'),
]


def ai_evidence(*texts):
    """Return (bool, note). Only the uploader's own title/description/tags count."""
    haystack = ' '.join(str(text or '') for text in texts).lower()
    for pattern, label in AI_PATTERNS:
        found = pattern.search(haystack)
        if not found:
            continue
        start = max(0, found.start() - 40)
        return True, f'原页出现「{label}」：{haystack[start:found.end() + 40].strip()[:160]}'
    return False, '原页未出现 AI／AIGC 等制作属性表述，未认定为 AI 作品'


def build_candidate(item, keyword=''):
    """Normalise one Bilibili search/list entry into the discovery candidate format."""
    bvid = str(item.get('bvid') or '').strip()
    if not bvid:
        return None
    title = clean_title(item.get('title'))
    author = str(item.get('author') or item.get('uname') or '').strip()
    if not title or not author:
        return None
    runtime = to_runtime(item.get('duration') or item.get('length'))
    if not runtime:
        return None
    description = str(item.get('description') or item.get('desc') or '')
    tags = str(item.get('tag') or item.get('tags') or '')
    proved, note = ai_evidence(title, description, tags)
    published = item.get('pubdate') or item.get('created')
    published_at = time.strftime('%Y-%m-%d', time.localtime(int(published))) if isinstance(published, (int, float)) and published > 0 else ''
    plays = item.get('play')
    url = f'https://www.bilibili.com/video/{bvid}'
    pic = str(item.get('pic') or item.get('image') or '').strip()
    if pic.startswith('//'):
        pic = f'https:{pic}'
    return {
        'title': title[:80],
        'author': author[:80],
        'source': 'bilibili',
        'url': url,
        'sourceCover': pic[:600],
        'runtime': runtime,
        'publishedAt': published_at,
        'popularity': {'metric': '播放', 'value': str(plays)} if isinstance(plays, (int, float)) else None,
        'description': description[:600],
        'tags': tags[:300],
        'note': f'命中关键词「{keyword}」' if keyword else '',
        'aiEvidence': proved,
        'aiEvidenceNote': note,
        'evidence': [{'kind': '搜索接口快照', 'url': url, 'note': f'{author} · {runtime} · {plays if plays is not None else "?"} 播放'}],
    }


def scan_api(queries, pages, limit, out):
    from bilibili_api import search, sync
    seen, candidates = set(), []
    for keyword in queries:
        got = 0
        for page in range(1, pages + 1):
            try:
                result = sync(search.search_by_type(
                    keyword, search.SearchObjectType.VIDEO,
                    order_type=search.OrderVideo.PUBDATE, page=page, page_size=42,
                ))
            except Exception as error:
                print(f'  ! 关键词「{keyword}」第 {page} 页失败：{error}', file=sys.stderr)
                break
            rows = result.get('result') or []
            if not rows:
                break
            for item in rows:
                bvid = item.get('bvid')
                if not bvid or bvid in seen:
                    continue
                candidate = build_candidate(item, keyword)
                if not candidate:
                    continue
                seen.add(bvid)
                candidates.append(candidate)
                got += 1
                if got >= limit:
                    break
            if got >= limit:
                break
            time.sleep(1.0)
        print(f'  · 「{keyword}」{got} 条', file=sys.stderr)
    write(out, candidates)
    return candidates


def scan_browser(queries, limit, out):
    """Fallback: render the search page and read the cards. Breaks when Bilibili restyles."""
    from playwright.sync_api import sync_playwright
    cards_js = """
    () => Array.from(document.querySelectorAll('a[href*="/video/BV"]')).map((a) => {
      const card = a.closest('.bili-video-card') || a.closest('li') || a.parentElement;
      const raw = (card && card.innerText ? card.innerText : '');
      const parts = raw.replace(/\\s*\\n\\s*/g, ' | ').split('|').map((s) => s.trim()).filter(Boolean);
      const node = a.querySelector('.bili-video-card__info--tit, h3, [title]');
      const title = ((node && (node.getAttribute('title') || node.textContent)) || a.getAttribute('title') || '').trim();
      const at = Math.max(parts.findIndex((p) => p === title), parts.findIndex((p) => title && p.includes(title.slice(0, 6))));
      return {
        url: a.href.split('?')[0].replace(/\\/+$/, ''), title,
        author: at >= 0 ? (parts[at + 1] || '') : '',
        text: raw.slice(0, 400),
        duration: (parts.find((p) => /^(?:\\d+:)?\\d{1,3}:\\d{2}$/.test(p)) || ''),
        plays: (parts.find((p) => /^[\\d.]+万?$/.test(p)) || ''),
      };
    }).filter((item) => item.url && item.title && item.duration && item.author)
    """
    seen, candidates = set(), []
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel='chrome', headless=True)
        except Exception:
            browser = p.chromium.launch(headless=True)
        context = browser.new_context(user_agent=UA, locale='zh-CN', viewport={'width': 1440, 'height': 900})
        page = context.new_page()
        for keyword in queries:
            try:
                page.goto(f'https://search.bilibili.com/all?keyword={keyword}&order=pubdate', wait_until='domcontentloaded', timeout=45000)
                page.wait_for_timeout(3500)
                for card in page.evaluate(cards_js)[:limit]:
                    bvid = card['url'].rsplit('/', 1)[-1]
                    if not bvid or bvid in seen:
                        continue
                    seen.add(bvid)
                    proved, note = ai_evidence(card['title'], card['text'])
                    candidates.append({
                        'title': card['title'][:80], 'author': card['author'][:80], 'source': 'bilibili',
                        'url': card['url'], 'runtime': card['duration'],
                        'popularity': {'metric': '播放', 'value': card['plays']} if card['plays'] else None,
                        'description': card['text'][:600], 'tags': '',
                        'note': f'命中关键词「{keyword}」',
                        'aiEvidence': proved, 'aiEvidenceNote': note,
                        'evidence': [{'kind': '搜索页快照', 'url': card['url'], 'note': card['text'][:200]}],
                    })
            except Exception as error:
                print(f'  ! 关键词「{keyword}」抓取失败：{error}', file=sys.stderr)
            time.sleep(1.5)
        browser.close()
    write(out, candidates)
    return candidates


def channel(mid, limit, out):
    """Recent uploads of one creator, for watching authors already in the catalogue."""
    from bilibili_api import user, sync
    payload = sync(user.User(int(mid)).get_videos(pn=1))
    rows = ((payload or {}).get('list') or {}).get('vlist') or []
    candidates = []
    for item in rows[:limit]:
        candidate = build_candidate({
            'bvid': item.get('bvid'), 'title': item.get('title'), 'author': item.get('author'),
            'duration': item.get('length'), 'play': item.get('play'), 'created': item.get('created'),
            'description': item.get('description') or item.get('desc'), 'tag': item.get('tag'),
        }, f'UP主 {mid}')
        if candidate:
            candidates.append(candidate)
    write(out, candidates)
    return candidates


def enrich(path):
    """Recompute AI evidence from the stored title/description/tags.

    The API backend already stores those fields, so this needs no page loads.
    Files produced by the browser backend carry page text only; for those the
    evidence stays as captured at scan time.
    """
    payload = json.loads(Path(path).read_text(encoding='utf8'))
    for item in payload['candidates']:
        proved, note = ai_evidence(item.get('title'), item.get('description'), item.get('tags'))
        item['aiEvidence'] = proved
        item['aiEvidenceNote'] = note
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf8')
    proved = sum(1 for item in payload['candidates'] if item.get('aiEvidence'))
    print(f'复核 {len(payload["candidates"])} 条，{proved} 条在原页标题／简介／标签里找到 AI 制作属性表述 → {path}')
    return payload


def write(out, candidates):
    payload = {'runAt': time.strftime('%Y-%m-%dT%H:%M:%S+08:00'), 'runBy': 'ai', 'candidates': candidates}
    Path(out).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf8')
    print(f'{len(candidates)} 条候选 → {out}')


def main():
    parser = argparse.ArgumentParser(description='Bilibili discovery scanner')
    parser.add_argument('mode', choices=['scan', 'channel', 'enrich'])
    parser.add_argument('--out', default='/tmp/framepick-found.json')
    parser.add_argument('--file', help='enrich 模式下的候选文件')
    parser.add_argument('--mid', help='channel 模式下的 UP 主 mid')
    parser.add_argument('--limit', type=int, default=20, help='每个关键词（或每个 UP 主）最多保留多少条')
    parser.add_argument('--pages', type=int, default=1, help='api 后端每个关键词翻几页')
    parser.add_argument('--queries', help='逗号分隔的关键词，默认取 sources.json')
    parser.add_argument('--backend', choices=['api', 'browser'], default='api')
    args = parser.parse_args()

    if args.mode == 'scan':
        queries = args.queries.split(',') if args.queries else json.loads(CONFIG.read_text(encoding='utf8'))['queries']
        queries = [q.strip() for q in queries if q.strip()]
        if args.backend == 'api':
            scan_api(queries, args.pages, args.limit, args.out)
        else:
            scan_browser(queries, args.limit, args.out)
    elif args.mode == 'channel':
        if not args.mid:
            parser.error('channel 需要 --mid')
        channel(args.mid, args.limit, args.out)
    else:
        if not args.file:
            parser.error('enrich 需要 --file')
        enrich(args.file)


if __name__ == '__main__':
    main()

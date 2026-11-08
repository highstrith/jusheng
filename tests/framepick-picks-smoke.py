"""Weekly editorial picks: only films first released in the previous calendar week."""
import datetime
import functools
import http.server
import json
import re
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import framepick_layout as fp
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'data' / 'weekly-picks.json'
FEATURE_LOCK = ROOT / 'data' / 'feature-film.json'


def resolve_hero(films):
    """与 scripts/lib/feature.mjs 同规则：手选（且已上架）优先，否则本周推荐第一部。"""
    ids = [film['id'] for film in films]
    if FEATURE_LOCK.exists():
        pinned = json.loads(FEATURE_LOCK.read_text(encoding='utf-8')).get('id')
        if pinned in ids:
            return pinned
    return ids[0] if ids else None


def previous_week_window():
    """Beijing-time 'today' -> previous Monday..Sunday, as the generator does."""
    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date()
    monday = today - datetime.timedelta(days=today.weekday())
    return monday - datetime.timedelta(days=7), monday - datetime.timedelta(days=1)


def current_week_entry():
    monday = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date()
    monday -= datetime.timedelta(days=monday.weekday())
    iso = monday.isocalendar()
    key = f'{iso.year}-W{iso.week:02d}'
    weeks = json.loads(ARCHIVE.read_text(encoding='utf-8'))['weeks']
    entry = next((w for w in weeks if w['week'] == key), None)
    assert entry is not None, f'归档里没有本期 {key}，请重新跑 scripts/build-weekly-picks.mjs'
    return entry


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class FramepickPicks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(fp.SITE_SERVE_ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:' + str(cls.server.server_port)
        cls.runtime = sync_playwright().start()
        cls.browser = cls.runtime.chromium.launch(channel='chrome', headless=True)
        cls.entry = current_week_entry()
        # 首名在大图上，榜单里就不再列一次：测试口径跟生成器一致。
        cls.films = cls.entry['films']
        cls.hero_id = resolve_hero(cls.films)
        cls.listed = [film for film in cls.films if film['id'] != cls.hero_id]
        # 补选：首名占掉大图后不够五张，生成器从片库补上的那几部（归档里单列）。
        cls.supplement = cls.entry.get('supplement', []) or []
        cls.cards = cls.listed + cls.supplement
        cls.rank_of = {film['id']: index + 1 for index, film in enumerate(cls.films)}
        cls.expected = [film['id'] for film in cls.listed]

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.runtime.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/api/framepick/**', lambda route: route.fulfill(status=503, json={'error': 'Offline'}))

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def open(self):
        self.page.goto(self.base + fp.url())

    def test_picks_match_previous_week_archive_without_rank_data(self):
        self.open()
        expect(self.page.get_by_role('heading', name='本周推荐', exact=True)).to_be_visible()
        links = self.page.locator('#rankings [data-open-film]')
        # 入选的在前面、补选的在末尾：顺序也照归档来，不重排。
        expect(links).to_have_count(len(self.cards))
        self.assertEqual(links.evaluate_all('(nodes)=>nodes.map(n=>n.dataset.openFilm)'),
                         [film['id'] for film in self.cards])
        self.page.evaluate("window.dispatchEvent(new CustomEvent('framepick:review-summary', {detail:{available:false,films:[]}}))")
        expect(links).to_have_count(len(self.cards))
        expect(self.page.locator('#rankings')).to_contain_text('按首发日期排列')

    def test_every_pick_opens_its_details_and_returns_keyboard_focus(self):
        self.open()
        # 补选那几张同样要能打开详情：弹窗按 id 取数，漏了就是死链。
        for film in self.cards:
            fid = film['id']
            trigger = self.page.locator(f'#rankings [data-open-film="{fid}"]')
            trigger.focus()
            self.page.keyboard.press('Enter')
            expect(self.page.locator('#filmDialog')).to_be_visible()
            expect(self.page.locator('#detailTitle')).to_have_text(film['title'])
            expect(self.page.locator('#detailWatch')).to_have_attribute('href', trigger.get_attribute('href'))
            self.page.keyboard.press('Escape')
            expect(trigger).to_be_focused()

    def test_filtering_library_does_not_remove_the_editorial_selection(self):
        # 片库筛选搬到了 library.html：那边筛空也不该影响首页的本周推荐。
        self.page.goto(self.base + fp.url('library.html?q=' + '不存在的片名123'))
        expect(self.page.locator('#libEmpty')).to_be_visible()
        self.open()
        expect(self.page.locator('#rankings [data-open-film]')).to_have_count(len(self.cards))
        if self.expected:
            first = self.listed[0]
            fid = first['id']
            self.page.locator(f'#rankings [data-open-film="{fid}"]').click()
            expect(self.page.locator('#detailTitle')).to_have_text(first['title'])

    def test_hero_and_the_list_never_show_the_same_film_twice(self):
        """首屏大图和本周推荐不能重复：第一名在大图上，榜单从 02 开始。"""
        self.open()
        first = self.page.locator('.hero-slide').first
        hero = first.locator('[data-open-film]').first.get_attribute('data-open-film')
        self.assertEqual(hero, self.hero_id)
        listed = self.page.locator('#rankings .pick-link').evaluate_all('(els) => els.map((el) => el.dataset.openFilm)')
        self.assertEqual(listed, [film['id'] for film in self.cards])
        self.assertNotIn(hero, listed)
        expect(first.locator('.feature-label')).to_contain_text(
            '编辑选片' if (FEATURE_LOCK.exists()) else '本周主推')
        # 轮播里其余几张同样不许出现在榜单上，否则同一部片首屏出现两遍。
        carousel = self.page.locator('.hero-slide [data-open-film]').evaluate_all('(els) => els.map((el) => el.dataset.openFilm)')
        self.assertEqual(carousel[0], hero)
        self.assertEqual(len(carousel), len(set(carousel)), '轮播里出现了重复作品')
        self.assertFalse(set(carousel) & set(listed), '轮播和榜单撞了同一部')
        if self.expected:
            expect(self.page.locator('#rankings')).to_contain_text('见页首')

    def test_hero_carousel_rotates_by_itself_and_can_be_stepped_by_hand(self):
        """首屏轮播：自动换页、左右按钮与圆点都能切；减动效偏好下不自动播。"""
        page = self.browser.new_context(viewport={'width': 1440, 'height': 1000}).new_page()
        self.addCleanup(page.context.close)
        page.route('**/api/framepick/**', lambda route: route.fulfill(status=503, json={'error': 'Offline'}))
        page.goto(self.base + fp.url())
        # 末尾那张是第一张的副本（无限循环用），不算一页。
        slides = page.locator('.hero-slide:not(.is-clone)')
        total = slides.count()
        self.assertGreater(total, 1, '轮播只有一张，等于没有轮播')
        expect(page.locator('.hero-dot')).to_have_count(total)
        expect(page.locator('.hero-slide.is-clone')).to_have_count(1)
        self.assertTrue(page.locator('.hero-slide.is-clone').evaluate('(el) => el.inert'),
                        '副本只能当画面，不许进 Tab 序列')
        track = page.locator('.hero-track')

        def at(index):
            # transform 写成 translate3d(-100%, 0px, 0px)：取括号里第一个百分比比对页码。
            raw = (track.evaluate('(el) => el.style.transform') or '').split('(')[-1]
            numbers = re.findall(r'-?\d+(?:\.\d+)?', raw)
            return bool(numbers) and abs(float(numbers[0]) + index * 100) < 1

        self.assertTrue(at(0))
        page.locator('[data-hero-next]').click()
        expect(slides.nth(1)).to_have_class(re.compile(r'is-active'))
        self.assertTrue(at(1))
        # 离开当前页的那张要从 Tab 序列里退出，键盘不会落到看不见的链接上。
        self.assertTrue(slides.nth(0).evaluate('(el) => el.inert'))
        self.assertFalse(slides.nth(1).evaluate('(el) => el.inert'))
        page.locator('[data-hero-dot="0"]').click()
        expect(slides.nth(0)).to_have_class(re.compile(r'is-active'))
        # 没人碰它的时候自己往下走。
        page.wait_for_timeout(7600)
        expect(slides.nth(1)).to_have_class(re.compile(r'is-active'))

        # 始终朝一个方向：走到最后一张继续往前，接到的是第一张（位置继续往前），
        # 而不是倒着把中间几张滑回来。
        page.locator('[data-hero-dot="0"]').click()
        self.assertTrue(at(0))
        for _ in range(total - 1):
            page.locator('[data-hero-next]').click()
        self.assertTrue(at(total - 1))
        expect(slides.nth(total - 1)).to_have_class(re.compile(r'is-active'))
        page.locator('[data-hero-next]').click()
        self.assertTrue(at(total), '前进到末尾副本时位置只该继续往前')
        page.locator('[data-hero-next]').click()
        self.assertTrue(at(1), '接回第一张之后应该走到第二张')
        expect(slides.nth(1)).to_have_class(re.compile(r'is-active'))
        # 往回退同理：在第一张后退，滑出来的是最后一张，不是倒着穿过整条轨道。
        page.locator('[data-hero-dot="0"]').click()
        page.locator('[data-hero-prev]').click()
        expect(slides.nth(total - 1)).to_have_class(re.compile(r'is-active'))

        calm = self.browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce').new_page()
        self.addCleanup(calm.context.close)
        calm.route('**/api/framepick/**', lambda route: route.fulfill(status=503, json={'error': 'Offline'}))
        calm.goto(self.base + fp.url())
        calm.wait_for_timeout(7600)
        expect(calm.locator('.hero-slide').nth(0)).to_have_class(re.compile(r'is-active'))

    def test_edition_dates_and_ranks_identify_the_current_selection(self):
        self.open()
        start, end = previous_week_window()
        dates = self.page.locator('#rankings .picks-edition-range time')
        expect(dates).to_have_count(2)
        self.assertEqual(dates.evaluate_all('(nodes)=>nodes.map(n=>n.dateTime)'), [start.isoformat(), end.isoformat()])
        ranks = self.page.locator('#rankings .pick-rank')
        expect(ranks).to_have_count(len(self.cards))
        # 补选没有名次：占位符是「＋」，不写 06 这种编出来的位置。
        self.assertEqual(ranks.all_text_contents(),
                         [f'{self.rank_of[fid]:02d}' for fid in self.expected] + ['＋'] * len(self.supplement))
        # 名次与时长是文字行里的小字，不许再压在封面上。
        for width in [320, 390, 1440]:
            self.page.set_viewport_size({'width': width, 'height': 1000})
            layout = self.page.evaluate("""() => [...document.querySelectorAll('#rankings .pick-card')].map((card) => {
                const cover = card.querySelector('.pick-cover').getBoundingClientRect();
                const meta = card.querySelector('.pick-meta').getBoundingClientRect();
                const img = card.querySelector('.pick-cover img');
                return {coverBottom: Math.round(cover.bottom), metaTop: Math.round(meta.top),
                        overlapsImage: !!(img && img.getBoundingClientRect().height && cover.height === 0)}; })""")
            self.assertTrue(all(item['metaTop'] >= item['coverBottom'] for item in layout), layout)
        self.assertEqual(self.page.evaluate("""() => [...document.querySelectorAll('#rankings .pick-cover')]
            .map((cover) => cover.children.length)"""), [1] * len(self.cards), '封面里只该有图片，不许有任何浮层')
        self.assertIn('上一周首发', self.page.locator('#rankings').inner_text())
        self.assertNotIn('第一次', self.page.locator('#rankings').inner_text())

    def test_the_week_always_lists_at_least_five_cards(self):
        """标题下至少五张卡：入选不足时从片库补，补的那几张必须自报家门。"""
        self.open()
        start, end = previous_week_window()
        cards = self.page.locator('#rankings .pick-card')
        expect(cards).to_have_count(len(self.cards))
        self.assertGreaterEqual(cards.count(), 5, '本周推荐又只剩几张了')
        # 入选的几张不许被标成补选。
        self.assertEqual(self.page.locator('#rankings .pick-card.is-bonus').count(), len(self.supplement))
        self.assertEqual(self.page.locator('#rankings .pick-card:not(.is-bonus) .pick-link')
                         .evaluate_all('(els) => els.map((el) => el.dataset.openFilm)'), self.expected)
        if self.supplement:
            blurred = self.page.locator('#rankings .pick-card.is-bonus')
            for index in range(blurred.count()):
                card = blurred.nth(index)
                expect(card.locator('.pick-bonus')).to_have_text('补选')
                # 补选的日期必须早于本期窗口：写在窗口里的日期就是假话。
                value = card.locator('.pick-release time').get_attribute('datetime')
                self.assertLess(value, start.isoformat(), f'补选《{self.supplement[index]["title"]}》的日期落在窗口内')
                self.assertNotIn(card.locator('.pick-link').get_attribute('data-open-film'), self.expected)
            self.assertIn('补选自片库', self.page.locator('#rankings .picks-note').inner_text())
        else:
            # 没补选说明入选本来就够五张，此时不该冒出「补选」字样。
            self.assertNotIn('补选', self.page.locator('#rankings').inner_text())

    def test_every_card_states_its_release_date_inside_the_week_window(self):
        self.open()
        start, end = previous_week_window()
        stamps = self.page.locator('#rankings .pick-release time')
        expect(stamps).to_have_count(len(self.cards))
        values = stamps.evaluate_all('(nodes)=>nodes.map(n=>n.dateTime)')
        self.assertEqual(values, [film['releaseDate'] for film in self.cards])
        # 窗口只约束这一期入选的作品；补选本来就在窗口之前，标着「补选」。
        picked = values[:len(self.listed)]
        for value in picked:
            self.assertTrue(start.isoformat() <= value <= end.isoformat(), f'{value} 不在上一周窗口内')
        # 新片在前、旧片在后，不冒充累计热度排名。
        self.assertEqual(picked, sorted(picked, reverse=True))

    def test_mobile_and_desktop_have_readable_cards_without_horizontal_overflow(self):
        for width in [320, 390, 768, 1440]:
            self.page.set_viewport_size({'width': width, 'height': 960})
            self.open()
            expect(self.page.locator('#rankings .pick-card')).to_have_count(len(self.cards))
            self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width)
            boxes = self.page.locator('#rankings .pick-card').evaluate_all('(nodes)=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,w:r.width}})')
            self.assertTrue(all(b['x'] >= 0 and b['x'] + b['w'] <= width + 1 for b in boxes), boxes)

    def test_without_javascript_original_links_and_library_remain_available(self):
        context = self.browser.new_context(java_script_enabled=False)
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(self.base + fp.url())
        links = page.locator('#rankings [data-open-film]')
        expect(links).to_have_count(len(self.cards))
        for link in links.all():
            expect(link).to_be_visible()
            self.assertTrue(link.get_attribute('href').startswith('https://'))
            expect(link.locator('img')).to_have_attribute('alt', re.compile(r'.+'))
        expect(page.locator('#rankings .rankings-browse')).to_have_attribute('href', '#entries')
        expect(page.locator('#filmGrid')).to_be_visible()
        # 没有脚本时轮播就停在第一张，控件不出现（按钮点了也不会动，不如不给）。
        expect(page.locator('.hero-slide').first).to_be_visible()
        expect(page.locator('.hero-controls')).to_be_hidden()

    def test_detail_preserves_original_release_date_precision(self):
        # 首页只铺最近收录，具体某部片不一定在栅格里：用分享链接打开，验证日期精度。
        for fid, date in [('pinzi', '2026.02.03'), ('yanran', '2026.08')]:
            self.page.goto(self.base + fp.url('?film=' + fid))
            expect(self.page.locator('#detailPublished')).to_have_text('原片发布于 ' + date)
            self.page.keyboard.press('Escape')


if __name__ == '__main__':
    unittest.main(verbosity=2)

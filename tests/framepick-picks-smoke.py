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
        cls.expected = [film['id'] for film in cls.entry['films']]

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
        expect(links).to_have_count(len(self.expected))
        self.assertEqual(links.evaluate_all('(nodes)=>nodes.map(n=>n.dataset.openFilm)'), self.expected)
        self.page.evaluate("window.dispatchEvent(new CustomEvent('framepick:review-summary', {detail:{available:false,films:[]}}))")
        expect(links).to_have_count(len(self.expected))
        expect(self.page.locator('#rankings')).to_contain_text('按首发日期排列')

    def test_every_pick_opens_its_details_and_returns_keyboard_focus(self):
        self.open()
        for film in self.entry['films']:
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
        self.open()
        self.page.locator('#filmSearch').fill('不存在的片名123')
        expect(self.page.locator('#emptyState')).to_be_visible()
        expect(self.page.locator('#rankings [data-open-film]')).to_have_count(len(self.expected))
        if self.expected:
            first = self.entry['films'][0]
            fid = first['id']
            self.page.locator(f'#rankings [data-open-film="{fid}"]').click()
            expect(self.page.locator('#detailTitle')).to_have_text(first['title'])

    def test_edition_dates_and_ranks_identify_the_current_selection(self):
        self.open()
        start, end = previous_week_window()
        dates = self.page.locator('#rankings .picks-edition-range time')
        expect(dates).to_have_count(2)
        self.assertEqual(dates.evaluate_all('(nodes)=>nodes.map(n=>n.dateTime)'), [start.isoformat(), end.isoformat()])
        ranks = self.page.locator('#rankings .pick-rank')
        expect(ranks).to_have_count(len(self.expected))
        self.assertEqual(ranks.all_text_contents(), [f'{i + 1:02d}' for i in range(len(self.expected))])
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
            .map((cover) => cover.children.length)"""), [1] * len(self.expected), '封面里只该有图片，不许有任何浮层')
        self.assertIn('上一周首发', self.page.locator('#rankings').inner_text())
        self.assertNotIn('第一次', self.page.locator('#rankings').inner_text())

    def test_every_card_states_its_release_date_inside_the_week_window(self):
        self.open()
        start, end = previous_week_window()
        stamps = self.page.locator('#rankings .pick-release time')
        expect(stamps).to_have_count(len(self.expected))
        values = stamps.evaluate_all('(nodes)=>nodes.map(n=>n.dateTime)')
        self.assertEqual(values, [film['releaseDate'] for film in self.entry['films']])
        for value in values:
            self.assertTrue(start.isoformat() <= value <= end.isoformat(), f'{value} 不在上一周窗口内')
        # 新片在前、旧片在后，不冒充累计热度排名。
        self.assertEqual(values, sorted(values, reverse=True))

    def test_mobile_and_desktop_have_readable_cards_without_horizontal_overflow(self):
        for width in [320, 390, 768, 1440]:
            self.page.set_viewport_size({'width': width, 'height': 960})
            self.open()
            expect(self.page.locator('#rankings .pick-card')).to_have_count(len(self.expected))
            self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width)
            boxes = self.page.locator('#rankings .pick-card').evaluate_all('(nodes)=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,w:r.width}})')
            self.assertTrue(all(b['x'] >= 0 and b['x'] + b['w'] <= width + 1 for b in boxes), boxes)

    def test_without_javascript_original_links_and_library_remain_available(self):
        context = self.browser.new_context(java_script_enabled=False)
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(self.base + fp.url())
        links = page.locator('#rankings [data-open-film]')
        expect(links).to_have_count(len(self.expected))
        for link in links.all():
            expect(link).to_be_visible()
            self.assertTrue(link.get_attribute('href').startswith('https://'))
            expect(link.locator('img')).to_have_attribute('alt', re.compile(r'.+'))
        expect(page.locator('#rankings .rankings-browse')).to_have_attribute('href', '#entries')
        expect(page.locator('#filmGrid')).to_be_visible()

    def test_detail_preserves_original_release_date_precision(self):
        self.open()
        for fid, date in [('pinzi', '2026.02.03'), ('yanran', '2026.08')]:
            self.page.locator(f'#filmGrid [data-film="{fid}"] .details-button').click()
            expect(self.page.locator('#detailPublished')).to_have_text('原片发布于 ' + date)
            self.page.keyboard.press('Escape')


if __name__ == '__main__':
    unittest.main(verbosity=2)

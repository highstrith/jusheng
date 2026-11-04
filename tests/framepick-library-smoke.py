"""Real browser paths for the public Framepick catalogue (no mock membership)."""
import os
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import framepick_layout as fp  # noqa: E402

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('STUDIO_BASE_URL', 'http://127.0.0.1:3000').rstrip('/')
SITE_MODE = re.search(r"FRAMEPICK_SITE_MODE\s*=\s*'([a-z]+)'",
                      (fp.SITE_ROOT / 'site-mode.js').read_text()).group(1)


class FramepickLibrary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = sync_playwright().start()
        cls.browser = cls.runtime.chromium.launch(channel='chrome', headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.runtime.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def open(self, query=''):
        # 默认展开全部，断言全量时才不会被首页分页挡住。
        sep = '&' if '?' in query else '?'
        self.page.goto(BASE + fp.url(f'{query}{sep}perPage=all'), wait_until='load')

    def open_paged(self, query=''):
        self.page.goto(BASE + fp.url(query), wait_until='load')

    def cards(self):
        return self.page.locator('#filmGrid [data-film]:visible')

    def grid_count(self, attr, value):
        # 片库会持续增补（机器放行的批次也在进），断言一律从页面数据算，不写死。
        return self.page.locator(f'#filmGrid [data-film][data-{attr}="{value}"]').count()

    def test_search_category_and_source(self):
        self.open()
        total = self.cards().count()
        self.assertGreaterEqual(total, 3)
        self.page.locator('#filmSearch').fill('Mx-Shell')
        expect(self.cards()).to_have_count(1)
        expect(self.cards()).to_contain_text('烬海棠')
        self.page.locator('#filmSearch').fill('')
        # 题材计数不写死：片库增补后同题材可能不止一部（燕然、西游拾遗录都是仙侠）。
        xianxia = self.page.locator('#filmGrid [data-film]').evaluate_all(
            "els => els.filter(e => e.dataset.genres.split(' ').includes('xianxia')).length")
        self.page.locator('#genreFilter').select_option('xianxia')
        expect(self.cards()).to_have_count(xianxia)
        expect(self.page.locator('#filmGrid [data-film="yanran"]')).to_be_visible()
        self.page.locator('#genreFilter').select_option('all')
        expect(self.cards()).to_have_count(total)
        self.page.locator('#sourceFilter').select_option('bilibili')
        expect(self.cards()).to_have_count(self.grid_count('source', 'bilibili'))
        self.page.locator('#sourceFilter').select_option('douyin')
        expect(self.cards()).to_have_count(self.grid_count('source', 'douyin'))
        self.page.locator('#sourceFilter').select_option('all')
        expect(self.cards()).to_have_count(total)
        self.page.locator('button[data-category="series"]').click()
        expect(self.cards()).to_have_count(self.grid_count('category', 'series'))
        self.page.locator('button[data-category="short"]').click()
        expect(self.cards()).to_have_count(self.grid_count('category', 'short'))
        self.page.locator('button[data-category="all"]').click()
        expect(self.cards()).to_have_count(total)

    def test_home_stays_one_screen_and_links_to_the_full_library(self):
        # 作品会持续增长，首页只铺一屏，完整列表去 library.html，否则上千部时页面长到无法浏览。
        self.open_paged()
        total = self.page.locator('#filmGrid [data-film]').count()
        self.assertEqual(self.cards().count(), 12, '首屏只铺 12 部')
        expect(self.page.locator('#resultCount')).to_contain_text('显示前 12 部')
        expect(self.page.locator('#loadMore')).to_be_visible()
        link = self.page.locator('#loadMoreLink')
        expect(link).to_have_attribute('href', 'library.html')
        expect(link).to_contain_text(f'查看全部 {total} 部')

        link.click()
        self.page.wait_for_load_state('load')
        self.assertTrue(self.page.url.endswith('/library.html'), self.page.url)
        expect(self.page.locator('#libTitle')).to_contain_text('全部作品')
        expect(self.page.locator('#libMeta')).to_contain_text(f'共 {total} 部')
        expect(self.page.locator('#libCount')).to_contain_text(f'共 {total} 部')
        first_page = self.page.locator('#libGrid .card').count()
        self.assertLessEqual(first_page, 24, '片库页每页 24 部')
        if total > 24:
            self.page.get_by_role('button', name='2', exact=True).click()
            self.assertGreater(self.page.locator('#libGrid .card').count(), 0)
            expect(self.page.locator('#libCount')).to_contain_text('第 2 / ')
        # 筛选后页码回到第一页，避免停在越界页。
        self.page.locator('#libGenre').select_option('scifi')
        expect(self.page.locator('#libCount')).to_contain_text('第 1')

    def test_home_search_shows_all_matches_without_paging(self):
        # 搜索是明确意图，搜到了却因分页看不到是坏体验。
        self.open_paged()
        self.page.locator('#filmSearch').fill('科幻')
        matched = self.cards().count()
        self.assertGreater(matched, 12)
        expect(self.page.locator('#loadMore')).to_be_hidden()

    def test_unknown_scores_and_paid_screenings_are_honest_empty_states(self):
        self.open()
        scores = self.page.locator('#filmGrid .score')
        self.assertTrue(scores.evaluate_all("els => els.length > 0 && els.every(e => e.textContent.trim() === '待评')"),
                        'every published film without an editor score must show 待评')
        self.page.locator('#scoreFilter').select_option('8')
        expect(self.cards()).to_have_count(0)
        expect(self.page.locator('#emptyState')).to_contain_text('评分')
        self.page.locator('#resetFilters').click()
        if SITE_MODE == 'ranking':
            # 编选形态不提供付费放映：选项、会员区块与购票入口都应消失。
            self.assertEqual(self.page.locator('#accessFilter option[value="paid"]').count(), 0)
            expect(self.page.locator('#accessFilter')).to_have_value('all')
            expect(self.page.locator('#membership')).to_be_hidden()
            expect(self.page.locator('[data-membership]').first).to_be_hidden()
            return
        self.page.locator('#accessFilter').select_option('paid')
        expect(self.cards()).to_have_count(0)
        expect(self.page.locator('#emptyState')).to_contain_text('付费放映')
        self.page.locator('[data-membership]').first.click()
        expect(self.page.locator('#membershipDialog')).to_be_visible()
        expect(self.page.locator('#membershipDialog')).to_contain_text('尚未开放购票')
        # No fake checkout anywhere; the sign-in password field is not a payment field,
        # so the password check stays scoped to what the purchase dialog offers.
        self.assertEqual(self.page.locator('#membershipDialog input[type="password"], input[name="card"], [data-vip-toggle]').count(), 0)
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#membershipDialog')).not_to_be_visible()

    def test_site_mode_matches_configured_form(self):
        self.open()
        if SITE_MODE == 'ranking':
            # 编选形态：影院、购票与账号入口整体隐藏，只留编选与片库。
            expect(self.page.locator('.intro-note')).to_contain_text('AI 短片编选')
            for selector in ('#membership', '#cinema', '#cinemaPlan', '#prototypeBar', '#accountEntry', '#meEntry'):
                expect(self.page.locator(selector)).to_be_hidden()
            nav = self.page.locator('nav[aria-label="站内导航"]')
            expect(nav.get_by_role('link', name='本期推荐', exact=True)).to_have_attribute('href', '#rankings')
            expect(nav).not_to_contain_text('观影计划')
            expect(self.page.locator('body')).not_to_contain_text('买一张小票', use_inner_text=True)
            expect(self.page.locator('body')).not_to_contain_text('橘生梦厂 VIP', use_inner_text=True)
            return
        expect(self.page.locator('.intro-note')).to_contain_text('AI 电影线上影院')
        expect(self.page.locator('#membership')).to_contain_text('单片观影')
        expect(self.page.locator('#membership')).to_contain_text('3 元 / 5 元')
        expect(self.page.locator('#cinemaPlan')).to_contain_text('完整故事与视听完成度')
        expect(self.page.locator('#cinemaPlan')).to_contain_text('每笔有效订单')
        expect(self.page.locator('#cinemaPlan')).to_contain_text('创作者工作台尚未开放')
        expect(self.page.get_by_role('link', name='交流作品合作')).to_have_attribute('href', re.compile('^mailto:'))
        expect(self.page.locator('body')).not_to_contain_text('橘生梦厂 VIP')
        self.page.get_by_role('button', name='了解单片观影计划').click()
        expect(self.page.locator('#membershipDialog')).to_contain_text('观看期限')
        expect(self.page.locator('#membershipDialog')).to_contain_text('尚未开放购票')
        self.page.keyboard.press('Escape')
        self.open('?access=vip')
        expect(self.page.locator('#accessFilter')).to_have_value('paid')
        expect(self.cards()).to_have_count(0)
        expect(self.page.locator('#emptyState')).to_contain_text('付费放映')

    def test_rating_sort_is_numeric_and_unrated_stays_last(self):
        source = (fp.SITE_ROOT / 'index.html').read_text()
        for film_id, score in [('xianggu', '8.6'), ('jinhaitang', '10'), ('yanran', '')]:
            source, n = re.subn(r'(<article\b[^>]*data-film="' + film_id + r'"[^>]*data-score=")[^"]*(")',
                                lambda m: m[1] + score + m[2], source)
            self.assertEqual(n, 1, film_id)
        self.page.route(fp.is_index, lambda route: route.fulfill(body=source, content_type='text/html'))
        self.open()
        # 无评分的片子会随批次增长，从页面数据算，不写死名单。
        unrated = set(self.page.locator('#filmGrid [data-film]').evaluate_all(
            "els => els.filter(e => !e.dataset.score).map(e => e.dataset.film)"))
        self.page.locator('#sortFilter').select_option('score')
        order = self.cards().evaluate_all('cards=>cards.map(c=>c.dataset.film)')
        self.assertEqual(order[:2], ['jinhaitang', 'xianggu'])
        self.assertEqual(set(order[2:]), unrated)
        self.page.locator('#scoreFilter').select_option('9')
        expect(self.cards()).to_have_count(1)
        expect(self.cards()).to_contain_text('烬海棠')

    def test_url_refresh_back_and_detail_focus(self):
        self.open('?q=燕然&source=douyin')
        expect(self.cards()).to_have_count(1)
        self.page.reload()
        expect(self.page.locator('#filmSearch')).to_have_value('燕然')
        opener = self.page.locator('button[data-open-film="yanran"]')
        opener.click()
        expect(self.page.locator('#filmDialog')).to_be_visible()
        expect(self.page.locator('#detailTitle')).to_have_text('燕然')
        expect(self.page.locator('#detailWatch')).to_have_attribute('href', 'https://www.douyin.com/video/7675665548755176758')
        self.assertIn('film=yanran', self.page.url)
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#filmDialog')).not_to_be_visible()
        expect(opener).to_be_focused()
        self.page.go_forward()
        expect(self.page.locator('#filmDialog')).to_be_visible()
        self.page.go_back()
        expect(self.page.locator('#filmDialog')).not_to_be_visible()

    def test_deep_link_and_unknown_values_are_safe(self):
        self.open('?film=xianggu&source=bogus&rating=nope')
        expect(self.page.locator('#filmDialog')).to_be_visible()
        expect(self.page.locator('#detailTitle')).to_have_text('相骨')
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#filmDialog')).not_to_be_visible()
        self.assertGreaterEqual(self.cards().count(), 3)
        self.page.locator('#filmSearch').fill('<img src=x onerror=alert(1)>')
        expect(self.cards()).to_have_count(0)
        expect(self.page.locator('#emptyState img')).to_have_count(0)

    def test_detail_follows_the_real_source_platform(self):
        # The watch button must name the platform the author published on, never a default.
        self.open('?film=pinzi')
        expect(self.page.locator('#detailTitle')).to_have_text('牌子')
        expect(self.page.locator('#detailWatch')).to_contain_text('前往哔哩哔哩观看')
        expect(self.page.locator('#detailAuthor')).to_contain_text('DiDi_OK')
        expect(self.page.locator('#detailAuthor')).to_contain_text('哔哩哔哩')
        expect(self.page.locator('#detailKind')).to_contain_text('剧情短片')
        expect(self.page.locator('#detailWatch')).to_have_attribute('href', 'https://www.bilibili.com/video/BV11mFLziEyP/')
        self.page.keyboard.press('Escape')
        self.open('?film=xianggu')
        expect(self.page.locator('#detailWatch')).to_contain_text('前往抖音观看')
        expect(self.page.locator('#detailAuthor')).to_contain_text('抖音')
        expect(self.page.locator('#detailKind')).to_contain_text('系列短剧')
        self.page.keyboard.press('Escape')
        self.open('?film=baiguilu')
        expect(self.page.locator('#detailWatch')).to_contain_text('前往哔哩哔哩观看')
        expect(self.page.locator('#detailEpisode')).to_contain_text('狐仙接亲')

    def test_bookmarks_persist_and_storage_failure_is_nonfatal(self):
        self.open()
        save = self.page.locator('[data-save-film="jinhaitang"]').first
        save.click()
        expect(save).to_have_attribute('aria-pressed', 'true')
        self.page.reload()
        expect(self.page.locator('[data-save-film="jinhaitang"]').first).to_have_attribute('aria-pressed', 'true')
        self.page.locator('#savedToggle').click()
        expect(self.cards()).to_have_count(1)
        self.page.locator('[data-save-film="jinhaitang"]').first.click()
        expect(self.cards()).to_have_count(0)
        expect(self.page.locator('#emptyState')).to_contain_text('收藏')
        blocked = self.browser.new_context()
        self.addCleanup(blocked.close)
        blocked.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError')}})")
        page = blocked.new_page()
        page.goto(BASE + fp.url())
        page.locator('[data-save-film="xianggu"]').first.click()
        expect(page.locator('#notice')).to_contain_text('本次浏览')
        page.locator('#savedToggle').click()
        expect(page.locator('#filmGrid [data-film]:visible')).to_have_count(1)

    def test_responsive_nojs_and_file_mode(self):
        self.open()
        for width in [320, 390, 820, 1440, 1920]:
            self.page.set_viewport_size({'width': width, 'height': 900})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
            self.page.locator('button[data-open-film="xianggu"]').click()
            expect(self.page.locator('#filmDialog')).to_be_visible()
            self.assertLessEqual(self.page.locator('#filmDialog').bounding_box()['width'], width)
            self.page.keyboard.press('Escape')
        context = self.browser.new_context(java_script_enabled=False, viewport={'width': 320, 'height': 844})
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(BASE + fp.url())
        total = self.page.locator('#filmGrid [data-film]').count()
        expect(page.locator('#filmGrid [data-film]')).to_have_count(total)
        expect(page.locator('#filmGrid .watch')).to_have_count(total)
        expect(page.locator('#filmSearch')).not_to_be_visible()
        expect(page.get_by_role('link', name='橘小桔的主页')).to_be_visible()
        self.page.goto((fp.SITE_ROOT / 'index.html').as_uri())
        self.page.locator('#filmSearch').fill('相骨')
        expect(self.cards()).to_have_count(1)

    def test_keyboard_bookmark_focus_survives_saving_and_removing(self):
        self.open()
        save = self.page.locator('button[data-save-film="jinhaitang"]').first
        save.focus()
        self.page.keyboard.press('Enter')
        expect(save).to_have_attribute('aria-pressed', 'true')
        expect(save).to_be_focused()
        self.page.locator('#savedToggle').click()
        save.focus()
        self.page.keyboard.press('Enter')
        expect(self.cards()).to_have_count(0)
        expect(self.page.locator('#resetFilters')).to_be_focused()

    def test_mobile_controls_keep_accessible_names(self):
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.open()
        expect(self.page.locator('#savedToggle')).to_have_accessible_name(re.compile('我的收藏'))
        expect(self.page.locator('#sortFilter')).to_have_accessible_name('排序')

    def test_completion_state_is_on_every_card_and_in_the_detail(self):
        self.open()
        # 每张卡都要有连载状态，值必须合法；标签数与有状态的卡片数必须一致（不能标了值却不显示）。
        states = self.page.locator('#filmGrid [data-film]').evaluate_all(
            "els => els.map(e => e.dataset.completion || '')")
        self.assertTrue(all(state in ('standalone', 'ongoing', 'completed') for state in states), states)
        tagged = self.page.locator('#filmGrid [data-film] .status-tag').count()
        self.assertEqual(tagged, len([state for state in states if state]))
        # 至少要有两种状态，否则说明标注没生效。
        self.assertGreaterEqual(len({state for state in states if state}), 2)

        ongoing = self.page.locator('#filmGrid [data-film][data-completion="ongoing"]').first
        ongoing.locator('button[data-open-film]').click()
        expect(self.page.locator('#filmDialog')).to_be_visible()
        expect(self.page.locator('#detailStatus')).to_be_visible()
        expect(self.page.locator('#detailStatus')).to_contain_text('连载中')
        self.page.keyboard.press('Escape')

        single = self.page.locator('#filmGrid [data-film][data-completion="standalone"]').first
        single.locator('button[data-open-film]').click()
        expect(self.page.locator('#detailStatus')).to_contain_text('单部')

    def assert_detail_cover_uncropped(self):
        """详情封面必须完整显示：显示框宽高比 ≈ 图片原始宽高比（裁剪就会不相等）。"""
        img = self.page.locator('#detailImage')
        expect(self.page.locator('#filmDialog')).to_be_visible()
        self.page.evaluate("() => document.querySelector('#detailImage').decode().catch(() => {})")
        box = img.evaluate(
            "i => ({nw: i.naturalWidth, nh: i.naturalHeight, w: i.clientWidth, h: i.clientHeight})")
        self.assertGreater(box['nw'], 0, box)
        self.assertGreater(box['h'], 0, box)
        self.assertAlmostEqual(box['w'] / box['h'], box['nw'] / box['nh'], delta=0.03, msg=box)

    def test_detail_cover_shows_the_full_image_and_prefers_the_large_source(self):
        # 有 1280w 大图的作品（B 站高清原图），详情图要换大图，缩略图放大必糊。
        self.open('?film=pinzi')
        expect(self.page.locator('#detailImage')).to_have_attribute('src', re.compile(r'-1280w\.webp'))
        self.assert_detail_cover_uncropped()
        # 没有大图的作品（抖音原图仅 440×330，放大无益）回退 640w 缩略图，同样不能裁剪。
        self.page.keyboard.press('Escape')
        self.open('?film=xianggu')
        expect(self.page.locator('#detailImage')).to_have_attribute('src', re.compile(r'-640w\.webp'))
        self.assert_detail_cover_uncropped()
        # 手机窄栏以前被强制 16:9 裁剪，4:3 封面砍得最狠；窄屏同样要完整。
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.keyboard.press('Escape')
        self.open('?film=pinzi')
        self.assert_detail_cover_uncropped()


if __name__ == '__main__':
    unittest.main()

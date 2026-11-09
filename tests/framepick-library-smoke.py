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

    def grid_id(self, index=0):
        """首页只铺最近收录，具体是哪几部由数据决定；需要「页面上存在的片」时问页面要。"""
        return self.page.locator('#filmGrid [data-film]').nth(index).get_attribute('data-film')

    def cards(self):
        return self.page.locator('#filmGrid [data-film]:visible')

    def grid_count(self, attr, value):
        # 片库会持续增补（机器放行的批次也在进），断言一律从页面数据算，不写死。
        return self.page.locator(f'#filmGrid [data-film][data-{attr}="{value}"]').count()

    def test_search_category_and_source(self):
        # 搜索与筛选在 library.html：首页只铺编辑精选，完整片库在那边按题材／来源／类型筛。
        self.page.goto(BASE + fp.url('library.html'), wait_until='load')
        cards = self.page.locator('#libGrid .card')
        self.assertGreaterEqual(cards.count(), 3)
        self.page.locator('#libSearch').fill('Mx-Shell')
        expect(cards).to_have_count(1)
        expect(cards).to_contain_text('烬海棠')
        self.page.locator('#libSearch').fill('')
        # 题材用例不写死数量：片库增补后同题材可能不止一部（燕然、西游拾遗录都是仙侠）。
        self.page.locator('#libGenre').select_option('xianxia')
        expect(self.page.locator('#libGrid .card', has_text='燕然')).to_have_count(1)
        genres = self.page.locator('#libGrid .card').evaluate_all(
            "els => els.length")
        self.assertGreaterEqual(genres, 1)
        self.page.locator('#libGenre').select_option('all')
        self.page.locator('#libSource').select_option('bilibili')
        hrefs = self.page.locator('#libGrid .watch').evaluate_all('els => els.map(e => e.href)')
        self.assertTrue(hrefs and all('bilibili.com' in href for href in hrefs), hrefs)
        self.page.locator('#libSource').select_option('all')
        self.page.locator('#libTabs button[data-category="series"]').click()
        expect(self.page.locator('#libTabs button[data-category="series"]')).to_have_attribute('aria-pressed', 'true')
        expect(self.page.locator('#libCount')).to_contain_text('共')
        self.page.locator('#libTabs button[data-category="all"]').click()
        expect(self.page.locator('#libCount')).to_contain_text('第 1–')

    def test_home_stays_one_screen_and_links_to_the_full_library(self):
        # 首页只铺编辑精选这一屏，作品涨到几百部也不会把首页撑长；完整片库在 library.html。
        self.open_paged()
        total = int(self.page.locator('#filmGrid').get_attribute('data-total'))
        self.assertEqual(self.cards().count(), 9, '首页只铺最近收录 9 部')
        expect(self.page.locator('#filmPager')).to_be_hidden()
        expect(self.page.locator('#resultCount')).to_contain_text(f'共 {total} 部 · 首页收录 9 部')
        expect(self.page.locator('[data-film-total]').first).to_have_text(str(total))
        expect(self.page.locator('#loadMore')).to_be_visible()
        link = self.page.locator('#loadMoreLink')
        expect(link).to_have_attribute('href', 'library.html')
        expect(link).to_contain_text(f'去片库看全部 {total} 部')

        self.page.goto(BASE + fp.url('library.html'), wait_until='load')
        expect(self.page.locator('#libTitle')).to_contain_text('全部作品')
        expect(self.page.locator('#libMeta')).to_contain_text(f'共 {total} 部')
        expect(self.page.locator('#libCount')).to_contain_text(f'共 {total} 部')
        self.assertLessEqual(self.page.locator('#libGrid .card').count(), 12, '片库页每页不超过 12 部')
        if total > 12:
            expect(self.page.locator('#libPagerTop')).to_be_visible()
            self.page.locator('#libPagerTop button', has_text='2').first.click()
            expect(self.page.locator('#libCount')).to_contain_text('第 2 / ')
        # 筛选后页码回到第一页，避免停在越界页。
        self.page.locator('#libGenre').select_option('scifi')
        expect(self.page.locator('#libCount')).to_contain_text('第 1–')

    def test_per_page_choice_keeps_the_list_and_the_pager_honest(self):
        # 每页显示多少部由读者自己定：换了就回第一页，页码和「第几到第几部」一起重算。
        self.page.goto(BASE + fp.url('library.html'), wait_until='load')
        cards = self.page.locator('#libGrid .card')
        total = int(re.search(r'共 (\d+) 部', self.page.locator('#libMeta').inner_text()).group(1))
        self.assertIn(cards.count(), (6, 12), '默认每页数量跟着屏幕走')
        self.page.locator('#libPer').select_option('24')
        expect(cards).to_have_count(24)
        expect(self.page.locator('#libCount')).to_contain_text('第 1–24 部')
        # 翻到第 2 页再改每页数量，必须回到第一页，不能停在越界页上看空。
        self.page.locator('#libPager button', has_text='2').first.click()
        expect(self.page.locator('#libCount')).to_contain_text('第 25–48 部')
        self.page.locator('#libPer').select_option('12')
        expect(cards).to_have_count(12)
        expect(self.page.locator('#libCount')).to_contain_text('第 1–12 部')
        # 「全部」一页铺完，上下两条翻页条都收起来。
        self.page.locator('#libPer').select_option('all')
        self.assertEqual(cards.count(), total)
        expect(self.page.locator('#libPager')).to_be_empty()
        expect(self.page.locator('#libPagerTop')).to_be_empty()
        expect(self.page.locator('#libCount')).to_contain_text(f'第 1–{total} 部，共 {total} 部')

    def test_per_page_accepts_any_number_by_hand(self):
        # 预设之外还能自己填：越界夹到 1–200，填不出数就退回原来的值，换回预设就收起输入框。
        self.page.goto(BASE + fp.url('library.html'), wait_until='load')
        cards = self.page.locator('#libGrid .card')
        custom = self.page.locator('#libPerCustom')
        expect(custom).to_be_hidden()
        self.page.locator('#libPer').select_option('custom')
        expect(custom).to_be_visible()
        custom.fill('30')
        custom.press('Enter')
        expect(cards).to_have_count(30)
        expect(self.page.locator('#libCount')).to_contain_text('第 1–30 部')
        custom.fill('999')
        custom.press('Enter')
        expect(custom).to_have_value('200')
        custom.fill('')
        custom.press('Enter')
        expect(custom).to_have_value('200')
        self.page.locator('#libPer').select_option('12')
        expect(custom).to_be_hidden()
        expect(cards).to_have_count(12)

    def test_per_page_choice_travels_in_the_url(self):
        # 每页数量认地址参数：分享出去的链接打开就是同一个视图，坏值退回自动。
        self.page.goto(BASE + fp.url('library.html?per=24'), wait_until='load')
        expect(self.page.locator('#libPer')).to_have_value('24')
        expect(self.page.locator('#libGrid .card')).to_have_count(24)
        # 预设之外的数字当成自定义：?per=30 打开就是自定义 30 部。
        self.page.goto(BASE + fp.url('library.html?per=30'), wait_until='load')
        expect(self.page.locator('#libPer')).to_have_value('custom')
        expect(self.page.locator('#libPerCustom')).to_have_value('30')
        expect(self.page.locator('#libGrid .card')).to_have_count(30)
        self.page.goto(BASE + fp.url('library.html?per=bogus'), wait_until='load')
        expect(self.page.locator('#libPer')).to_have_value('auto')
        self.assertIn(self.page.locator('#libGrid .card').count(), (6, 12))

    def test_home_search_hands_off_to_the_library(self):
        # 首页不再自带片库搜索，但搜索这一下不能丢：输入后直接落到片库的搜索结果。
        self.open_paged()
        expect(self.page.locator('form.home-search')).to_have_attribute('action', 'library.html')
        expect(self.page.locator('#homeSearch')).to_be_visible()
        self.page.locator('#homeSearch').fill('相骨')
        self.page.locator('#homeSearch').press('Enter')
        self.page.wait_for_url(re.compile(r'library\.html\?q='), wait_until='load')
        expect(self.page.locator('#libSearch')).to_have_value('相骨')
        expect(self.page.locator('#libGrid .card')).to_have_count(1)
        expect(self.page.locator('#libGrid')).to_contain_text('相骨')

    def test_unknown_scores_and_paid_screenings_are_honest_empty_states(self):
        self.open()
        scores = self.page.locator('#filmGrid .score')
        self.assertTrue(scores.evaluate_all("els => els.length > 0 && els.every(e => e.textContent.trim() === '待评')"),
                        'every published film without an editor score must show 待评')
        # 评分筛选随筛选控件一起收进 library.html；首页仍认地址里的同名条件。
        self.open('?rating=8')
        expect(self.cards()).to_have_count(0)
        expect(self.page.locator('#emptyState')).to_contain_text('评分')
        if SITE_MODE == 'ranking':
            # 编选形态不提供付费放映：选项、会员区块与购票入口都应消失。
            self.open()
            self.assertEqual(self.page.locator('#accessFilter option[value="paid"]').count(), 0)
            expect(self.page.locator('#accessFilter')).to_have_value('all')
            expect(self.page.locator('#membership')).to_be_hidden()
            expect(self.page.locator('[data-membership]').first).to_be_hidden()
            return
        self.open('?access=paid')
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
            # 编选形态：影院与购票整体隐藏，只留编选、片库与「我的」（观看记录）。
            expect(self.page.locator('.intro-note')).to_contain_text('AI 短片编选')
            for selector in ('#membership', '#cinema', '#cinemaPlan', '#prototypeBar'):
                expect(self.page.locator(selector)).to_be_hidden()
            # 账号入口按「是否配置了账号服务」决定：本地预览与主站都配了（见 review-config.js），
            # 编选形态下照样露出来，否则登录与观看记录同步就没有入口。未配置时才隐藏。
            account_api = self.page.evaluate("() => String(window.FRAMEPICK_ACCOUNT_API || '').trim()")
            if account_api:
                expect(self.page.locator('#accountEntry')).to_be_visible()
            else:
                expect(self.page.locator('#accountEntry')).to_be_hidden()
            expect(self.page.locator('#meEntry')).to_be_visible()
            expect(self.page.locator('#meEntry')).to_have_attribute('href', 'me.html')
            nav = self.page.locator('nav[aria-label="站内导航"]')
            expect(nav.get_by_role('link', name='本周推荐', exact=True)).to_have_attribute('href', '#rankings')
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
        # 首页只铺最近收录，具体是哪几部由数据决定：取栅格里的头三部打补丁。
        ids = re.findall(r'<article class="card" data-film="([^"]+)"', source)[:3]
        self.assertEqual(len(ids), 3, '首页至少要铺三部才谈得上排序')
        for fid, score in zip(ids, ['8.6', '10', '']):
            source, n = re.subn(r'(<article\b[^>]*data-film="' + fid + r'"[^>]*data-score=")[^"]*(")',
                                lambda m: m[1] + score + m[2], source)
            self.assertEqual(n, 1, fid)
        self.page.route(fp.is_index, lambda route: route.fulfill(body=source, content_type='text/html'))
        # 排序控件已随片库收进 library.html，这里走地址参数验证同一套排序逻辑。
        self.open('?sort=score')
        unrated = set(self.page.locator('#filmGrid [data-film]').evaluate_all(
            "els => els.filter(e => !e.dataset.score).map(e => e.dataset.film)"))
        order = self.cards().evaluate_all('cards=>cards.map(c=>c.dataset.film)')
        self.assertEqual(order[:2], [ids[1], ids[0]], '有分的高分在前')
        self.assertEqual(set(order[2:]), unrated, '无分的排在后面')
        self.open('?rating=9')
        expect(self.cards()).to_have_count(1)
        expect(self.cards()).to_have_attribute('data-film', ids[1])

    def test_url_refresh_back_and_detail_focus(self):
        # 搜索已移到 library.html，这里只验证「弹窗 + 地址 + 前进后退」这一段。
        self.open()
        fid = self.grid_id()
        opener = self.page.locator(f'button[data-open-film="{fid}"]')
        title = self.page.locator(f'#filmGrid [data-film="{fid}"] h3').text_content()
        watch = self.page.locator(f'#filmGrid [data-film="{fid}"] .watch').get_attribute('href')
        opener.click()
        expect(self.page.locator('#filmDialog')).to_be_visible()
        expect(self.page.locator('#detailTitle')).to_have_text(title)
        expect(self.page.locator('#detailWatch')).to_have_attribute('href', watch)
        self.assertIn(f'film={fid}', self.page.url)
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
        # 搜索框在 library.html，注入串必须在那边被当成纯文本。
        self.page.goto(BASE + fp.url('library.html'), wait_until='load')
        self.page.locator('#libSearch').fill('<img src=x onerror=alert(1)>')
        expect(self.page.locator('#libGrid .card')).to_have_count(0)
        expect(self.page.locator('#libEmpty img')).to_have_count(0)

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
        fid = self.grid_id()
        save = self.page.locator(f'[data-save-film="{fid}"]').first
        save.click()
        expect(save).to_have_attribute('aria-pressed', 'true')
        self.page.reload()
        expect(self.page.locator(f'[data-save-film="{fid}"]').first).to_have_attribute('aria-pressed', 'true')
        self.page.locator('#savedToggle').click()
        expect(self.cards()).to_have_count(1)
        self.page.locator(f'[data-save-film="{fid}"]').first.click()
        expect(self.cards()).to_have_count(0)
        expect(self.page.locator('#emptyState')).to_contain_text('收藏')
        blocked = self.browser.new_context()
        self.addCleanup(blocked.close)
        blocked.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError')}})")
        page = blocked.new_page()
        page.goto(BASE + fp.url())
        blocked_id = page.locator('#filmGrid [data-film]').first.get_attribute('data-film')
        page.locator(f'[data-save-film="{blocked_id}"]').first.click()
        expect(page.locator('#notice')).to_contain_text('本次浏览')
        page.locator('#savedToggle').click()
        expect(page.locator('#filmGrid [data-film]:visible')).to_have_count(1)

    def test_saved_view_hands_the_whole_library_off_to_the_library_page(self):
        """首页只有九部，收藏夹却在浏览器里更全：?saved=1 要在片库里覆盖整份作品表。"""
        self.open()
        in_grid = self.page.locator('#filmGrid [data-film]').evaluate_all('els => els.map((el) => el.dataset.film)')
        self.page.goto(BASE + fp.url('library.html'), wait_until='load')
        outside = self.page.evaluate(
            "(inGrid) => ((window.FRAMEPICK_FILMS || []).find((film) => !inGrid.includes(film.id)) || {}).id || ''",
            in_grid)
        self.assertTrue(outside, '作品表里找不到首页九部之外的作品，无法验证收藏兜底')
        self.page.evaluate("(id) => localStorage.setItem('framepick:saved:v1', JSON.stringify([id]))", outside)
        self.page.goto(BASE + fp.url(), wait_until='load')
        expect(self.page.locator('#savedCount')).to_have_text('1')
        self.page.locator('#savedToggle').click()
        expect(self.page.locator('#emptyState')).to_contain_text('这九部里没有你的收藏')
        link = self.page.locator('#loadMoreLink')
        expect(link).to_have_attribute('href', 'library.html?saved=1')
        expect(link).to_contain_text('我的收藏')
        self.page.goto(BASE + fp.url('library.html?saved=1'), wait_until='load')
        expect(self.page.locator('#libTitle')).to_have_text('我的收藏')
        cards = self.page.locator('#libGrid .card')
        expect(cards).to_have_count(1)
        expect(cards).to_have_attribute('data-film', outside)
        self.page.evaluate("localStorage.removeItem('framepick:saved:v1')")
        self.page.reload()
        expect(self.page.locator('#libEmpty')).to_contain_text('还没有收藏')

    def test_responsive_nojs_and_file_mode(self):
        self.open()
        for width in [320, 390, 820, 1440, 1920]:
            self.page.set_viewport_size({'width': width, 'height': 900})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
            self.page.locator('button[data-open-film]').first.click()
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
        page.goto((fp.SITE_ROOT / 'index.html').as_uri())
        page.locator('#homeSearch').fill('相骨')
        expect(page.locator('#homeSearch')).to_have_value('相骨')

    def test_keyboard_bookmark_focus_survives_saving_and_removing(self):
        self.open()
        save = self.page.locator(f'button[data-save-film="{self.grid_id()}"]').first
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
        expect(self.page.locator('#homeSearch')).to_have_accessible_name(re.compile('搜索片名'))
        # 排序控件在片库页，名称不能丢。
        self.page.goto(BASE + fp.url('library.html'), wait_until='load')
        expect(self.page.locator('#libSort')).to_have_accessible_name('排序')

    def test_completion_state_is_on_every_card_and_in_the_detail(self):
        self.open()
        # 每张卡都要有连载状态，值必须合法；标签数与有状态的卡片数必须一致（不能标了值却不显示）。
        states = self.page.locator('#filmGrid [data-film]').evaluate_all(
            "els => els.map(e => e.dataset.completion || '')")
        self.assertTrue(all(state in ('standalone', 'ongoing', 'completed') for state in states), states)
        tagged = self.page.locator('#filmGrid [data-film] .status-tag').count()
        self.assertEqual(tagged, len([state for state in states if state]))
        # 首页只铺最近收录，可能清一色「单部」；用分享链接挑一部连载中的验证详情能显示状态。
        self.open('?film=xianggu')
        expect(self.page.locator('#detailStatus')).to_be_visible()
        expect(self.page.locator('#detailStatus')).to_contain_text('连载中')
        self.page.keyboard.press('Escape')

        # 栅格里若有连载中的片，点开也要显示状态；没有就走上面的分享链接那条路。
        self.open()
        ongoing = self.page.locator('#filmGrid [data-film][data-completion="ongoing"]')
        if ongoing.count():
            ongoing.first.locator('button[data-open-film]').click()
            expect(self.page.locator('#filmDialog')).to_be_visible()
            expect(self.page.locator('#detailStatus')).to_contain_text('连载中')
            self.page.keyboard.press('Escape')
        single = self.page.locator('#filmGrid [data-film][data-completion="standalone"]')
        if single.count():
            single.first.locator('button[data-open-film]').click()
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

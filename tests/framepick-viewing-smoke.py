"""Framepick 观看记录：已看标记、隐藏已看与个人页。

访客的观看记录只落在 localStorage；登录后合并进服务端账号（换设备可恢复）。
断言以 data-* 契约为准（data-watched / aria-pressed / data-state），不依赖文案。
"""
import http.server
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import framepick_layout as fp  # noqa: E402

from playwright.sync_api import sync_playwright, expect  # noqa: E402

PASSWORD = 'framepick-test-pw'


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@unittest.skipIf(fp.SITE_MODE != 'cinema', '观影记录入口只在影院形态展示')
class FramepickViewingSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='framepick-viewing-browser-')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.base = f'http://127.0.0.1:{port}'
        cls.server = subprocess.Popen(['node', 'serve-framepick.js'], env={**os.environ,
            'PORT': str(port),
            'FRAMEPICK_ACCOUNTS_DATA_DIR': str(Path(cls.temp.name) / 'accounts'),
            'FRAMEPICK_ORDERS_DATA_DIR': str(Path(cls.temp.name) / 'orders'),
            'FRAMEPICK_VIEWING_DATA_DIR': str(Path(cls.temp.name) / 'viewing')},
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.base + '/').close()
                break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError(cls.server.stderr.read().decode())
        cls.runtime = sync_playwright().start()
        cls.browser = cls.runtime.chromium.launch(channel='chrome', headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.runtime.stop()
        cls.server.terminate()
        cls.server.wait(timeout=5)
        cls.server.stderr.close()
        cls.temp.cleanup()

    def make_page(self):
        self.context = self.browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        self.addCleanup(self.context.close)
        page = self.context.new_page()
        page.set_default_timeout(12000)
        self.errors = []
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page = page
        return page

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def open_library(self, page):
        page.goto(self.base + '/')
        page.wait_for_timeout(600)
        return page

    def register_and_login(self, page, email='viewer@example.com'):
        page.click('#accountEntry')
        page.click('#accountSwitch')  # 注册模式
        page.fill('#accountEmail', email)
        page.fill('#accountPassword', PASSWORD)
        page.fill('#accountNickname', '观众')
        page.click('#accountSubmit')
        page.wait_for_timeout(800)

    def test_mark_watched_hides_the_card_and_badges_survive_a_reload(self):
        page = self.make_page()
        self.open_library(page)
        expect(page.locator('[data-film="tangguo"]')).to_be_visible()
        page.locator('[data-film="tangguo"] [data-open-film]').first.click()
        page.wait_for_timeout(300)
        page.click('#detailWatched')
        expect(page.locator('#detailWatched')).to_have_attribute('aria-pressed', 'true')
        page.keyboard.press('Escape')
        page.wait_for_timeout(200)
        # 默认隐藏已看：卡片从片库消失，计数提示隐藏了多少部。
        expect(page.locator('[data-film="tangguo"]')).to_be_hidden()
        expect(page.locator('#resultCount')).to_contain_text('已隐藏 1 部已看')
        # 切换显示已看：URL 带上 hideWatched=0，角标出现。
        page.click('#hideWatchedToggle')
        expect(page.locator('#hideWatchedToggle')).to_have_attribute('aria-pressed', 'false')
        expect(page.locator('[data-film="tangguo"]')).to_be_visible()
        expect(page.locator('[data-film="tangguo"] .watched-badge')).to_be_visible()
        expect(page.locator('[data-film="tangguo"]')).to_have_attribute('data-watched', 'true')
        # 刷新后已看状态与开关都从 URL + localStorage 恢复。
        page.reload()
        page.wait_for_timeout(600)
        expect(page.locator('[data-film="tangguo"]')).to_be_visible()
        expect(page.locator('[data-film="tangguo"] .watched-badge')).to_be_visible()
        # 再切回隐藏并刷新：默认状态恢复隐藏。
        page.click('#hideWatchedToggle')
        expect(page.locator('[data-film="tangguo"]')).to_be_hidden()

    def test_watch_click_records_history_and_marks_watched(self):
        page = self.make_page()
        self.open_library(page)
        page.locator('[data-film="lajizhan"] [data-open-film]').first.click()
        page.wait_for_timeout(300)
        # 点「前往原平台观看」→ 自动记为已看（链接新开标签，页面留在原地）。
        with self.page.expect_popup() as popup:
            page.click('#detailWatch')
        popup.value.close()
        page.wait_for_timeout(400)
        expect(page.locator('#detailWatched')).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('[data-film="lajizhan"]')).to_be_hidden()

    def test_me_page_lists_history_and_removes_records(self):
        page = self.make_page()
        self.open_library(page)
        page.locator('[data-film="tangguo"] [data-open-film]').first.click()
        page.wait_for_timeout(300)
        page.click('#detailWatched')
        page.wait_for_timeout(200)
        page.goto(self.base + '/me.html')
        page.wait_for_timeout(600)
        expect(page.locator('#meWatchedCount')).to_have_text('1')
        expect(page.locator('#meHistoryCount')).to_have_text('1')
        expect(page.locator('#meHistory h3')).to_contain_text('糖果')
        expect(page.locator('#meHistory .me-watched-chip')).to_have_text('已看')
        # 移除记录：这部作品的观看痕迹（含已看标记）一并清除。
        page.click('#meHistory .me-history-actions .review-retry')
        page.wait_for_timeout(300)
        expect(page.locator('#meHistoryCount')).to_have_text('0')
        expect(page.locator('#meWatchedCount')).to_have_text('0')
        expect(page.locator('#meHistoryEmpty')).to_be_visible()

    def test_guest_records_merge_into_the_account_and_restore_on_a_second_device(self):
        page = self.make_page()
        self.open_library(page)
        page.locator('[data-film="tangguo"] [data-open-film]').first.click()
        page.wait_for_timeout(300)
        page.click('#detailWatched')
        page.wait_for_timeout(200)
        page.keyboard.press('Escape')
        page.wait_for_timeout(200)
        # 登录：访客记录应合并进账号。
        self.register_and_login(page)
        page.wait_for_timeout(800)
        viewing = page.evaluate("async () => await (await fetch('/api/framepick/viewing',"
                                " {credentials: 'same-origin'})).json()")
        watched_ids = [row['filmId'] for row in viewing['watched']]
        self.assertIn('tangguo', watched_ids)
        self.assertEqual([row['filmId'] for row in viewing['history']], ['tangguo'])
        # 第二台设备：登录同一账号，记录恢复。
        other = self.browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        self.addCleanup(other.close)
        page2 = other.new_page()
        page2.set_default_timeout(12000)
        errors2 = []
        page2.on('pageerror', lambda error: errors2.append(str(error)))
        page2.goto(self.base + '/me.html')
        page2.click('#accountEntry')
        page2.fill('#accountEmail', 'viewer@example.com')
        page2.fill('#accountPassword', PASSWORD)
        page2.click('#accountSubmit')
        page2.wait_for_timeout(1200)
        expect(page2.locator('#meWatchedCount')).to_have_text('1')
        expect(page2.locator('#meHistory h3')).to_contain_text('糖果')
        page2.close()
        self.assertEqual(errors2, [])

    def test_static_hosting_degrades_to_local_only_records(self):
        # 静态托管（无 /api 服务）：模块照常请求并得到 404，然后诚实地降级——
        # 已看与历史只落本浏览器，个人页照常渲染，不报 JS 错误。
        page = self.make_page()
        root = Path(__file__).resolve().parent.parent
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(root), **kwargs)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        page.goto(f'http://127.0.0.1:{port}/')
        page.wait_for_timeout(600)
        page.locator('[data-film="tangguo"] [data-open-film]').first.click()
        page.wait_for_timeout(300)
        page.click('#detailWatched')
        page.wait_for_timeout(300)
        expect(page.locator('[data-film="tangguo"]')).to_be_hidden()
        page.goto(f'http://127.0.0.1:{port}/me.html')
        page.wait_for_timeout(600)
        expect(page.locator('#meWatchedCount')).to_have_text('1')
        expect(page.locator('#meHistory h3')).to_contain_text('糖果')
        expect(page.locator('#meAccountLine')).to_contain_text('未登录')


if __name__ == '__main__':
    unittest.main()

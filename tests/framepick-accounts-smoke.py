"""Account entry in a real browser.

This suite always runs its own preview server (`serve-framepick.js`, site at the
root) with a disposable accounts directory, so it is independent of the combined
or standalone layout used by the rest of the suite and never touches real data.
"""
import functools
import http.server
import json
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


@unittest.skipIf(fp.SITE_MODE != 'cinema', '账号入口只在影院形态展示，编选形态下不适用')
class FramepickAccounts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='framepick-accounts-browser-')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.base = f'http://127.0.0.1:{port}'
        cls.server = subprocess.Popen(['node', 'serve-framepick.js'], env={**os.environ, 'PORT': str(port),
            'FRAMEPICK_ACCOUNTS_DATA_DIR': str(Path(cls.temp.name) / 'accounts')},
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

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.addCleanup(self.context.close)

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def open_page(self, query=''):
        self.page.goto(self.base + '/' + query.lstrip('/'), wait_until='load')

    def unique_email(self, name):
        return f'{name}-{int(time.time() * 1000)}@example.com'

    def register(self, name, nickname=''):
        self.page.locator('#accountSwitch').click()
        self.page.locator('#accountEmail').fill(self.unique_email(name))
        self.page.locator('#accountPassword').fill(PASSWORD)
        if nickname:
            self.page.locator('#accountNickname').fill(nickname)
        self.page.locator('#accountSubmit').click()

    def test_register_signs_in_survives_refresh_and_logs_out(self):
        self.open_page()
        expect(self.page.locator('#accountEntry')).to_have_text('登录 / 注册')
        self.page.locator('#accountEntry').click()
        expect(self.page.locator('#accountDialog')).to_be_visible()
        self.register('viewer', '观众甲')
        expect(self.page.locator('#accountDialog')).not_to_be_visible()
        entry = self.page.locator('#accountEntry')
        expect(entry).to_have_text('观众甲')
        expect(entry).to_have_attribute('data-signed-in', 'true')
        self.page.reload()
        expect(self.page.locator('#accountEntry')).to_have_text('观众甲')

        self.page.locator('#accountEntry').click()
        expect(self.page.locator('#accountSignedIn')).to_be_visible()
        expect(self.page.locator('#accountWho')).to_contain_text('观众甲')
        self.page.locator('#accountLogout').click()
        expect(self.page.locator('#accountDialog')).not_to_be_visible()
        expect(self.page.locator('#accountEntry')).to_have_text('登录 / 注册')
        self.page.reload()
        expect(self.page.locator('#accountEntry')).to_have_text('登录 / 注册')

    def test_signing_in_keeps_the_open_film_and_returns_to_it(self):
        # The detail dialog is modal, so the account flow is opened from the URL the
        # future purchase button will use: ?film=<id>&account=1.
        self.open_page('?film=xianggu&account=1')
        expect(self.page.locator('#detailTitle')).to_have_text('相骨')
        expect(self.page.locator('#accountDialog')).to_be_visible()
        self.register('context')
        expect(self.page.locator('#accountDialog')).not_to_be_visible()
        # No reload and no navigation: the open film and the URL survive sign-in.
        expect(self.page.locator('#filmDialog')).to_be_visible()
        expect(self.page.locator('#detailTitle')).to_have_text('相骨')
        self.assertIn('film=xianggu', self.page.url)
        expect(self.page.locator('#accountEntry')).to_have_attribute('data-signed-in', 'true')

    def test_wrong_password_shows_the_error_and_keeps_the_form(self):
        self.open_page()
        self.page.locator('#accountEntry').click()
        self.register('first')
        self.page.locator('#accountEntry').click()
        self.page.locator('#accountLogout').click()
        self.page.locator('#accountEntry').click()
        self.page.locator('#accountEmail').fill('nobody@example.com')
        self.page.locator('#accountPassword').fill('definitely-wrong')
        self.page.locator('#accountSubmit').click()
        expect(self.page.locator('#accountError')).to_contain_text('邮箱或密码不正确')
        expect(self.page.locator('#accountDialog')).to_be_visible()
        expect(self.page.locator('#accountEntry')).to_have_attribute('data-signed-in', 'false')

    def test_escape_closes_and_returns_focus_to_the_entry(self):
        self.open_page()
        entry = self.page.locator('#accountEntry')
        entry.click()
        expect(self.page.locator('#accountDialog')).to_be_visible()
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#accountDialog')).not_to_be_visible()
        expect(entry).to_be_focused()

    def test_mobile_has_no_overflow_with_the_new_entry(self):
        for width in [390, 320]:
            self.page.set_viewport_size({'width': width, 'height': 844})
            self.open_page()
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
            expect(self.page.locator('#accountEntry')).to_be_visible()


@unittest.skipIf(fp.SITE_MODE != 'cinema', '静态托管的账号降级说明只在影院形态展示')
class FramepickAccountsOffline(unittest.TestCase):
    """A static host without the shared service must stay usable."""

    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0),
            functools.partial(QuietHandler, directory=str(fp.SITE_ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:' + str(cls.server.server_port)
        cls.runtime = sync_playwright().start()
        cls.browser = cls.runtime.chromium.launch(channel='chrome', headless=True)

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

    def test_undeployed_service_says_so_without_blocking_free_watching(self):
        self.page.goto(self.base + '/', wait_until='load')
        self.page.locator('#accountEntry').click()
        expect(self.page.locator('#accountDialog')).to_be_visible()
        expect(self.page.locator('#accountAvailability')).to_contain_text('尚未在正式站点部署')
        expect(self.page.locator('#accountForm')).to_be_hidden()
        self.page.locator('#accountClose').click()
        # Free discovery still works with no account service at all.
        total = self.page.locator('#filmGrid [data-film]').count()
        self.assertGreaterEqual(total, 3)
        expect(self.page.locator('#filmGrid .watch')).to_have_count(total)


if __name__ == '__main__':
    unittest.main()

"""Exercise the built site: static, paginated and saved covers must use OSS."""
import functools
import http.server
import json
import subprocess
import threading
import unittest
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OSS = 'https://highstrith-assets.oss-cn-hangzhou.aliyuncs.com/reel/img/'


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class OssCovers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run(['sh', 'scripts/build-site.sh'], cwd=ROOT, check=True, capture_output=True)
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0),
            functools.partial(QuietHandler, directory=str(ROOT / 'public')))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}/'
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
        self.context = self.browser.new_context(viewport={'width': 1440, 'height': 1000})
        self.requests = []
        self.context.on('request', lambda request: self.requests.append(request.url)
            if request.resource_type == 'image' and not request.url.startswith('data:') else None)
        # Serve the real cover bytes locally; assertions still inspect the URL requested.
        self.context.route(OSS + '**', self.serve_cover)
        self.page = self.context.new_page()

    def serve_cover(self, route):
        file = ROOT / 'img' / Path(urlparse(route.request.url).path).name
        if file.is_file():
            route.fulfill(path=str(file), content_type='image/jpeg' if file.suffix == '.jpg' else 'image/webp')
        else:
            route.fulfill(status=404)

    def tearDown(self):
        self.context.close()

    def assert_oss_images(self, selector):
        images = self.page.locator(selector)
        self.assertGreater(images.count(), 0)
        for src in images.evaluate_all('images => images.map(image => image.src)'):
            self.assertTrue(src.startswith(OSS), src)
        self.assertTrue(all(url.startswith(OSS) for url in self.requests), self.requests)

    def test_home_static_covers_work_without_javascript(self):
        self.context.close()
        self.context = self.browser.new_context(java_script_enabled=False)
        self.context.route(OSS + '**', self.serve_cover)
        self.page = self.context.new_page()
        self.page.goto(self.base, wait_until='domcontentloaded')
        self.assert_oss_images('img[src]')
        expect(self.page.locator('meta[property="og:image"]')).to_have_attribute('content', OSS + 'share-card.jpg')

    def test_generated_library_covers_use_oss_after_paging(self):
        self.page.goto(self.base + 'library.html', wait_until='load')
        self.assert_oss_images('#libGrid img')
        first = self.page.locator('#libGrid .card').first.get_attribute('data-film')
        self.page.locator('#libPagerTop button[data-page="2"]').first.click()
        self.assertNotEqual(self.page.locator('#libGrid .card').first.get_attribute('data-film'), first)
        self.assert_oss_images('#libGrid img')
        self.assertTrue(self.requests)

    def test_detail_uses_oss_for_thumbnail_and_large_cover(self):
        self.page.goto(self.base, wait_until='load')
        self.page.locator('[data-open-film="pinzi"]').first.click()
        expect(self.page.locator('#detailImage')).to_have_attribute('src', OSS + 'pinzi-1280w.webp')
        self.assertTrue(all(url.startswith(OSS) for url in self.requests), self.requests)

    def test_ranking_site_exposes_login_when_an_account_service_is_configured(self):
        self.context.add_init_script('window.FRAMEPICK_ACCOUNT_API="https://accounts.test/api/framepick";')
        self.context.route('https://accounts.test/**', lambda route: route.fulfill(
            status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'},
            body='{"signedIn":false,"account":null}'))
        self.page.goto(self.base, wait_until='load')
        expect(self.page.locator('#accountEntry')).to_be_visible()
        self.page.locator('#accountEntry').click()
        expect(self.page.locator('#accountDialog')).to_be_visible()
        expect(self.page.locator('#accountEmail')).to_be_visible()

    def test_saved_relative_and_old_pages_covers_are_migrated_on_display(self):
        posters = ['img/xianggu-640w.webp',
            'https://highstrith.github.io/jusheng/img/pinzi-640w.webp',
            'https://highstrith.github.io/highstrithstate/reel/img/yanran-640w.webp']
        rows = [dict(filmId=f'old-{i}', title=f'旧记录 {i}', poster=poster,
            firstAt='2026-11-04T08:00:00Z', lastAt='2026-11-04T08:00:00Z', opens=1)
            for i, poster in enumerate(posters)]
        self.context.add_init_script('localStorage.setItem("framepick:history:v1", ' + json.dumps(json.dumps(rows)) + ');')
        self.page.goto(self.base + 'me.html', wait_until='load')
        expect(self.page.locator('#meHistory img')).to_have_count(len(posters))
        self.assert_oss_images('#meHistory img')
        # Migrating the display must not erase the user's stored history.
        self.assertEqual(self.page.evaluate('JSON.parse(localStorage.getItem("framepick:history:v1")).length'), len(rows))

    def test_upload_dry_run_lists_current_images_and_excludes_source_files(self):
        result = subprocess.run(['sh', 'scripts/upload-cover-assets.sh', '--dry-run'],
            cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('helong-640w.webp', result.stdout)
        self.assertIn('share-card.jpg', result.stdout)
        self.assertNotIn('._', result.stdout)
        self.assertNotIn('raw/', result.stdout)


if __name__ == '__main__':
    unittest.main()

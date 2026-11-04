"""首页排版契约：领衔区（intro/lede/source-note/feature）在各宽度下不重叠、不溢出。

原来挂在作品集仓库的 typography-smoke.py 里，因为测的是片库首页，随拆仓一起搬过来。
"""
import os
import unittest
from playwright.sync_api import sync_playwright

BASE = os.environ.get('STUDIO_BASE_URL', 'http://127.0.0.1:3200').rstrip('/')
PATH = os.environ.get('FRAMEPICK_BASE_PATH', '/')


class FramepickTypography(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = sync_playwright().start()
        cls.browser = cls.runtime.chromium.launch(channel='chrome', headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.runtime.stop()

    def test_film_index_lead_uses_available_space_and_mobile_reading_order(self):
        page = self.browser.new_page(reduced_motion='reduce')
        self.addCleanup(page.context.close)
        for width in [320, 390, 760, 820, 1191, 1440]:
            page.set_viewport_size({'width': width, 'height': 1000})
            page.goto(BASE + PATH, wait_until='domcontentloaded')
            metrics = page.evaluate('''() => {
              // The film index was rebuilt around .intro / .feature / .card, so the
              // old .hero and .ledger hooks no longer exist. Missing pieces must
              // read as null rather than throw, or the failure is unreadable.
              const box=s=>{const e=document.querySelector(s); if(!e) return null;
                const r=e.getBoundingClientRect();
                return {x:Math.round(r.x),y:Math.round(r.y),right:Math.round(r.right),bottom:Math.round(r.bottom)}};
              return {title:box('.intro h1'),copy:box('.lede'),note:box('.source-note'),
                feature:box('.feature-media'),
                overflow:document.documentElement.scrollWidth>innerWidth,
                clipped:[...document.querySelectorAll('h1,h2,h3,.lede,.desc')].some(e=>e.scrollWidth>e.clientWidth+2)};
            }''')
            for key in ['title', 'copy', 'note', 'feature']:
                self.assertTrue(metrics[key], (width, key, metrics))
            self.assertFalse(metrics['overflow'], (width, metrics))
            self.assertFalse(metrics['clipped'], (width, metrics))
            if width > 760:
                self.assertGreaterEqual(metrics['copy']['x'], metrics['title']['right'], (width, metrics))
            else:
                self.assertGreaterEqual(metrics['copy']['y'], metrics['title']['bottom'], (width, metrics))
            self.assertGreaterEqual(metrics['note']['y'], metrics['copy']['bottom'], (width, metrics))
            self.assertGreaterEqual(metrics['feature']['y'], max(metrics['title']['bottom'], metrics['note']['bottom']), (width, metrics))
            # 首页 HTML 里始终写全库卡片，显示几张由页面脚本控制；
            # 这里只要求「看到的每张卡都带观看入口」，不写死数量。
            visible_cards = page.locator('article.card:visible')
            self.assertGreater(visible_cards.count(), 0, width)
            self.assertEqual(page.locator('article.card:visible .watch').count(), visible_cards.count(), width)


if __name__ == '__main__':
    unittest.main()

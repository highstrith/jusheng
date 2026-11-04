"""Capture the prototype preview shots referenced by docs/framepick-prototype-20261102.md."""
import functools
import http.server
import socket
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tests'))
import framepick_layout as fp  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / 'docs/framepick-prototype-20261102'
OUT.mkdir(parents=True, exist_ok=True)

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(fp.SITE_SERVE_ROOT))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{port}' + fp.url()

DEMO_KEY = 'framepick:demo:orders:v1'
SEED = f"""() => localStorage.setItem('{DEMO_KEY}', JSON.stringify([{{ id: 'demo-1',
  film: '演示影片 · 示例授权正片（非真实作品）', price: 3, state: 'active',
  createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400000 }}]))"""

with sync_playwright() as runtime:
    browser = runtime.chromium.launch(channel='chrome', headless=True)

    def shot(page, name, target=None):
        if target:
            target.scroll_into_view_if_needed()
            page.wait_for_timeout(250)
        page.screenshot(path=str(OUT / name))
        print('wrote', name)

    # Desktop 1440
    page = browser.new_page(viewport={'width': 1440, 'height': 950})
    page.goto(base, wait_until='load')
    page.evaluate(SEED)
    page.goto(base + '?saved=', wait_until='load')
    page.wait_for_timeout(400)
    shot(page, 'desktop-01-home.png')
    shot(page, 'desktop-02-rankings.png', page.locator('#rankings'))
    shot(page, 'desktop-03-library.png', page.locator('#entries'))
    shot(page, 'desktop-04-cinema.png', page.locator('#cinema'))
    page.locator('#statusOpen').click()
    page.wait_for_timeout(300)
    shot(page, 'desktop-05-status.png')
    page.locator('#statusClose').click()
    page.locator('[data-demo-purchase]').first.scroll_into_view_if_needed()
    page.locator('[data-demo-purchase]').first.click()
    page.wait_for_timeout(300)
    shot(page, 'desktop-06-purchase.png')
    page.close()

    # Mobile 390
    page = browser.new_page(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    page.goto(base, wait_until='load')
    page.evaluate(SEED)
    page.goto(base, wait_until='load')
    page.wait_for_timeout(400)
    shot(page, 'mobile-01-home.png')
    shot(page, 'mobile-02-cinema.png', page.locator('#cinema'))
    page.locator('#statusOpen').click()
    page.wait_for_timeout(300)
    shot(page, 'mobile-03-status.png')
    page.close()

    # Narrowest supported width
    page = browser.new_page(viewport={'width': 320, 'height': 720})
    page.goto(base, wait_until='load')
    page.wait_for_timeout(300)
    shot(page, 'mobile-04-320-home.png')
    page.close()

    browser.close()
server.shutdown()

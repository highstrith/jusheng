"""Framepick 演示购票：真实浏览器里的界面状态机。

演示流程不接支付渠道、不扣款：演示商品与模拟支付回调走本地订单服务，
订单记录在服务端（换设备登录可恢复），浏览器不留订单副本。
所有断言都以 data-state 契约为准（login / unpaid / paying / confirming / active /
failed / canceled / refunding / refunded / expired / unavailable），不依赖中文文案：
文案可以改，状态机不能悄悄退化。
"""
import functools
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

WIDTHS = [320, 390, 820, 1440, 1920]
PASSWORD = 'framepick-test-pw'
# 与 reel/framepick-demo.js 的 TIMEOUT_MS 对齐：支付中 →（900ms）确认中 →（1300ms）已购。
STEP_MS = 900


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class BrowserBase(unittest.TestCase):
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

    # ---- 状态机小工具：读/等 data-state，而不是读中文标签 ----

    def state(self, selector='#purchaseChip'):
        return self.page.locator(selector).get_attribute('data-state')

    def wait_state(self, state, selector='#purchaseChip'):
        expect(self.page.locator(selector)).to_have_attribute('data-state', state)

    def orders(self):
        """服务端订单（登录后可查）。状态用服务端命名：paid / canceled / …"""
        return self.page.evaluate(
            "async () => (await (await fetch('/api/framepick/orders?page=1&pageSize=50',"
            " {credentials: 'same-origin'})).json()).orders || []")


@unittest.skipIf(fp.SITE_MODE != 'cinema', '演示订单与购票只在影院形态展示')
class FramepickSimulatedOrders(BrowserBase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='framepick-orders-browser-')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.base = f'http://127.0.0.1:{port}'
        cls.server = subprocess.Popen(['node', 'serve-framepick.js'], env={**os.environ,
            'PORT': str(port),
            'FRAMEPICK_ACCOUNTS_DATA_DIR': str(Path(cls.temp.name) / 'accounts'),
            'FRAMEPICK_ORDERS_DATA_DIR': str(Path(cls.temp.name) / 'orders')},
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

    def open_page(self, query=''):
        page = self.make_page()
        page.goto(self.base + '/' + query.lstrip('/'), wait_until='load')
        return page

    def unique_email(self, name):
        return f'{name}-{int(time.time() * 1000)}@example.com'

    def sign_in(self, name='viewer'):
        """注册并登录。账号对话框可能已经由购票流程打开，也可能需要自己开。"""
        page = self.page
        if page.locator('#accountEntry').get_attribute('data-signed-in') == 'true':
            return
        if not page.locator('#accountDialog').is_visible():
            page.locator('#accountEntry').click()
        expect(page.locator('#accountDialog')).to_be_visible()
        if page.locator('#accountForm').is_visible():
            if page.locator('#accountNickname').is_hidden():
                page.locator('#accountSwitch').click()
            expect(page.locator('#accountNickname')).to_be_visible()
            page.locator('#accountEmail').fill(self.unique_email(name))
            page.locator('#accountPassword').fill(PASSWORD)
            page.locator('#accountNickname').fill('演示观众')
            page.locator('#accountSubmit').click()
        expect(page.locator('#accountDialog')).not_to_be_visible()
        expect(page.locator('#accountEntry')).to_have_attribute('data-signed-in', 'true')

    def open_purchase(self):
        opener = self.page.locator('[data-demo-purchase]').first
        self.demo_price = int(opener.get_attribute('data-demo-price') or 3)
        opener.click()
        expect(self.page.locator('#purchaseDialog')).to_be_visible()

    def activate(self):
        """走完 未购买 → 支付中 → 确认中 → 已购；返回时购票对话框仍然开着。"""
        page = self.page
        self.wait_state('unpaid')
        page.locator('#purchaseAction').click()
        self.wait_state('paying')
        expect(page.locator('#purchaseAction')).to_be_disabled()
        self.wait_state('confirming')
        self.wait_state('active')
        expect(page.locator('#purchaseAction')).to_be_enabled()

    # ---- 用例 ----

    def test_service_status_separates_what_is_real_from_what_is_demo(self):
        page = self.open_page()
        expect(page.locator('#prototypeBar')).to_be_visible()
        self.assertIn('不产生真实订单', page.locator('#prototypeBar').inner_text())
        page.locator('#statusOpen').click()
        rows = page.locator('#statusList .status-row')
        expect(rows).to_have_count(10)

        def chip(name):
            return page.locator('#statusList .status-row', has_text=name).locator('.state-chip')

        expect(chip('片库发现：搜索、组合筛选、排序、收藏、详情')).to_have_attribute('data-state', 'ready')
        expect(chip('单片购票与支付')).to_have_attribute('data-state', 'local')
        expect(chip('我的影院与授权期内反复观看')).to_have_attribute('data-state', 'local')
        expect(chip('账号（邮箱＋密码）')).to_have_attribute('data-state', 'local')

        payment = page.locator('#statusList .status-row', has_text='单片购票与支付')
        self.assertIn('不产生真实订单', payment.inner_text())
        cinema = page.locator('#statusList .status-row', has_text='我的影院与授权期内反复观看')
        self.assertIn('不代表可以播放授权正片', cinema.inner_text())
        # 状态弹层里的说明和购票对话框里的说明必须一致地承认没有支付渠道。
        self.assertIn('没有真实支付渠道', page.locator('#purchaseNote').inner_text())

    def test_signed_out_purchase_hands_over_to_login_then_unpaid(self):
        page = self.open_page()
        self.open_purchase()
        self.wait_state('login')
        expect(page.locator('#purchaseChip')).not_to_have_text('')
        expect(page.locator('#purchaseChip')).to_have_count(1)
        self.assertIn('授权期内反复观看', page.locator('.purchase-rights').inner_text())
        self.assertIn('不是永久拥有', page.locator('.purchase-rights').inner_text())

        # 未登录点主按钮不是假装下单，而是先要账号。
        page.locator('#purchaseAction').click()
        expect(page.locator('#accountDialog')).to_be_visible()
        self.sign_in('signed-out')

        # 登录回来后原地继续，购票对话框不关、不清空。
        expect(page.locator('#purchaseDialog')).to_be_visible()
        self.wait_state('unpaid')
        meta = page.locator('#purchaseMeta').inner_text()
        self.assertIn('演示影片', meta)
        self.assertIn(f'拟定价格 {self.demo_price} 元', meta)
        self.assertNotIn('演示授权至', meta)
        self.assertEqual(self.orders(), [])

    def test_purchase_runs_paying_confirming_active_and_restores_from_the_server(self):
        page = self.open_page()
        self.sign_in('paid')
        self.open_purchase()
        self.activate()

        self.assertIn('演示授权至', page.locator('#purchaseMeta').inner_text())
        orders = self.orders()
        self.assertEqual(len(orders), 1)
        self.assertEqual(orders[0]['state'], 'paid')
        self.assertTrue(orders[0]['entitlement']['active'])
        self.assertTrue(orders[0]['entitlement']['endsAt'])
        self.assertEqual(orders[0]['filmId'], 'demo-film-3')

        page.locator('#purchaseClose').click()
        expect(page.locator('#purchaseDialog')).not_to_be_visible()
        rows = page.locator('#cinemaList .cinema-row')
        expect(rows).to_have_count(1)
        self.wait_state('active', '#cinemaList .cinema-row .state-chip')
        self.assertIn('不产生真实付款', rows.first.inner_text())
        expect(page.locator('#cinemaEmpty')).to_be_hidden()

        # 演示订单在服务端：刷新后由服务端恢复，不需要重新登录。
        page.reload(wait_until='load')
        expect(page.locator('#cinemaList .cinema-row')).to_have_count(1)
        self.wait_state('active', '#cinemaList .cinema-row .state-chip')
        self.open_purchase()
        self.wait_state('active')

    def test_failed_payment_stops_the_timers_and_cancel_keeps_a_rightless_row(self):
        page = self.open_page()
        self.sign_in('failed')
        self.open_purchase()
        self.wait_state('unpaid')
        page.locator('#purchaseAction').click()
        self.wait_state('paying')

        page.locator('#purchaseSimulate').click()
        self.wait_state('failed')
        self.assertIn('未产生任何费用', page.locator('#purchaseBody').inner_text())
        # 失败必须停住：原来的 支付中 → 确认中 定时器要被清掉，不能自己又变成已购。
        page.wait_for_timeout(STEP_MS * 3)
        self.wait_state('failed')

        page.locator('#purchaseSecondary').click()
        expect(page.locator('#purchaseDialog')).not_to_be_visible()
        expect(page.locator('#cinemaList .cinema-row')).to_have_count(1)
        self.wait_state('canceled', '#cinemaList .cinema-row .state-chip')
        expect(page.locator('#cinemaEmpty')).to_be_visible()
        self.assertIn('当前没有有效的演示权益', page.locator('#cinemaEmpty').inner_text())

        # 没有权益的订单也要留痕，刷新后仍能查到。
        page.reload(wait_until='load')
        self.wait_state('canceled', '#cinemaList .cinema-row .state-chip')
        self.assertEqual([o['state'] for o in self.orders()], ['canceled'])

    def test_refund_expiry_and_delisting_move_rights_without_losing_the_row(self):
        page = self.open_page()
        self.sign_in('rights')
        self.open_purchase()
        self.activate()

        # 退款：处理中权益仍在，处理完收回。
        page.locator('#purchaseAction').click()
        self.wait_state('refunding')
        expect(page.locator('#cinemaEmpty')).to_be_hidden()
        self.wait_state('refunded')
        expect(page.locator('#cinemaEmpty')).to_be_visible()

        # 重新购票
        page.locator('#purchaseAction').click()
        self.wait_state('unpaid')
        self.activate()

        # 授权到期：从已购的次按钮走，对话框保持在原处。
        page.locator('#purchaseSecondary').click()
        self.wait_state('expired')
        expect(page.locator('#purchaseDialog')).to_be_visible()
        expect(page.locator('#cinemaEmpty')).to_be_visible()

        # 下架：订单保留、权益暂停，恢复后还能回到已购。
        page.locator('#purchaseAction').click()
        self.wait_state('unpaid')
        self.activate()
        page.locator('#purchaseUnavailable').click()
        self.wait_state('unavailable')
        expect(page.locator('#cinemaList .cinema-row')).to_have_count(1)
        self.wait_state('unavailable', '#cinemaList .cinema-row .state-chip')
        expect(page.locator('#cinemaEmpty')).to_be_hidden()

        page.locator('#purchaseAction').click()
        self.wait_state('active')

        # 订单历史留在服务端，界面不提供「清除订单」（购前说明承诺保留记录）。
        page.locator('#purchaseClose').click()
        self.assertGreaterEqual(page.locator('#cinemaList .cinema-row').count(), 1)
        self.assertEqual(len(self.orders()), 3)

    def test_login_returns_to_purchase_without_losing_filters_or_touching_real_films(self):
        page = self.open_page()
        page.locator('#filmSearch').fill('相骨')
        expect(page.locator('#filmGrid [data-film]:visible')).to_have_count(1)
        before = page.locator('#filmGrid [data-film]').count()
        self.open_purchase()
        page.locator('#purchaseAction').click()
        self.sign_in('context')
        expect(page.locator('#purchaseDialog')).to_be_visible()
        expect(page.locator('#filmSearch')).to_have_value('相骨')
        self.assertIn('q=', page.url)
        page.locator('#purchaseClose').click()
        expect(page.locator('#filmGrid [data-film]')).to_have_count(before)
        self.assertEqual(page.locator('#filmGrid [data-access="paid"]').count(), 0)
        self.assertNotIn('演示影片', page.locator('#filmGrid').inner_text())

    def test_mobile_layout_and_demo_labels_survive_the_order_ui(self):
        page = self.open_page()
        for width in WIDTHS:
            with self.subTest(width=width):
                page.set_viewport_size({'width': width, 'height': 900})
                page.wait_for_timeout(100)
                self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width + 1)
        # 未接入的服务在对话框里必须自己挂着标记，不能只靠页面正文里的说明。
        for selector, state in (('#membershipDialog', 'missing'),
                                ('#accountDialog', 'local'),
                                ('#creatorDialog', 'missing')):
            with self.subTest(selector=selector):
                expect(page.locator(f'{selector} .state-chip').first).to_have_attribute('data-state', state)
        expect(page.locator('#cinema .state-chip').first).to_have_attribute('data-state', 'local')


@unittest.skipIf(fp.SITE_MODE != 'cinema', '静态托管的订单降级说明只在影院形态展示')
class FramepickOrdersOffline(BrowserBase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0),
            functools.partial(QuietHandler, directory=str(fp.SITE_SERVE_ROOT)))
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

    def test_static_hosting_blocks_only_the_unbuilt_services(self):
        page = self.make_page()
        page.goto(self.base + fp.url(), wait_until='load')
        page.locator('[data-demo-purchase]').first.click()
        expect(page.locator('#purchaseDialog')).to_be_visible()
        expect(page.locator('#purchaseChip')).to_have_attribute('data-state', 'login')

        # 没有账号服务时，购票停在未登录，不会假装下单成功。
        page.locator('#purchaseAction').click()
        expect(page.locator('#accountDialog')).to_be_visible()
        expect(page.locator('#accountForm')).to_be_hidden()
        expect(page.locator('#accountAvailability')).to_contain_text('尚未在正式站点部署')
        expect(page.locator('#purchaseChip')).to_have_attribute('data-state', 'login')
        page.locator('#accountClose').click()
        page.locator('#purchaseClose').click()

        # 免费浏览、原作入口不受账号/订单未接入影响（验证点）。
        cards = page.locator('#filmGrid [data-film]')
        self.assertGreaterEqual(cards.count(), 3)
        expect(page.locator('#filmGrid .watch')).to_have_count(cards.count())
        page.locator('#filmGrid .details-button').first.click()
        expect(page.locator('#filmDialog')).to_be_visible()
        # 未配置共享评价服务（与线上静态托管一致）时「站内评价」Tab 被隐藏；
        # 本机 loopback 有服务时仍可点开。两种环境都不应破坏详情弹窗。
        if page.locator('#reviewsTab').is_visible():
            page.locator('#reviewsTab').click()
            expect(page.locator('#reviewForm')).to_be_visible()
        else:
            expect(page.locator('#reviewsTab')).to_be_hidden()


if __name__ == '__main__':
    unittest.main()

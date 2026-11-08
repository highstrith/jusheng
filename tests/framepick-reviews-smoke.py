"""Guest reviews against a real HTTP handler and an isolated disposable database.

No test writes to the preview's review data. Only failure/race paths intercept
requests; shared-review, edit, refresh, pagination and delete use the real API.
"""
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import framepick_layout as fp  # noqa: E402

from playwright.sync_api import sync_playwright, expect
FIXTURE = r"""
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = process.env.FRAMEPICK_ROOT;
// The shared service lives next to the repository, not inside the published site root,
// so standalone layouts must point at it explicitly.
const modulePath = process.env.FRAMEPICK_REVIEW_MODULE || path.join(root, 'server/framepick-reviews.cjs');
// 首页只铺「最近收录」，卡上是哪几部由数据决定，所以作品白名单也从数据里读，
// 别写死片名——写死会让新片子的离站点击被服务端当成未知作品丢掉。
const catalogue = path.join(root, 'films-data.js');
const filmIds = fs.existsSync(catalogue)
  ? [...fs.readFileSync(catalogue, 'utf8').matchAll(/"id":\s*"([^"]+)"/g)].map((match) => match[1])
  : ['xianggu'];
const handler = fs.existsSync(modulePath) ? require(modulePath).createReviewHandler({
  dataDir: process.env.FRAMEPICK_TEST_DATA, filmIds, cooldownMs: 0
}) : async () => false;
http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://' + req.headers.host);
    if(await handler(req,res,url)) return;
    const file = path.join(root,url.pathname.endsWith('/') ? url.pathname+'index.html' : url.pathname);
    if (!file.startsWith(root + path.sep)) {res.writeHead(403);res.end();return;}
    const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.webp':'image/webp'};
    const body=await fs.promises.readFile(file);
    res.writeHead(200,{'Content-Type':types[path.extname(file)] || 'application/octet-stream'});res.end(body);
  } catch (error) {res.writeHead(404);res.end('Missing: '+error.message);}
}).listen(Number(process.env.PORT),'127.0.0.1');
"""


class FramepickReviews(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='framepick-browser-reviews-')
        cls.fixture = Path(cls.temp.name) / 'fixture.cjs'
        cls.fixture.write_text(FIXTURE)
        cls.runtime = sync_playwright().start()
        cls.browser = cls.runtime.chromium.launch(channel='chrome', headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.runtime.stop()
        cls.temp.cleanup()

    def start_server(self):
        """每个用例一套空数据库：评价和离站计数都写在库里，共用一份会让断言互相污染。"""
        self.data = tempfile.TemporaryDirectory(prefix='framepick-reviews-data-')
        self.addCleanup(self.data.cleanup)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        self.base = f'http://127.0.0.1:{port}'
        self.server = subprocess.Popen(['node', str(self.fixture)], env={**os.environ, 'PORT': str(port),
            'FRAMEPICK_ROOT': str(fp.SITE_SERVE_ROOT), 'FRAMEPICK_TEST_DATA': str(Path(self.data.name) / 'private-data'),
            'FRAMEPICK_REVIEW_MODULE': str(fp.ROOT / 'server' / 'framepick-reviews.cjs')},
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.addCleanup(self.stop_server)
        for _ in range(200):
            try:
                urllib.request.urlopen(self.base + fp.url()).close()
                return
            except OSError:
                time.sleep(.05)
        raise RuntimeError(self.server.stderr.read().decode())

    def stop_server(self):
        self.server.terminate()
        try:
            self.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.server.kill()
            self.server.wait(timeout=5)
        self.server.stderr.close()

    def setUp(self):
        self.start_server()
        self.context = self.browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        self.observe_outbound(self.context)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.addCleanup(self.context.close)

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def open_review(self, page=None, film='xianggu'):
        page = page or self.page
        page.goto(self.base + fp.url('?film=' + film))
        page.get_by_role('tab', name='站内评价', exact=True).click()
        expect(page.locator('#reviewForm')).to_be_visible()
        expect(page.locator('#reviewText')).to_be_enabled()
        return page

    def submit(self, page, text, rating='8', nickname='浏览器访客'):
        page.get_by_label('访客昵称').fill(nickname)
        page.get_by_label('我的评分').select_option(rating)
        page.get_by_label('评价正文').fill(text)
        page.locator('#reviewSubmit').click()
        expect(page.locator('#reviewStatus')).to_contain_text('已保存')

    def outbound_count(self, film='xianggu'):
        data = json.loads(urllib.request.urlopen(self.base + '/api/framepick/outbound/summary').read())
        # 汇总只列出「有过点击」的作品，没点过的片不在列表里，按 0 算。
        return next((entry['outboundClicks'] for entry in data['films'] if entry['filmId'] == film), 0)

    def observe_outbound(self, context):
        # Observe the real client's public event independently of any ranking UI.
        context.add_init_script("window.addEventListener('framepick:outbound-summary', event => { window.__observedOutbound = event.detail; });")

    def grid_film(self, source=None):
        """首页只铺最近收录，具体是哪几部由数据决定：需要「页面上有卡片的作品」时问页面要。"""
        self.page.goto(self.base + fp.url())
        return self.page.evaluate("""(source) => {
          const cards = [...document.querySelectorAll('#filmGrid [data-film]')];
          const pick = cards.find((card) => !source || card.dataset.source === source) || cards[0];
          return pick ? { id: pick.dataset.film, source: pick.dataset.source } : null;
        }""", source)

    def grid_films(self, count=2):
        self.page.goto(self.base + fp.url())
        ids = self.page.locator('#filmGrid [data-film]').evaluate_all('els => els.map(e => e.dataset.film)')
        self.assertGreaterEqual(len(ids), count, '首页卡片不够做跨片验证')
        return ids[:count]

    def wait_for_outbound(self, page, count, film_id):
        page.wait_for_function("([n, id])=>window.__observedOutbound?.films?.find(f=>f.filmId===id)?.outboundClicks === n", arg=[count, film_id])

    def stub_originals(self):
        """把原平台页换成 fixture：首页最近收录的来源不固定，抖音、B站都要打桩。"""
        for origin in ('https://www.douyin.com/**', 'https://www.bilibili.com/**'):
            self.context.route(origin, lambda route: route.fulfill(body='<title>Original fixture</title>'))

    def leave_for_original(self, page, context, selector):
        with context.expect_page() as popup:
            page.locator(selector).click()
        popup.value.close()

    def test_outbound_native_links_share_deduplicated_counts_but_detail_never_counts(self):
        fid = self.grid_film()['id']
        self.stub_originals()
        baseline = self.outbound_count(fid)
        self.page.goto(self.base + fp.url())
        self.page.locator(f'button[data-open-film="{fid}"]').click()
        self.assertEqual(self.outbound_count(fid), baseline)
        self.leave_for_original(self.page, self.context, '#detailWatch')
        self.wait_for_outbound(self.page, baseline + 1, fid)
        self.leave_for_original(self.page, self.context, '#detailWatch')
        self.assertEqual(self.outbound_count(fid), baseline + 1)
        self.page.keyboard.press('Escape')
        # The header/feature/detail are the same guest identity, not extra views.
        self.leave_for_original(self.page, self.context, '.feature .watch >> nth=0')
        self.assertEqual(self.outbound_count(fid), baseline + 1)
        other = self.browser.new_context()
        self.addCleanup(other.close)
        self.observe_outbound(other)
        other.route('https://www.douyin.com/**', lambda route: route.fulfill(body='<title>Original fixture</title>'))
        second = other.new_page()
        second.goto(self.base + fp.url())
        self.leave_for_original(second, other, f'#filmGrid [data-film="{fid}"] .watch')
        self.wait_for_outbound(second, baseline + 2, fid)
        self.page.reload()
        self.wait_for_outbound(self.page, baseline + 2, fid)

    def test_outbound_failure_never_blocks_original_or_invents_count(self):
        fid = self.grid_film()['id']
        self.stub_originals()
        baseline = self.outbound_count(fid)
        self.page.route(f'**/films/{fid}/outbound', lambda route: route.fulfill(status=503, json={'error': 'Temporary fixture failure'}))
        self.page.goto(self.base + fp.url())
        self.leave_for_original(self.page, self.context, f'#filmGrid [data-film="{fid}"] .watch')
        self.assertEqual(self.outbound_count(fid), baseline)
        expect(self.page.locator('#filmDialog')).not_to_be_visible()

    def test_delayed_initial_outbound_summary_cannot_replace_new_count(self):
        fid = self.grid_film()['id']
        baseline = self.outbound_count(fid)
        self.stub_originals()
        self.page.add_init_script("""const fetchOutbound = window.fetch; let firstOutbound = true;
          window.fetch = (url, options) => {
            const response = fetchOutbound(url, options);
            if (String(url).endsWith('/outbound/summary') && firstOutbound) {
              firstOutbound = false;
              return response.then(async result => { await new Promise(resolve=>setTimeout(resolve, 1200)); return result; });
            }
            return response;
          };""")
        self.page.goto(self.base + fp.url())
        self.leave_for_original(self.page, self.context, f'#filmGrid [data-film="{fid}"] .watch')
        self.wait_for_outbound(self.page, baseline + 1, fid)
        self.page.wait_for_timeout(1400)
        self.assertEqual(self.page.evaluate("(id)=>window.__observedOutbound.films.find(f=>f.filmId===id).outboundClicks", fid), baseline + 1)

    def choose_rating_basis(self, basis='community', rating='8'):
        """筛选控件随片库收进 library.html，首页只保留状态；测试直接改状态并触发事件。"""
        self.page.evaluate("""([basis, rating]) => {
          for (const [id, value] of [['scoreBasis', basis], ['scoreFilter', rating]]) {
            const el = document.getElementById(id);
            if (el) { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); }
          }
        }""", [basis, rating])

    def hold_initial_summary(self):
        self.page.add_init_script("""const summaryFetch=window.fetch;window.fetch=async(...args)=>{
          const response=await summaryFetch(...args);
          if(String(args[0]).endsWith('/api/framepick/summary')){
            const body=await response.text();
            await new Promise(resolve=>{window.__releaseSummary=resolve;});
            return new Response(body,{status:response.status,headers:response.headers});
          }return response;
        };""")

    def release_initial_summary(self):
        self.page.wait_for_function('typeof window.__releaseSummary === "function"')
        self.page.evaluate("async()=>{window.__releaseSummary();await new Promise(resolve=>setTimeout(resolve,100));}")

    def test_slow_initial_summary_keeps_other_films_after_detail_load(self):
        open_id, reviewed_id = self.grid_films(2)
        visitor = self.runtime.request.new_context(base_url=self.base)
        self.addCleanup(visitor.dispose)
        self.assertEqual(visitor.get('/api/framepick/session').status, 200)
        self.addCleanup(lambda: visitor.delete(f'/api/framepick/films/{reviewed_id}/reviews'))
        self.assertEqual(visitor.post(f'/api/framepick/films/{reviewed_id}/reviews', data={
            'nickname': '另一部影片的访客', 'text': '已存在的九分评价', 'rating': 9}).status, 200)
        self.hold_initial_summary()
        self.open_review(film=open_id)
        self.release_initial_summary()
        self.page.keyboard.press('Escape')
        expect(self.page.locator(f'[data-film="{reviewed_id}"] .community-score')).to_contain_text('9.0 / 10')
        self.choose_rating_basis()
        expect(self.page.locator('#filmGrid [data-film]:visible')).to_have_count(1)
        expect(self.page.locator('#filmGrid [data-film]:visible')).to_have_attribute('data-film', reviewed_id)

    def test_slow_failed_summary_keeps_newly_published_score(self):
        fid = self.grid_films(1)[0]
        self.page.route('**/api/framepick/summary', lambda route: route.fulfill(
            status=503, content_type='application/json', body='{"error":"汇总暂不可用"}'))
        self.hold_initial_summary()
        self.open_review(film=fid)
        self.addCleanup(lambda: self.context.request.delete(self.base + f'/api/framepick/films/{fid}/reviews'))
        self.submit(self.page, '旧汇总失败前成功发布', '9')
        self.release_initial_summary()
        self.page.keyboard.press('Escape')
        expect(self.page.locator(f'[data-film="{fid}"] .community-score')).to_contain_text('9.0 / 10')
        self.choose_rating_basis()
        expect(self.page.locator('#filmGrid [data-film]:visible')).to_have_count(1)

    def test_failed_anonymous_draft_stays_blank_after_reopen_and_real_retry(self):
        # 草稿活在页面内存里，必须用首页卡片重开同一部作品，不能整页跳转。
        fid = self.grid_films(1)[0]
        self.open_review(film=fid)
        self.addCleanup(lambda: self.context.request.delete(self.base + f'/api/framepick/films/{fid}/reviews'))
        self.submit(self.page, '原有公开评价', '8', '原有公开昵称')
        self.page.route(f'**/api/framepick/films/{fid}/reviews', lambda route:
            route.fulfill(status=503, content_type='application/json', body='{"error":"暂时失败"}')
            if route.request.method == 'POST' else route.continue_())
        self.page.get_by_label('访客昵称').fill('')
        self.page.get_by_label('评价正文').fill('选择匿名后保留的草稿')
        self.page.locator('#reviewSubmit').click()
        expect(self.page.locator('#reviewError')).to_contain_text('草稿已保留')
        expect(self.page.get_by_label('访客昵称')).to_have_value('')
        self.page.keyboard.press('Escape')
        self.page.locator(f'button[data-open-film="{fid}"]').click()
        self.page.get_by_role('tab', name='站内评价', exact=True).click()
        expect(self.page.locator('#reviewText')).to_be_enabled()
        expect(self.page.get_by_label('评价正文')).to_have_value('选择匿名后保留的草稿')
        expect(self.page.get_by_label('访客昵称')).to_have_value('')
        self.page.unroute(f'**/api/framepick/films/{fid}/reviews')
        self.page.locator('#reviewSubmit').click()
        expect(self.page.locator('#reviewStatus')).to_contain_text('已保存')
        response = self.context.request.get(self.base + f'/api/framepick/films/{fid}/reviews')
        self.assertEqual(response.status, 200)
        self.assertEqual(response.json()['yourReview']['nickname'], '访客')
        expect(self.page.locator('#reviewList')).not_to_contain_text('原有公开昵称')

    def test_guest_is_the_default_and_has_no_toggle(self):
        # 不登录就是访客，顶栏不放开关；说明留在评价区里，点完回到原按钮。
        self.page.goto(self.base + fp.url())
        expect(self.page.locator('#guestMode')).to_have_count(0)
        self.page.goto(self.base + fp.url('?film=xianggu'))
        self.page.get_by_role('tab', name='站内评价', exact=True).click()
        self.page.locator('#guestHow').click()
        expect(self.page.locator('#guestDialog')).to_contain_text('浏览器')
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#guestHow')).to_be_focused()

    def test_guest_entry_and_original_site_separation(self):
        self.page.goto(self.base + fp.url('?film=xianggu'))
        expect(self.page.get_by_role('tabpanel', name='作品介绍')).to_contain_text('橘生梦厂整理')
        self.page.get_by_role('tab', name='原平台评价', exact=True).click()
        panel = self.page.get_by_role('tabpanel', name='原平台评价')
        expect(panel).to_contain_text('原平台')
        expect(panel.get_by_role('link')).to_have_attribute('href', 'https://www.douyin.com/video/7675120105457487104')
        expect(panel.locator('form')).to_have_count(0)
        expect(self.page.locator('#detailScore')).to_contain_text('编辑评分：待评')

    def test_two_browsers_share_refresh_upsert_delete_and_rating_basis(self):
        fid = self.grid_films(1)[0]
        other = self.browser.new_context()
        self.addCleanup(other.close)
        second = other.new_page()
        self.open_review(film=fid)
        self.submit(self.page, '<img src=x onerror=alert(1)>第一条真实共享评价', '8', '甲访客')
        expect(self.page.locator('#reviewList')).to_contain_text('本人')
        expect(self.page.locator('#reviewList img')).to_have_count(0)
        self.open_review(second, film=fid)
        expect(second.locator('#reviewList')).to_contain_text('第一条真实共享评价')
        expect(second.locator('#reviewList')).not_to_contain_text('本人')
        self.submit(second, '第二位访客的评价', '10', '乙访客')
        expect(second.locator('#reviewSummary')).to_contain_text('9.0')
        expect(second.locator('#reviewSummary')).to_contain_text('2 人评分')
        self.page.reload()
        self.page.get_by_role('tab', name='站内评价', exact=True).click()
        expect(self.page.locator('#reviewText')).to_have_value('<img src=x onerror=alert(1)>第一条真实共享评价')
        self.submit(self.page, '甲访客更新后的评价', '6', '甲访客')
        expect(self.page.locator('#reviewSummary')).to_contain_text('8.0')
        expect(self.page.locator('#reviewSummary')).to_contain_text('2 人评分')
        self.page.keyboard.press('Escape')
        self.choose_rating_basis()
        expect(self.page.locator('#filmGrid [data-film]:visible')).to_have_count(1)
        expect(self.page.locator('#filmGrid [data-film]:visible')).to_have_attribute('data-film', fid)
        self.assertIn('scoreBasis=community', self.page.url)
        self.page.reload()
        expect(self.page.locator('#scoreBasis')).to_have_value('community')
        # 撤回要在同一部作品上做：首页只有「最近收录」九部，别再按片名点卡片。
        self.page.goto(self.base + fp.url('?film=' + fid))
        self.page.get_by_role('tab', name='站内评价', exact=True).click()
        expect(self.page.locator('#reviewDelete')).to_be_visible()
        self.page.locator('#reviewDelete').click()
        expect(self.page.locator('#reviewStatus')).to_contain_text('已撤回')
        expect(self.page.locator('#reviewSummary')).to_contain_text('10.0')
        expect(self.page.locator('#reviewSummary')).to_contain_text('1 人评分')
        self.open_review(second, film=fid)
        second.locator('#reviewDelete').click()
        expect(second.locator('#reviewSummary')).to_contain_text('暂无站内评分')

    def test_failure_keeps_draft_and_never_claims_success(self):
        self.open_review(film='jinhaitang')
        self.page.route('**/api/framepick/films/jinhaitang/reviews', lambda route:
            route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': '服务暂不可用'}))
            if route.request.method == 'POST' else route.continue_())
        self.page.get_by_label('评价正文').fill('失败后应当保留的草稿')
        self.page.locator('#reviewSubmit').click()
        expect(self.page.locator('#reviewError')).to_contain_text('服务暂不可用')
        expect(self.page.get_by_label('评价正文')).to_have_value('失败后应当保留的草稿')
        expect(self.page.locator('#reviewSubmit')).to_be_enabled()
        expect(self.page.locator('#reviewStatus')).not_to_contain_text('已保存')
        self.page.unroute('**/api/framepick/films/jinhaitang/reviews')
        self.page.get_by_label('评价正文').fill('重试前更新的草稿')
        self.page.locator('#reviewSubmit').click()
        expect(self.page.locator('#reviewStatus')).to_contain_text('已保存')
        expect(self.page.locator('#reviewList')).to_contain_text('重试前更新的草稿')
        self.page.locator('#reviewDelete').click()
        expect(self.page.locator('#reviewStatus')).to_contain_text('已撤回')

    def test_failed_write_during_switch_preserves_per_film_draft(self):
        self.open_review()
        self.page.route('**/api/framepick/films/xianggu/reviews', lambda route:
            route.fulfill(status=503, content_type='application/json', body='{"error":"暂时失败"}')
            if route.request.method == 'POST' else route.continue_())
        self.page.add_script_tag(content="""const beforeDelayFetch=window.fetch;window.fetch=async(...args)=>{
          const response=await beforeDelayFetch(...args);
          if(args[1]?.method==='POST'){
            const body=await response.text();await new Promise(resolve=>setTimeout(resolve,700));
            return new Response(body,{status:response.status,headers:response.headers});
          }return response;
        };""")
        self.page.get_by_label('评价正文').fill('相骨专属的失败草稿')
        with self.page.expect_request(lambda request: request.method == 'POST'):
            self.page.locator('#reviewSubmit').click()
        self.page.evaluate("history.replaceState({},'', '?film=yanran');window.dispatchEvent(new PopStateEvent('popstate'))")
        self.page.get_by_role('tab', name='站内评价', exact=True).click()
        expect(self.page.locator('#reviewText')).to_be_enabled()
        self.page.wait_for_timeout(850)
        expect(self.page.locator('#reviewError')).to_be_empty()
        expect(self.page.locator('#reviewText')).to_have_value('')
        self.page.evaluate("history.replaceState({},'', '?film=xianggu');window.dispatchEvent(new PopStateEvent('popstate'))")
        self.page.get_by_role('tab', name='站内评价', exact=True).click()
        expect(self.page.locator('#reviewText')).to_be_enabled()
        expect(self.page.locator('#reviewText')).to_have_value('相骨专属的失败草稿')
        self.page.unroute('**/api/framepick/films/xianggu/reviews')
        self.submit(self.page, '返回后修改并发布的草稿', '8', '草稿访客')
        expect(self.page.locator('#reviewList')).to_contain_text('返回后修改并发布的草稿')
        self.page.locator('#reviewDelete').click()
        expect(self.page.locator('#reviewStatus')).to_contain_text('已撤回')

    def test_delayed_initial_summary_cannot_replace_new_rating(self):
        self.page.add_init_script("""const baseFetch=window.fetch;window.fetch=(url,options)=>{
          const result=baseFetch(url,options);
          if(String(url).endsWith('/api/framepick/summary')) return result.then(async response=>{
            const body=await response.text();window.__oldSummaryReady=true;
            await new Promise(resolve=>setTimeout(resolve,1000));
            return new Response(body,{status:response.status,headers:response.headers});
          });return result;
        };""")
        fid = self.grid_films(1)[0]
        self.open_review(film=fid)
        self.page.wait_for_function('window.__oldSummaryReady === true')
        self.submit(self.page, '等待期间发布的新评分', '9', '新评分访客')
        self.page.wait_for_timeout(1100)
        self.page.keyboard.press('Escape')
        expect(self.page.locator(f'[data-film="{fid}"] .community-score')).to_contain_text('9.0 / 10')
        # 收尾撤回到刚评的那部作品上，别换成另一部（那边根本没有本人的评价）。
        self.open_review(film=fid)
        self.page.locator('#reviewDelete').click()
        expect(self.page.locator('#reviewStatus')).to_contain_text('已撤回')

    def test_real_pagination_preserves_draft_and_score_only_can_be_edited(self):
        visitors = []
        for index in range(21):
            visitor = self.runtime.request.new_context(base_url=self.base)
            visitors.append(visitor)
            self.addCleanup(visitor.dispose)
            self.assertEqual(visitor.get('/api/framepick/session').status, 200)
            response = visitor.post('/api/framepick/films/jinhaitang/reviews', data={
                'nickname': f'分页访客{index}', 'text': f'分页评价{index}', 'rating': None})
            self.assertEqual(response.status, 200, response.text())
        self.open_review(film='jinhaitang')
        expect(self.page.locator('#reviewList .review-item')).to_have_count(20)
        expect(self.page.locator('#reviewSummary')).to_contain_text('暂无站内评分')
        self.page.get_by_label('评价正文').fill('翻页时仍保留草稿')
        self.page.locator('#reviewMore').click()
        expect(self.page.locator('#reviewList .review-item')).to_have_count(21)
        expect(self.page.get_by_label('评价正文')).to_have_value('翻页时仍保留草稿')
        expect(self.page.locator('#reviewMore')).not_to_be_visible()
        self.submit(self.page, '', '7', '只评分的访客')
        expect(self.page.locator('#reviewSummary')).to_contain_text('7.0 / 10 · 1 人评分')
        self.submit(self.page, '更新为只评价不评分', '', '只评分的访客')
        expect(self.page.locator('#reviewSummary')).to_contain_text('暂无站内评分')
        expect(self.page.locator('#reviewSummary')).to_contain_text('22 条评价')
        self.page.locator('#reviewDelete').click()
        expect(self.page.locator('#reviewStatus')).to_contain_text('已撤回')
        for visitor in visitors:
            self.assertEqual(visitor.delete('/api/framepick/films/jinhaitang/reviews').status, 200)

    def test_required_content_and_duplicate_submit(self):
        self.open_review(film='yanran')
        self.page.locator('#reviewSubmit').click()
        expect(self.page.locator('#reviewError')).to_contain_text('评分或评价正文')
        expect(self.page.locator('#reviewText')).to_be_focused()
        posts = []
        self.page.on('request', lambda request: posts.append(request.url) if request.method == 'POST' else None)
        self.page.add_script_tag(content="""const nativeReviewFetch=window.fetch;window.fetch=async(...args)=>{
          const response=await nativeReviewFetch(...args);
          if(args[1]?.method==='POST') await new Promise(resolve=>setTimeout(resolve,300));
          return response;
        };""")
        self.page.get_by_label('我的评分').select_option('5')
        self.page.get_by_label('评价正文').fill('只应发布一次')
        self.page.locator('#reviewSubmit').click()
        self.page.evaluate("document.querySelector('#reviewForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))")
        expect(self.page.locator('#reviewSubmit')).to_be_disabled()
        expect(self.page.locator('#reviewStatus')).to_contain_text('已保存')
        self.assertEqual(len(posts), 1)
        self.page.locator('#reviewDelete').click()
        expect(self.page.locator('#reviewStatus')).to_contain_text('已撤回')

    def test_stale_requests_cannot_leak_into_another_film(self):
        visitor = self.runtime.request.new_context(base_url=self.base)
        self.addCleanup(visitor.dispose)
        self.assertEqual(visitor.get('/api/framepick/session').status, 200)
        self.assertEqual(visitor.post('/api/framepick/films/xianggu/reviews', data={
            'nickname': '相骨独有访客', 'text': '这条评价只属于相骨', 'rating': 9}).status, 200)
        self.page.add_init_script("""const originalFetch=window.fetch;window.fetch=(url,opts)=>{
          const result=originalFetch(url,opts);
          if(String(url).includes('/films/xianggu/reviews'))return result.then(async response=>{
            const body=await response.text();window.__reviewADelayed=true;
            await new Promise(resolve=>setTimeout(resolve,700));
            return new Response(body,{status:response.status,headers:response.headers});
          });return result;
        };""")
        self.page.goto(self.base + fp.url('?film=xianggu'))
        with self.page.expect_request('**/api/framepick/films/xianggu/reviews?offset=0'):
            self.page.get_by_role('tab', name='站内评价', exact=True).click()
        self.page.wait_for_function('window.__reviewADelayed === true')
        self.page.evaluate("history.replaceState({},'', '?film=yanran');window.dispatchEvent(new PopStateEvent('popstate'))")
        expect(self.page.locator('#detailTitle')).to_have_text('燕然')
        self.page.get_by_role('tab', name='站内评价', exact=True).click()
        expect(self.page.locator('#reviewForm')).to_be_visible()
        self.page.wait_for_timeout(900)
        expect(self.page.locator('#reviewHeading')).to_contain_text('燕然')
        expect(self.page.locator('#reviewList')).not_to_contain_text('这条评价只属于相骨')
        expect(self.page.locator('#reviewSummary')).to_contain_text('暂无站内评分')
        expect(self.page.locator('#reviewError')).to_be_empty()
        self.assertEqual(visitor.delete('/api/framepick/films/xianggu/reviews').status, 200)

    def test_offline_file_and_static_host_do_not_publish(self):
        requests = []
        self.page.on('request', lambda request: requests.append(request.url))
        self.page.goto((fp.SITE_ROOT / 'index.html').as_uri() + '?film=xianggu')
        self.page.get_by_role('tab', name='站内评价', exact=True).click()
        expect(self.page.locator('#reviewAvailability')).to_contain_text('未配置')
        expect(self.page.locator('#reviewSubmit')).to_be_disabled()
        self.assertFalse(any('/api/framepick' in url for url in requests))
        def serve_static(route):
            # 静态托管的诚实模拟：缺文件要回 404，不能像真实主机那样摔异常。
            target = fp.SITE_ROOT / 'index.html' if fp.is_index(route.request.url) else fp.site_file(route.request.url)
            if target.is_file():
                route.fulfill(path=str(target))
            else:
                route.fulfill(status=404, body='Missing')
        self.page.route('http://framepick-static.test/**', serve_static)
        self.page.goto('http://framepick-static.test' + fp.url('?film=xianggu'))
        self.page.get_by_role('tab', name='站内评价', exact=True).click()
        expect(self.page.locator('#reviewAvailability')).to_contain_text('未配置')
        expect(self.page.locator('#reviewSubmit')).to_be_disabled()
        self.assertFalse(any('/api/framepick' in url for url in requests))

    def test_mobile_tabs_keyboard_and_form_names(self):
        for width in [390, 320]:
            self.page.set_viewport_size({'width': width, 'height': 844})
            self.open_review(film='yanran')
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
            self.assertLessEqual(self.page.locator('#filmDialog').evaluate('(el)=>el.scrollWidth'), width)
            expect(self.page.get_by_label('访客昵称')).to_be_visible()
            expect(self.page.get_by_label('我的评分')).to_be_visible()
            self.page.get_by_role('tab', name='作品介绍', exact=True).focus()
            self.page.keyboard.press('ArrowRight')
            expect(self.page.get_by_role('tab', name='原平台评价', exact=True)).to_be_focused()
            self.page.keyboard.press('ArrowRight')
            expect(self.page.get_by_role('tab', name='站内评价', exact=True)).to_be_focused()
            expect(self.page.locator('#reviewForm')).to_be_visible()


if __name__ == '__main__':
    unittest.main()

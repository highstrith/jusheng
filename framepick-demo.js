/* Framepick prototype states: what is real, what is a local demo, what is not built.
 *
 * The purchase flow is backed by the local order service (server/framepick-orders.cjs):
 * demo goods, server-side prices, simulated payment callbacks, rights granted once.
 * There is no payment channel — nothing is charged and no real order is produced.
 * The browser holds no order records: it renders what the service reports, so a
 * device change can find the same orders again once signed in. */
(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  const FILM_ID = 'demo-film-3';
  const DEMO_FILM = '演示影片 · 示例授权正片（非真实作品）';
  const RIGHTS = '购买权益：在该作品授权期内反复观看；不是永久拥有，也不是 48 小时租赁。价格与授权期由服务端决定。';
  const TIMEOUT_MS = 900;

  /* Service states: ready = works on this page, local = works locally / not deployed,
   * missing = not built. Each entry names what a real rollout would need. */
  const SERVICES = [
    { name: '片库发现：搜索、组合筛选、排序、收藏、详情', state: 'ready',
      detail: '本页面的真实功能。作品信息来自片库记录，收藏只保存在此浏览器。',
      need: '无需后端；大规模后改由片库接口提供。' },
    { name: '榜单 · 每日更新', state: 'ready',
      detail: '按本站收录日期排序，数据来自片库本身。', need: '无需后端。' },
    { name: '榜单 · 近 10 天热门', state: 'local',
      detail: '按本站「前往原作」的去重跳转次数排序：北京时间今天及前 9 个自然日，同一访客每部作品每天最多计一次，仅原作入口计入。页面明确标注这是跳转次数，不是播放量。',
      need: '需要部署统计接口与服务端持久化；正式站点未部署时该榜如实留空。' },
    { name: '榜单 · 口碑高分', state: 'local',
      detail: '使用站内访客评分，试行至少 5 人、均分 8 分与样本加权；未达门槛不展示，也不编造分数。',
      need: '需要部署评价服务与评分快照；没有评分时显示空状态，不显示“连续高分”。' },
    { name: '访客评价与评分', state: 'local',
      detail: '本地服务可用，签名 Cookie 识别访客，可在本浏览器更新或撤回；正式站点尚未部署。',
      need: 'HTTPS 同源评价接口、服务端存储、限流与内容审核；跨站 Cookie 与多实例写入需另行设计。' },
    { name: '账号（邮箱＋密码）', state: 'local',
      detail: '本地可用，仅为本原型的演示账号：密码哈希与会话都在本机，不是线上账号服务。访客评价不并入账号，也不能凭昵称认领。',
      need: '部署账号服务、邮箱验证与找回密码邮件、跨设备会话与安全审计。' },
    { name: '单片购票与支付', state: 'local',
      detail: '本地服务提供演示商品、服务端定价与模拟支付回调：演示订单会记录在服务端，权益只发放一次。没有真实支付渠道，不产生真实订单，不收任何费用。',
      need: '商户号（微信支付／支付宝）、真实支付回调与对账、发票与售后；正式站点部署订单服务。' },
    { name: '我的影院与授权期内反复观看', state: 'local',
      detail: '演示订单与授权状态由本地服务记录，换设备登录可恢复查询；不代表可以播放授权正片。',
      need: '媒资加密或签名 URL、授权期校验、播放器、并发与下载限制。' },
    { name: '创作者投稿、审核、授权与收益结算', state: 'missing',
      detail: '未接入。当前只保留流程说明与合作邮箱，分成比例与结算周期未确定，不填写固定承诺。',
      need: '审核后台、权利材料留痕、合同与分成规则、有效订单与退款扣减、结算状态。' },
    { name: '搜片 AI 调度', state: 'missing',
      detail: '未实施。首批来源为小红书、抖音、哔哩哔哩，人工核实后才进入片库。',
      need: '调度任务、平台数据的合规来源、去重与看片评估流程。' }
  ];
  const STATE_LABEL = { ready: '已实现', local: '本地演示 · 正式未部署', missing: '未接入' };

  const COPY = {
    login: { chip: '未登录', title: '先登录，再购买（演示）',
      body: '单片观影需要账号来保存订单与观影权益。未登录也可以继续免费发现、评价与跳转原作。' },
    unpaid: { chip: '未购买', title: '确认价格与权益（演示）',
      body: RIGHTS },
    paying: { chip: '支付中', title: '正在跳转支付（演示）', body: '演示流程不会调用任何支付渠道，也不会收费。' },
    confirming: { chip: '确认中', title: '服务端正在确认订单（演示）', body: '真实接入时由支付回调与服务端确认；重复通知不会重复发权益或重复计收益。' },
    active: { chip: '已购 · 授权有效', title: '已购（演示）', body: '演示订单已确认，不代表真实付款，也不能播放授权正片。' },
    failed: { chip: '支付失败', title: '支付未完成（演示）', body: '未产生任何费用，可以重试或取消。' },
    canceled: { chip: '已取消', title: '订单已取消（演示）', body: '未产生任何费用，也没有获得观影权益。' },
    refunding: { chip: '退款中', title: '退款处理中（演示）', body: '退款期间权益仍然保留，处理完成后收回。' },
    refunded: { chip: '已退款', title: '已退款（演示）', body: '款项退回，观影权益已收回；真实结算以支付渠道与对账结果为准。' },
    expired: { chip: '授权到期', title: '授权期已结束（演示）', body: '可重新购买以继续观看；到期不等于永久拥有。' },
    unavailable: { chip: '暂时无法播放', title: '影片已下架或暂不可播（演示）', body: '已购订单保留，放映恢复后可继续观看；涉及下架的退款规则另行说明。' }
  };
  const ACTIONS = {
    login: { main: '去登录（演示）', secondary: '取消' },
    unpaid: { main: '演示支付', secondary: '取消' },
    paying: { main: '支付中…', secondary: '取消' },
    confirming: { main: '确认中…', secondary: '取消' },
    active: { main: '演示：申请退款', secondary: '演示：授权到期' },
    failed: { main: '重试演示支付', secondary: '取消订单' },
    canceled: { main: '重新演示购票', secondary: '关闭' },
    refunding: { main: '退款中…', secondary: '关闭' },
    refunded: { main: '重新演示购票', secondary: '关闭' },
    expired: { main: '重新演示购票', secondary: '关闭' },
    unavailable: { main: '演示：影片下架后恢复', secondary: '关闭' }
  };
  // 服务端订单状态 → 界面 data-state。paying 只在跳转支付的瞬间存在。
  const SERVER_TO_UI = {
    unpaid: 'unpaid', confirming: 'confirming', paid: 'active', failed: 'failed',
    canceled: 'canceled', refunding: 'refunding', refunded: 'refunded',
    expired: 'expired', unavailable: 'unavailable'
  };

  let signedIn = false;
  let orders = [];        // 服务端订单（本页缓存），含全部历史
  let catalogue = null;   // 演示商品与服务端价格
  let view = { state: null, price: 3 };  // state 为 null 时由订单推导
  let flowOrderId = null; // 当前支付流程锁定的订单，失败按钮只打这一单
  let timers = [];
  let queue = Promise.resolve();

  // 与账号模块同一条门：只有本机预览（回环地址 http）或显式配置了 API 才访问
  // 订单服务；file:// 与正式静态托管不发任何 /api 请求。
  const configuredApi = String(window.FRAMEPICK_ACCOUNT_API || window.FRAMEPICK_REVIEW_API || '').trim();
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  let apiBase = configuredApi || (loopback && /^https?:$/.test(location.protocol) ? '/api/framepick' : '');
  try {
    if (apiBase && !/^https?:$/.test(new URL(apiBase, location.href).protocol)) apiBase = '';
  } catch { apiBase = ''; }
  apiBase = apiBase.replace(/\/+$/, '');
  // 会话 token 与账号模块共用同一个键：跨站请求带 Bearer，浏览器不再依赖第三方 Cookie。
  const SESSION_KEY = 'framepick:session:v1';
  function orderAuthHeader() {
    try { const token = localStorage.getItem(SESSION_KEY); return token ? { Authorization: `Bearer ${token}` } : {}; } catch { return {}; }
  }


  function pad(n) { return String(n).padStart(2, '0'); }
  function stamp(ms) {
    const date = new Date(ms);
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  }

  // 所有服务端调用排队执行，防止「支付中点失败」和未完成的下单互相踩。
  function enqueue(task) {
    queue = queue.then(task).catch((error) => { console.error(error); });
    return queue;
  }

  async function api(path, options = {}) {
    if (!apiBase) throw new Error('订单服务未配置');
    const response = await fetch(apiBase + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...orderAuthHeader() },
      ...options,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  }

  async function loadCatalogue() {
    if (!apiBase) return catalogue;
    try {
      const { status, data } = await api('/orders/catalogue');
      if (status === 200 && Array.isArray(data?.products)) catalogue = data;
    } catch { /* 服务不可用时价格显示回退值 */ }
    const product = catalogue?.products?.find((item) => item.id === FILM_ID);
    if (product) view.price = product.amountCents / 100;
    return catalogue;
  }

  async function loadOrders() {
    if (!signedIn || !apiBase) { orders = []; return orders; }
    try {
      const { status, data } = await api('/orders?page=1&pageSize=50');
      orders = status === 200 && Array.isArray(data?.orders) ? data.orders : [];
    } catch { /* 服务不可用时保留现有缓存 */ }
    return orders;
  }

  // 同一作品在影院里只展示最新一单的状态；历史仍留在服务端，可换设备查询。
  function currentOrder() {
    const mine = orders.filter((order) => order.filmId === FILM_ID);
    return mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] || null;
  }

  function currentUiState() {
    if (view.state) return view.state;
    if (!signedIn) return 'login';
    const order = currentOrder();
    return (order && SERVER_TO_UI[order.state]) || 'unpaid';
  }

  function entitlementEndsAt(order) {
    return order?.entitlement?.endsAt ? Date.parse(order.entitlement.endsAt) : 0;
  }

  function renderPurchase() {
    const dialog = $('#purchaseDialog');
    if (!dialog) return;
    const state = currentUiState();
    const copy = COPY[state];
    const action = ACTIONS[state];
    const order = currentOrder();
    $('#purchaseChip').textContent = copy.chip;
    $('#purchaseChip').dataset.state = state;
    $('#purchaseTitle').textContent = copy.title;
    $('#purchaseBody').textContent = copy.body;
    $('#purchaseMeta').textContent = '演示影片：' + DEMO_FILM + ' · 拟定价格 ' + view.price + ' 元（价格由服务端决定）'
      + (state === 'active' && entitlementEndsAt(order) ? ' · 演示授权至 ' + stamp(entitlementEndsAt(order)) : '');
    $('#purchaseAction').textContent = state === 'unpaid' ? '演示支付 ' + view.price + ' 元' : action.main;
    $('#purchaseSecondary').textContent = action.secondary;
    const busy = state === 'paying' || state === 'confirming' || state === 'refunding';
    $('#purchaseAction').disabled = busy;
    $('#purchaseSecondary').disabled = state === 'refunding';
  }

  function renderCinema() {
    const list = $('#cinemaList');
    if (!list) return;
    list.textContent = '';
    const latest = new Map();
    // 按创建时间倒序扫，同一作品留最新一单；历史仍在服务端可查。
    for (const order of [...orders].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))) {
      if (!latest.has(order.filmId)) latest.set(order.filmId, order);
    }
    const rows = [...latest.values()];
    const live = rows.filter((order) => ['paid', 'refunding', 'unavailable'].includes(order.state));
    $('#cinemaEmpty').hidden = live.length !== 0;
    $('#cinemaEmpty').textContent = rows.length === 0
      ? '还没有演示订单。本页的购票、授权与收益均为模拟，不会产生真实付款。'
      : '当前没有有效的演示权益（已退款或授权到期）。';
    for (const order of rows) {
      const state = SERVER_TO_UI[order.state] || order.state;
      const row = document.createElement('article');
      row.className = 'cinema-row';
      const title = document.createElement('h3');
      title.textContent = DEMO_FILM;
      const chip = document.createElement('span');
      chip.className = 'state-chip';
      chip.dataset.state = state;
      chip.textContent = COPY[state]?.chip || order.state;
      const meta = document.createElement('p');
      meta.className = 'cinema-meta';
      meta.textContent = '演示订单 · ' + (order.amountCents / 100) + ' 元 · 创建于 ' + stamp(Date.parse(order.createdAt))
        + (entitlementEndsAt(order) ? ' · 授权至 ' + stamp(entitlementEndsAt(order)) : '')
        + ' · 不产生真实付款或放映权益';
      const actions = document.createElement('div');
      actions.className = 'cinema-actions';
      const watch = document.createElement('button');
      watch.type = 'button';
      watch.className = 'button secondary demo-button';
      watch.textContent = '演示：尝试播放';
      watch.addEventListener('click', () => {
        $('#cinemaNote').textContent = '授权放映未接入：演示权益不能播放正片。真实接入需要签名地址与授权期校验。';
      });
      const refund = document.createElement('button');
      refund.type = 'button';
      refund.className = 'button secondary demo-button';
      refund.textContent = '演示：申请退款';
      refund.addEventListener('click', () => {
        enqueue(async () => { await api(`/orders/${order.id}/simulate`, { method: 'POST', body: { outcome: 'refunding' } }); await refresh(); });
        timers.push(setTimeout(() => {
          enqueue(async () => { await api(`/orders/${order.id}/simulate`, { method: 'POST', body: { outcome: 'refunded' } }); await refresh(); });
        }, TIMEOUT_MS));
      });
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'button secondary demo-button';
      drop.textContent = '演示：影片下架';
      drop.addEventListener('click', () => {
        enqueue(async () => { await api(`/orders/${order.id}/simulate`, { method: 'POST', body: { outcome: 'unavailable' } }); await refresh(); });
      });
      actions.append(watch, refund, drop);
      row.append(title, chip, meta, actions);
      list.append(row);
    }
  }

  function renderAll() {
    renderPurchase();
    renderCinema();
  }

  async function refresh() {
    await loadOrders();
    renderAll();
  }

  function openDialog(dialog) {
    if (!dialog || dialog.open) return;
    dialog.showModal();
    document.body.classList.add('has-dialog');
  }
  function closeDialog(dialog) {
    if (!dialog?.open) return;
    dialog.close();
    if (!$('#filmDialog')?.open) document.body.classList.remove('has-dialog');
  }

  /* ---------- prototype strip + service status ---------- */

  function renderServices() {
    const list = $('#statusList');
    if (!list) return;
    list.textContent = '';
    for (const service of SERVICES) {
      const row = document.createElement('article');
      row.className = 'status-row';
      row.dataset.state = service.state;
      const head = document.createElement('h3');
      head.textContent = service.name;
      const chip = document.createElement('span');
      chip.className = 'state-chip';
      chip.dataset.state = service.state;
      chip.textContent = STATE_LABEL[service.state];
      head.after(chip);
      const detail = document.createElement('p');
      detail.className = 'status-detail';
      detail.textContent = service.detail;
      const need = document.createElement('p');
      need.className = 'status-need';
      need.textContent = '正式接入需要：' + service.need;
      row.append(head, chip, detail, need);
      list.append(row);
    }
  }

  function wirePrototypeBar() {
    const bar = $('#prototypeBar');
    if (!bar) return;
    let dismissed = false;
    try { dismissed = sessionStorage.getItem('framepick:demo:bar') === 'off'; } catch { /* private mode */ }
    bar.hidden = dismissed;
    $('#prototypeClose')?.addEventListener('click', () => {
      bar.hidden = true;
      try { sessionStorage.setItem('framepick:demo:bar', 'off'); } catch { /* private mode */ }
    });
    $('#statusOpen')?.addEventListener('click', () => { renderServices(); openDialog($('#statusDialog')); });
    for (const opener of $$('[data-open-status]')) {
      opener.addEventListener('click', (event) => {
        event.preventDefault();
        renderServices();
        openDialog($('#statusDialog'));
      });
    }
    $('#statusClose')?.addEventListener('click', () => closeDialog($('#statusDialog')));
    $('#statusDialog')?.addEventListener('close', () => {
      if (!$('#filmDialog')?.open && !$('#purchaseDialog')?.open) document.body.classList.remove('has-dialog');
    });
  }

  /* ---------- demo purchase: every state a real checkout has to handle ---------- */

  function requestAction() {
    return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function ensureOrder() {
    const existing = currentOrder();
    if (existing && ['unpaid', 'confirming', 'paid'].includes(existing.state)) return existing;
    const { status, data } = await api('/orders', {
      method: 'POST',
      body: { filmId: FILM_ID, requestId: requestAction() },
    });
    if (status === 201 || status === 200) return data.order;
    throw new Error(data?.error || `下单失败（${status}）`);
  }

  async function simulate(orderId, outcome) {
    const { status, data } = await api(`/orders/${orderId}/simulate`, {
      method: 'POST', body: { outcome },
    });
    if (status !== 200) throw new Error(data?.error || `模拟回调失败（${status}）`);
    return data.order;
  }

  function startPayment() {
    clearTimers();
    view.state = 'paying';
    renderPurchase();
    enqueue(async () => {
      const order = await ensureOrder();
      flowOrderId = order.id;
      // 用户若已点了「支付失败」，就不再推进确认，直接让失败回调收尾。
      if (view.state === 'paying' || view.state === 'confirming') {
        await simulate(order.id, 'confirming');
        await refresh();
      }
    });
    timers.push(setTimeout(() => {
      if (view.state !== 'paying') return;
      view.state = 'confirming';
      renderPurchase();
      // 与旧原型一致的节奏：确认中停留约 1.3 秒再进已购，给「确认中」稳定的展示窗口。
      timers.push(setTimeout(() => {
        if (view.state !== 'confirming') return;
        enqueue(async () => {
          const id = flowOrderId || currentOrder()?.id;
          if (!id) return;
          await simulate(id, 'paid');
          view.state = 'active';
          await refresh();
        });
      }, TIMEOUT_MS + 400));
    }, TIMEOUT_MS));
  }

  function failPayment() {
    clearTimers();
    view.state = 'failed';
    enqueue(async () => {
      const id = flowOrderId || currentOrder()?.id;
      if (id) {
        await simulate(id, 'failed');
        await refresh();
      }
    });
    renderPurchase();
  }

  function startRefund() {
    clearTimers();
    const order = currentOrder();
    if (!order) return;
    enqueue(async () => { await simulate(order.id, 'refunding'); await refresh(); });
    view.state = 'refunding';
    renderPurchase();
    timers.push(setTimeout(() => {
      enqueue(async () => {
        await simulate(order.id, 'refunded');
        view.state = 'refunded';
        await refresh();
      });
    }, TIMEOUT_MS));
  }

  function expireOrder() {
    clearTimers();
    const order = currentOrder();
    if (!order) return;
    view.state = 'expired';
    enqueue(async () => { await simulate(order.id, 'expired'); await refresh(); });
    renderPurchase();
  }

  function cancelOrder() {
    clearTimers();
    const order = currentOrder();
    if (!order) return;
    view.state = 'canceled';
    enqueue(async () => {
      await api(`/orders/${order.id}/cancel`, { method: 'POST', body: {} });
      await refresh();
    });
    closeDialog($('#purchaseDialog'));
  }

  function markUnavailable() {
    const order = currentOrder();
    if (!order) return;
    view.state = 'unavailable';
    enqueue(async () => { await simulate(order.id, 'unavailable'); await refresh(); });
    renderPurchase();
  }

  function restoreOrder() {
    clearTimers();
    const order = currentOrder();
    if (!order) return;
    view.state = 'active';
    enqueue(async () => { await simulate(order.id, 'paid'); await refresh(); });
    renderPurchase();
  }

  function repurchase() {
    clearTimers();
    view.state = 'unpaid';
    enqueue(async () => {
      await api('/orders', { method: 'POST', body: { filmId: FILM_ID, requestId: requestAction() } });
      await refresh();
    });
    renderPurchase();
  }

  function openPurchase() {
    view.state = null;
    openDialog($('#purchaseDialog'));
    renderPurchase();
  }

  function mainAction() {
    const state = currentUiState();
    switch (state) {
      case 'login':
        openDialog($('#accountDialog'));
        return;
      case 'unpaid':
        startPayment();
        return;
      case 'failed':
        startPayment();
        return;
      case 'active':
        startRefund();
        return;
      case 'canceled': case 'refunded': case 'expired':
        repurchase();
        return;
      case 'unavailable':
        restoreOrder();
        return;
      default:
        return;
    }
  }

  function secondaryAction() {
    const state = currentUiState();
    if (state === 'active') { expireOrder(); return; }
    if (state === 'failed') { cancelOrder(); return; }
    if (state === 'unpaid' || state === 'paying' || state === 'confirming' || state === 'login') {
      clearTimers();
      view.state = null;
      closeDialog($('#purchaseDialog'));
      return;
    }
    closeDialog($('#purchaseDialog'));
  }

  function wirePurchase() {
    const dialog = $('#purchaseDialog');
    if (!dialog) return;
    for (const opener of $$('[data-demo-purchase]')) {
      opener.addEventListener('click', (event) => {
        event.preventDefault();
        if (opener.dataset.demoPrice) view.price = Number(opener.dataset.demoPrice);
        openPurchase();
      });
    }
    $('#purchaseAction').addEventListener('click', () => { mainAction(); renderPurchase(); });
    $('#purchaseSecondary').addEventListener('click', () => { secondaryAction(); renderPurchase(); });
    $('#purchaseClose')?.addEventListener('click', () => closeDialog(dialog));
    $('#purchaseSimulate')?.addEventListener('click', failPayment);
    $('#purchaseUnavailable')?.addEventListener('click', () => markUnavailable());
    dialog.addEventListener('close', () => {
      view.state = null;
      if (!$('#filmDialog')?.open && !$('#statusDialog')?.open) document.body.classList.remove('has-dialog');
    });
  }

  /* ---------- 我的影院 ---------- */

  function wireCinema() {
    if (!$('#cinemaList')) return;
    renderCinema();
  }

  /* ---------- degrade gracefully when the creator module is not shipped ---------- */

  function wireCreatorFallback() {
    const entry = $('#creatorEntry');
    const dialog = $('#creatorDialog');
    if (!entry || !dialog || window.framepickCreatorsReady) return;
    entry.addEventListener('click', () => {
      $('#creatorAvailability').textContent = '创作者投稿、审核与收益结算尚未接入：当前为演示原型，只保留流程说明与合作邮箱，不产生真实投稿或收益记录。';
      $('#creatorBody').hidden = true;
      openDialog(dialog);
    });
    for (const closer of $$('#creatorClose, #creatorDialog [data-close-creator]')) {
      closer.addEventListener('click', () => closeDialog(dialog));
    }
  }

  function wireDemoChips() {
    // Every dialog that depends on an unbuilt service carries a visible 演示 marker.
    for (const node of $$('[data-demo-chip]')) {
      node.textContent = node.dataset.demoChip || '演示';
    }
  }

  wirePrototypeBar();
  wirePurchase();
  wireCinema();
  wireCreatorFallback();
  wireDemoChips();
  renderServices();
  loadCatalogue().then(() => renderPurchase());

  window.addEventListener('framepick:account', ({ detail }) => {
    signedIn = Boolean(detail?.signedIn);
    if (signedIn && currentUiState() === 'login') {
      view.state = null;
      renderPurchase();
    }
    const entry = $('#accountEntry');
    if (entry) entry.dataset.demoAccount = String(signedIn);
    // 订单在服务端：登录后换设备也能恢复同一份记录。
    enqueue(async () => { await refresh(); });
  });

  window.dispatchEvent(new CustomEvent('framepick:demo-ready', { detail: { services: SERVICES.length } }));
})();

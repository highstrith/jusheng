(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  if (!$('#reviewsPanel')) return;
  const configured = String(window.FRAMEPICK_REVIEW_API || '').trim();
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  let api = configured || (loopback && /^https?:$/.test(location.protocol) ? '/api/framepick' : '');
  try {
    if (api && !/^https?:$/.test(new URL(api, location.href).protocol)) api = '';
  } catch { api = ''; }
  api = api.replace(/\/+$/, '');
  const offline = '当前页面未配置共享评价服务，暂不能查看或发布站内评价。';
  const tabs = [...document.querySelectorAll('.detail-tabs [role="tab"]')];
  const fields = $('#reviewFields');
  const drafts = new Map();
  const summaries = new Map();
  const summaryVersions = new Map();
  const pendingWrites = new Set();
  let current = null;
  let generation = 0;
  let loadingController = null;
  let sessionPromise = null;
  let guestNickname = '';
  let loaded = false;
  let dirty = false;
  let busy = false;
  let shown = 0;
  let yourReview = null;
  let outboundReadVersion = 0;
  let outboundState = { available: false, configured: Boolean(api) };

  function setText(selector, text) { $(selector).textContent = text; }
  function isCurrent(id, version) { return current?.id === id && generation === version; }
  function captureDraft() {
    if (current && dirty) drafts.set(current.id, { nickname: $('#reviewNickname').value, text: $('#reviewText').value, rating: $('#reviewRating').value });
  }
  function fillForm(value) {
    $('#reviewNickname').value = value?.nickname ?? guestNickname;
    $('#reviewText').value = value?.text || '';
    $('#reviewRating').value = value?.rating == null ? '' : String(value.rating);
  }
  function syncButtons() {
    const pending = busy || pendingWrites.has(current?.id);
    fields.disabled = !api || !loaded || pending || Boolean(loadingController);
    $('#reviewMore').disabled = pending || Boolean(loadingController);
    $('#reviewDelete').hidden = !yourReview;
    $('#reviewSubmit').textContent = pending ? '正在保存…' : yourReview ? '更新我的评价' : '发布评价';
  }

  async function request(path, options = {}, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
    try {
      if (signal?.aborted) controller.abort();
      const response = await fetch(api + path, { ...options, credentials: 'include', signal: controller.signal, headers: { Accept: 'application/json', ...options.headers } });
      let data;
      try { data = await response.json(); } catch { throw new Error('评价服务返回异常，请稍后重试。'); }
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '评价服务暂不可用，请稍后重试。');
      return data;
    } catch (error) {
      if (timedOut) throw new Error('评价服务连接超时，请重试。');
      if (error.name === 'TypeError') throw new Error('无法连接评价服务，请检查网络后重试。');
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  function ensureSession() {
    if (!sessionPromise) sessionPromise = request('/session').then((data) => {
      guestNickname = typeof data.nickname === 'string' ? data.nickname : '';
      setText('#guestAvailability', '已连接共享评价服务，评价以本浏览器的访客身份记录。');
      return data;
    }).catch((error) => {
      sessionPromise = null;
      setText('#guestAvailability', error.message);
      throw error;
    });
    return sessionPromise;
  }

  function emitOutbound(state) {
    outboundState = state;
    window.dispatchEvent(new CustomEvent('framepick:outbound-summary', { detail: state }));
  }
  async function refreshOutbound() {
    const version = ++outboundReadVersion;
    if (!api) { emitOutbound({ available: false, configured: false }); return; }
    try {
      const data = await request('/outbound/summary');
      if (version === outboundReadVersion) emitOutbound({ ...data, available: true, configured: true });
    } catch {
      if (version === outboundReadVersion) emitOutbound({ available: false, configured: true });
    }
  }
  const outboundFilmIds = new Set([...document.querySelectorAll('#filmGrid [data-film]')].map(card => card.dataset.film));
  function trackOutbound(event) {
    const link = event.target.closest('a[data-outbound-film]');
    if (!api || !link || !event.isTrusted || event.defaultPrevented || event.altKey
      || (event.type === 'click' ? event.button !== 0 : event.button !== 1)
      || !outboundFilmIds.has(link.dataset.outboundFilm)) return;
    const id = link.dataset.outboundFilm;
    // Preserve native link behavior; analytics failure must never block viewing.
    ensureSession().then(() => request('/films/' + encodeURIComponent(id) + '/outbound', {
      method: 'POST', body: '{}', keepalive: true, headers: { 'Content-Type': 'application/json' }
    })).then(refreshOutbound).catch(() => {});
  }
  document.addEventListener('click', trackOutbound);
  document.addEventListener('auxclick', trackOutbound);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshOutbound(); });

  function dispatchSummary(available) {
    window.dispatchEvent(new CustomEvent('framepick:review-summary', { detail: { films: [...summaries.values()], available } }));
  }
  async function refreshSummary() {
    if (!api) return;
    const versions = new Map(summaryVersions);
    try {
      const data = await request('/summary');
      for (const entry of data.films || []) {
        // Keep newer detail/write results while still accepting unaffected films.
        if (versions.get(entry.filmId) !== summaryVersions.get(entry.filmId)) continue;
        summaries.set(entry.filmId, entry);
        summaryVersions.set(entry.filmId, (summaryVersions.get(entry.filmId) || 0) + 1);
      }
      dispatchSummary(true);
    } catch { if (!summaries.size) dispatchSummary(false); }
  }
  function renderSummary(data) {
    summaryVersions.set(current.id, (summaryVersions.get(current.id) || 0) + 1);
    const rating = Number.isFinite(data.averageRating) && data.ratingCount > 0 ? data.averageRating.toFixed(1) + ' / 10 · ' + data.ratingCount + ' 人评分' : '暂无站内评分';
    setText('#reviewSummary', rating + ' · ' + data.total + ' 条评价');
    summaries.set(current.id, { filmId: current.id, averageRating: data.averageRating, ratingCount: data.ratingCount, commentCount: data.total });
    dispatchSummary(true);
  }
  function renderReview(review) {
    const article = document.createElement('article');
    article.className = 'review-item';
    const heading = document.createElement('h4');
    heading.textContent = (review.nickname || '访客') + (review.isMine ? ' · 本人' : '');
    const meta = document.createElement('p');
    meta.className = 'review-meta';
    const date = new Date(review.updatedAt || review.createdAt);
    meta.textContent = (review.rating == null ? '未评分' : review.rating + ' / 10') + (Number.isNaN(date.getTime()) ? '' : ' · ' + date.toLocaleDateString('zh-CN')) + (review.updatedAt !== review.createdAt ? ' · 已更新' : '');
    const body = document.createElement('p');
    body.className = 'review-body';
    body.textContent = review.text || '这位访客只留下了评分。';
    article.append(heading, meta, body);
    if (review.isMine) {
      const edit = document.createElement('button');
      edit.className = 'review-edit';
      edit.type = 'button';
      edit.textContent = '编辑我的评价';
      edit.addEventListener('click', () => { $('#reviewText').focus(); });
      article.append(edit);
    }
    return article;
  }
  function renderReviews(data, append = false) {
    if (!append) $('#reviewList').replaceChildren();
    for (const review of data.reviews || []) $('#reviewList').append(renderReview(review));
    shown = append ? shown + data.reviews.length : data.reviews.length;
    renderSummary(data);
    yourReview = data.yourReview;
    $('#reviewMore').hidden = shown >= data.total;
    setText('#reviewListStatus', data.total ? '已显示 ' + shown + ' / ' + data.total + ' 条评价' : '还没有站内评价，来分享第一份观影感受。');
    if (!append) {
      fillForm(drafts.get(current.id) || yourReview);
      dirty = drafts.has(current.id);
    }
  }

  async function loadReviews(append = false) {
    if (!api || !current || busy) return;
    captureDraft();
    const id = current.id;
    const version = generation;
    loadingController?.abort();
    const controller = new AbortController();
    loadingController = controller;
    syncButtons();
    $('#reviewRetry').hidden = true;
    $('#reviewMore').disabled = true;
    setText('#reviewError', '');
    setText('#reviewAvailability', '正在连接共享评价服务…');
    setText('#reviewListStatus', '正在加载评价…');
    try {
      await ensureSession();
      if (!isCurrent(id, version) || controller.signal.aborted) return;
      const data = await request('/films/' + encodeURIComponent(id) + '/reviews?offset=' + (append ? shown : 0), {}, controller.signal);
      if (!isCurrent(id, version) || controller.signal.aborted) return;
      renderReviews(data, append);
      loaded = true;
      setText('#reviewAvailability', '不登录也能评价 · 内容对所有访问者公开');
    } catch (error) {
      if (!isCurrent(id, version) || controller.signal.aborted) return;
      setText('#reviewError', error.message);
      setText('#reviewAvailability', '共享评价服务暂不可用。');
      setText('#reviewListStatus', '评价加载失败，可稍后重试。');
      $('#reviewRetry').hidden = false;
    } finally {
      if (isCurrent(id, version) && loadingController === controller) {
        loadingController = null;
        syncButtons();
      }
    }
  }

  function activateTab(tab, focus = false) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      $('#' + item.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) tab.focus();
    if (tab.id === 'reviewsTab' && !loaded && !loadingController) loadReviews();
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); activateTab(tabs[next], true); }
    });
  }

  window.addEventListener('framepick:film-open', ({ detail }) => {
    if (current?.id === detail.id) return;
    captureDraft();
    loadingController?.abort();
    loadingController = null;
    generation += 1;
    current = detail;
    loaded = false;
    busy = false;
    dirty = false;
    shown = 0;
    yourReview = null;
    fillForm(drafts.get(detail.id));
    dirty = drafts.has(detail.id);
    setText('#reviewHeading', '《' + detail.title + '》站内评价');
    setText('#reviewSummary', api ? '站内评分加载后显示' : '站内评分暂不可用');
    $('#originalReviews').href = detail.link;
    $('#reviewList').replaceChildren();
    setText('#reviewError', '');
    setText('#reviewStatus', '');
    setText('#reviewListStatus', '打开站内评价后加载。');
    setText('#reviewAvailability', api ? '无需注册，使用此浏览器的访客身份。' : offline);
    $('#reviewMore').hidden = true;
    $('#reviewRetry').hidden = true;
    syncButtons();
    activateTab(tabs[0]);
  });
  window.addEventListener('framepick:film-close', () => {
    captureDraft();
    generation += 1;
    loadingController?.abort();
    loadingController = null;
    current = null;
  });
  window.addEventListener('framepick:catalogue-ready', () => {
    if (summaries.size) dispatchSummary(true);
    emitOutbound(outboundState);
  });
  $('#reviewForm').addEventListener('input', () => { dirty = true; });
  $('#reviewForm').addEventListener('change', () => { dirty = true; });

  async function writeReview(remove = false) {
    if (!current || !api || !loaded || busy || pendingWrites.has(current.id)) return;
    const id = current.id;
    const version = generation;
    const payload = { nickname: $('#reviewNickname').value.trim(), text: $('#reviewText').value.trim(), rating: $('#reviewRating').value === '' ? null : Number($('#reviewRating').value) };
    setText('#reviewError', '');
    setText('#reviewStatus', '');
    if (!remove && !payload.text && payload.rating === null) {
      setText('#reviewError', '请填写评分或评价正文。');
      $('#reviewText').focus();
      return;
    }
    captureDraft();
    busy = true;
    pendingWrites.add(id);
    syncButtons();
    try {
      await ensureSession();
      const data = await request('/films/' + encodeURIComponent(id) + '/reviews', remove ? { method: 'DELETE' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      drafts.delete(id);
      if (!isCurrent(id, version)) { refreshSummary(); return; }
      dirty = false;
      renderReviews(data);
      if (!remove) guestNickname = payload.nickname;
      setText('#reviewStatus', remove ? '评价已撤回。' : '评价已保存，其他访客现在可以查看。');
      if (remove) fillForm(null);
    } catch (error) {
      if (isCurrent(id, version)) setText('#reviewError', error.message + ' 草稿已保留，可重试。');
    } finally {
      pendingWrites.delete(id);
      if (isCurrent(id, version)) { busy = false; syncButtons(); }
      else if (current?.id === id) { busy = false; loadReviews(); }
    }
  }
  $('#reviewForm').addEventListener('submit', (event) => { event.preventDefault(); writeReview(); });
  $('#reviewDelete').addEventListener('click', () => writeReview(true));
  $('#reviewRetry').addEventListener('click', () => loadReviews());
  $('#reviewMore').addEventListener('click', () => loadReviews(true));

  // 访客是默认状态，不是要切换的模式：顶栏不再放开关，只在评价区留一个说明入口。
  const guest = $('#guestDialog');
  $('#guestHow').addEventListener('click', () => {
    guest.showModal();
    document.body.classList.add('has-dialog');
    if (api) ensureSession().catch(() => {});
  });
  for (const button of [$('#guestClose'), $('#guestDone')]) button.addEventListener('click', () => guest.close());
  guest.addEventListener('close', () => { document.body.classList.toggle('has-dialog', Boolean(document.querySelector('dialog[open]'))); });
  guest.addEventListener('click', (event) => {
    if (event.target !== guest) return;
    const rect = guest.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) guest.close();
  });
  setText('#guestAvailability', api ? '共享评价服务将在首次使用时识别此浏览器。' : offline);
  refreshSummary();
  refreshOutbound();
})();

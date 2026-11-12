(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const grid = $('#filmGrid');
  if (!grid) return;
  const filmDialog = $('#filmDialog');
  const membershipDialog = $('#membershipDialog');
  const cards = [...grid.querySelectorAll('[data-film]')];
  const films = cards.map((card, index) => {
    const raw = card.dataset.score.trim();
    const number = Number(raw);
    const score = raw !== '' && Number.isFinite(number) && number >= 0 && number <= 10 ? number : null;
    const text = (selector) => card.querySelector(selector)?.textContent.trim() || '';
    return {
      id: card.dataset.film, card, index, score, communityScore: null,
      category: card.dataset.category, genres: card.dataset.genres.split(' '),
      source: card.dataset.source, access: card.dataset.access, date: card.dataset.date,
      published: card.dataset.published || '',
      title: text('h3'), author: text('.author-name'), kind: text('.kind'),
      description: text('.desc'), reason: text('.recommendation'), episode: text('.episode'),
      // 连载状态：卡片只放一个小标签，体量／续集关系是隐藏文本，详情弹窗才展示。
      completion: card.dataset.completion || '', statusLabel: text('.status-tag'),
      volume: text('.volume'), relation: text('.relation'),
      image: card.querySelector('img'), link: card.querySelector('.watch').href, runtime: text('.card-runtime'),
      search: card.textContent.toLocaleLowerCase()
    };
  });
  const byId = new Map(films.map((film) => [film.id, film]));
  // 首页只铺编辑精选，本周推荐和主推里可能有没进栅格的片。它们没有卡片，
  // 只用于详情弹窗；数据由生成器写在 window.FRAMEPICK_DETAIL_EXTRAS 里。
  const extras = new Map();
  // 把一份精简记录变成弹窗能用的 film 对象：没有卡片，只有详情要用的字段。
  const toFilm = (raw) => {
    if (!raw || !raw.id) return null;
    const image = new Image();
    // 不在这里赋 src：`new Image().src = …` 会立刻发一次请求，而详情弹窗可能永远不打开。
    // 首页主推那六部都走这条路，等于白白多下六张缩略图。真正的地址先挂 data，
    // 展开详情时由 coverOf() 取出来用。
    image.dataset.cover = raw.cover;
    image.alt = raw.coverAlt || raw.title || '';
    image.setAttribute('width', raw.coverWidth || '');
    image.setAttribute('height', raw.coverHeight || '');
    return {
      id: raw.id, card: null, index: -1, score: raw.score ?? null, communityScore: null,
      category: raw.category, genres: raw.genres || [], source: raw.source,
      access: raw.access || 'free', date: raw.intakeDate || '',
      published: raw.published || '', title: raw.title || '', author: raw.author || '',
      kind: raw.kind || '', description: raw.description || '', reason: raw.recommendation || '',
      episode: raw.episode || '', completion: raw.completion || '', statusLabel: raw.statusLabel || '',
      volume: raw.volume || '', relation: raw.relation || '', image, link: raw.sourceUrl, runtime: raw.runtime || '', search: ''
    };
  };
  // 栅格里的 img 有 src，详情表里的是延迟地址（data-cover），两种都认。
  const coverOf = (image) => image.dataset.cover || image.currentSrc || image.src;
  for (const raw of (window.FRAMEPICK_DETAIL_EXTRAS || [])) {
    const film = toFilm(raw);
    if (film && !byId.has(film.id) && !extras.has(film.id)) extras.set(film.id, film);
  }
  const lookupFilm = (id) => byId.get(id) || extras.get(id);

  // 分享链接可能指向不在首页九部里的作品。真正要用时才去取完整作品表（library.html 也用它），
  // 平时不下载，首页体积不为「没被点开的作品」买单。
  let catalogueRequest = null;
  function loadCatalogue() {
    if (catalogueRequest) return catalogueRequest;
    catalogueRequest = new Promise((resolve) => {
      if (Array.isArray(window.FRAMEPICK_FILMS)) return resolve();
      const script = document.createElement('script');
      script.src = 'films-data.js';
      script.onload = script.onerror = () => resolve();
      document.head.appendChild(script);
    }).then(() => {
      for (const raw of (window.FRAMEPICK_FILMS || [])) {
        const film = toFilm(raw);
        if (film && !byId.has(film.id) && !extras.has(film.id)) extras.set(film.id, film);
      }
    });
    return catalogueRequest;
  }
  // 页面上的「N 部筛过的短片」跟着数据走，作品增减时不必再手改文案。
  // 首页栅格只放精选，作品总数由 data-total 带着走，别再拿卡片数当总数。
  const catalogueTotal = () => Number(grid.dataset.total) || films.length;
  for (const node of document.querySelectorAll('[data-film-total]')) node.textContent = String(catalogueTotal());
  // A film is watched where its author published it, so the labels follow the card.
  const SOURCE_LABEL = { douyin: '抖音', xiaohongshu: '小红书', bilibili: '哔哩哔哩', youtube: 'YouTube', x: 'X' };
  const CATEGORY_LABEL = { film: '完整电影', series: '系列短剧', short: '剧情短片', ad: '商业广告', music: '音乐影像', experimental: '实验影像' };
  const controls = {
    q: $('#filmSearch'), genre: $('#genreFilter'), source: $('#sourceFilter'),
    rating: $('#scoreFilter'), access: $('#accessFilter'), sort: $('#sortFilter'), scoreBasis: $('#scoreBasis')
  };
  // 首页按页给：手机 6 部、桌面 12 部，一页一屏，作品再多也不拖成长条。
  const PAGE_QUERY = '(max-width: 760px)';
  function pageSize() { return matchMedia(PAGE_QUERY).matches ? 6 : 12; }
  const defaults = { q: '', category: 'all', genre: 'all', source: 'all', rating: 'all', access: 'all', sort: 'curated', scoreBasis: 'editor', saved: false, hideWatched: true, limit: 12, page: 1 };
  const categories = [...document.querySelectorAll('[data-category]')].filter((node) => node.tagName === 'BUTTON');
  const storageKey = 'framepick:saved:v1';
  let storageAvailable = true;
  let saved = new Set();
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]');
    // 只校验是字符串：首页只铺九部，收藏可能指向页面没引用的作品，
    // 用 lookupFilm 过滤会把这些收藏静默丢掉，计数也跟着变少。
    if (Array.isArray(parsed)) saved = new Set(parsed.filter((id) => typeof id === 'string'));
  } catch { storageAvailable = false; }
  let state = { ...defaults };
  let lastVisible = [];
  let currentFilm = null;
  let opener = null;
  let noticeTimer;
  const defaultTitle = document.title;

  function notify(message) {
    $('#notice').textContent = message;
    $('#notice').classList.add('is-visible');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => $('#notice').classList.remove('is-visible'), 2800);
  }

  function readState() {
    const params = new URL(location.href).searchParams;
    // ?perPage=all 一次铺开全部，给「查看全部」链接和自动化测试用。
    const all = params.get('perPage') === 'all';
    // 首页只铺精选时，栅格里的卡片数不等于片库总数：一页全给，不翻页。
    const homeLimit = Number(grid.dataset.limit);
    state = { ...defaults, limit: all ? Infinity : (Number.isFinite(homeLimit) && homeLimit > 0 ? homeLimit : pageSize()), q: (params.get('q') || '').slice(0, 100), saved: params.get('saved') === '1', hideWatched: params.get('hideWatched') !== '0' };
    const page = Number(params.get('page'));
    if (Number.isFinite(page) && page >= 1) state.page = Math.floor(page);
    const category = params.get('category');
    if (categories.some((button) => button.dataset.category === category)) state.category = category;
    for (const key of ['genre', 'source', 'rating', 'access', 'sort', 'scoreBasis']) {
      const value = params.get(key);
      if (key === 'access' && value === 'vip') { state.access = 'paid'; continue; }
      if ([...controls[key].options].some((option) => option.value === value)) state[key] = value;
    }
  }

  function writeState() {
    const url = new URL(location.href);
    for (const key of Object.keys(defaults)) {
      // limit 由 perPage 决定，不往地址里写；页码才是要分享的状态。
      if (key === 'limit') continue;
      const value = state[key];
      if (value === defaults[key]) url.searchParams.delete(key);
      else url.searchParams.set(key, key === 'saved' ? '1' : key === 'hideWatched' ? '0' : value);
    }
    try { history.replaceState(history.state, '', url); } catch { /* file viewers may restrict history */ }
  }

  function syncControls() {
    for (const [key, control] of Object.entries(controls)) control.value = state[key];
    for (const button of categories) button.setAttribute('aria-pressed', String(button.dataset.category === state.category));
    $('#savedToggle').setAttribute('aria-pressed', String(state.saved));
    const hideWatchedToggle = $('#hideWatchedToggle');
    if (hideWatchedToggle) {
      hideWatchedToggle.setAttribute('aria-pressed', String(state.hideWatched));
      hideWatchedToggle.textContent = state.hideWatched ? '隐藏已看' : '已看可见 · 再点隐藏';
    }
  }

  function syncSaved() {
    $('#savedCount').textContent = String(saved.size);
    for (const button of document.querySelectorAll('[data-save-film]')) {
      const film = byId.get(button.dataset.saveFilm);
      const active = saved.has(film.id);
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', (active ? '取消收藏《' : '收藏《') + film.title + '》');
    }
    if (currentFilm) {
      const active = saved.has(currentFilm.id);
      $('#detailSave').setAttribute('aria-pressed', String(active));
      $('#detailSave').textContent = active ? '已收藏 · 取消' : '收藏作品';
    }
  }

  function isWatched(film) {
    return Boolean(window.FramepickViewing && window.FramepickViewing.isWatched(film.id));
  }

  function syncWatchedBadges() {
    for (const film of films) {
      const watched = isWatched(film);
      film.card.classList.toggle('is-watched', watched);
      if (watched) film.card.dataset.watched = 'true';
      else delete film.card.dataset.watched;
      const badge = film.card.querySelector('.watched-badge');
      if (badge) badge.hidden = !watched;
    }
    if (currentFilm) syncDetailWatchedButton(currentFilm);
  }

  function syncDetailWatchedButton(film) {
    const button = $('#detailWatched');
    if (!button) return;
    const active = isWatched(film);
    button.setAttribute('aria-pressed', String(active));
    button.textContent = active ? '已看 · 取消' : '标记已看';
  }

  function render() {
    const selectedScore = (film) => state.scoreBasis === 'community' ? film.communityScore : film.score;
    const query = state.q.trim().toLocaleLowerCase();
    const watchedIds = new Set(films.filter(isWatched).map((film) => film.id));
    const visible = films.filter((film) =>
      (!query || film.search.includes(query)) &&
      (state.category === 'all' || film.category === state.category) &&
      (state.genre === 'all' || film.genres.includes(state.genre)) &&
      (state.source === 'all' || film.source === state.source) &&
      (state.access === 'all' || film.access === state.access) &&
      (state.rating === 'all' || (selectedScore(film) !== null && selectedScore(film) >= Number(state.rating))) &&
      (!state.saved || saved.has(film.id)) &&
      (!state.hideWatched || !watchedIds.has(film.id))
    );
    if (state.sort === 'score') visible.sort((a, b) => (selectedScore(b) ?? -1) - (selectedScore(a) ?? -1) || a.index - b.index);
    if (state.sort === 'newest') visible.sort((a, b) => b.date.localeCompare(a.date) || a.index - b.index);
    // 搜索是一次性意图，直接把匹配的给全；普通浏览按页给，一页一屏。
    const total = visible.length;
    const paged = !query && Number.isFinite(state.limit);
    const perPage = paged ? state.limit : total;
    const lastPage = paged ? Math.max(1, Math.ceil(total / perPage)) : 1;
    state.page = Math.min(Math.max(1, state.page), lastPage);
    const start = paged ? (state.page - 1) * perPage : 0;
    const shown = paged ? visible.slice(start, start + perPage) : visible.slice();
    lastVisible = visible.map((film) => film.id);
    const ids = new Set(shown.map((film) => film.id));
    for (const film of films) film.card.hidden = !ids.has(film.id);
    const ordered = [...shown, ...films.filter((film) => !ids.has(film.id))];
    ordered.forEach((film, index) => {
      if (grid.children[index] !== film.card) grid.insertBefore(film.card, grid.children[index] || null);
    });
    const passesOtherFilters = (film) =>
      (!query || film.search.includes(query)) &&
      (state.category === 'all' || film.category === state.category) &&
      (state.genre === 'all' || film.genres.includes(state.genre)) &&
      (state.source === 'all' || film.source === state.source) &&
      (state.access === 'all' || film.access === state.access) &&
      (!state.saved || saved.has(film.id));
    const matchingExceptWatched = state.hideWatched ? films.filter((film) => passesOtherFilters(film) && watchedIds.has(film.id)) : [];
    const hiddenWatched = matchingExceptWatched.length;
    const suffix = state.saved ? '已收藏作品' : '精选作品';
    const range = shown.length ? `第 ${start + 1}–${start + shown.length} 部` : '';
    const catalogue = catalogueTotal();
    const previewOnly = catalogue > total;
    const countText = paged && lastPage > 1
      ? `共 ${total} 部${suffix} · ${range} · 第 ${state.page} / ${lastPage} 页`
      : previewOnly
        ? `共 ${catalogue} 部 · 首页收录 ${total} 部`
        : `${total} 部${suffix}`;
    $('#resultCount').textContent = countText + (state.hideWatched && hiddenWatched ? ` · 已隐藏 ${hiddenWatched} 部已看` : '');
    $('#emptyState').hidden = total !== 0;
    const emptyMembership = $('#emptyMembership');
    if (emptyMembership) emptyMembership.hidden = state.access !== 'paid';
    renderPager(lastPage);
    const loadMore = $('#loadMore');
    if (loadMore) loadMore.hidden = Boolean(query) || state.limit === Infinity;
    if (loadMore && !loadMore.hidden) {
      $('#loadMoreNote').textContent = state.saved
        ? '首页只铺九部，收藏的其它作品在片库里看。'
        : '片库里还能按题材、来源、评分再筛一遍。';
      const link = $('#loadMoreLink');
      if (link) {
        // 收藏筛选在首页只能覆盖九部，完整收藏视图交给片库。
        link.textContent = state.saved ? `去片库看我的收藏（${saved.size} 部）` : `去片库看全部 ${catalogueTotal()} 部`;
        link.href = state.saved ? 'library.html?saved=1' : 'library.html';
      }
    }
    let title = '暂时没有匹配的作品';
    let copy = '试试其他题材，或清除筛选条件。';
    if (state.access === 'paid') {
      title = '付费放映正在筹备';
      copy = '本站尚未开放购票，先从免费原作认识这些创作者。';
    } else if (state.saved && saved.size === 0) {
      title = '还没有收藏的作品';
      copy = '点击作品上的收藏按钮，把想看的好片留在这台设备。';
    } else if (state.saved && total === 0) {
      title = '这九部里没有你的收藏';
      copy = `收藏的 ${saved.size} 部在首页九部之外，去片库能看完整的收藏列表。`;
    } else if (state.hideWatched && total === 0 && hiddenWatched > 0) {
      title = '看过的都标记好了';
      copy = `这批筛选里的 ${hiddenWatched} 部都已看过，已从列表隐藏。切回「显示已看」，或在「我的」页面看观看历史。`;
    } else if (state.rating !== 'all' && films.every((film) => selectedScore(film) === null)) {
      title = state.scoreBasis === 'community' ? '暂无可用的站内评分' : '正式评分还在补充';
      copy = state.scoreBasis === 'community' ? '站内用户评分只统计已发布的访客评分；未评分作品不进入此筛选。' : '当前作品均为待评，完成审核后才会进入评分筛选。';
    } else if (state.source !== 'all' && !films.some((film) => film.source === state.source)) {
      title = '这个来源还没有公开收录';
      copy = '作品核实后会补充到片库，也可以先看看其他来源。';
    }
    $('#emptyTitle').textContent = title;
    $('#emptyCopy').textContent = copy;
    syncSaved();
    syncWatchedBadges();
  }

  // 页码超过 7 个就折成省略号，作品再多翻页条也不会横向撑爆。
  function pageList(current, last) {
    if (last <= 7) return Array.from({ length: last }, (_, index) => index + 1);
    const pages = new Set([1, last, current, current - 1, current + 1]);
    const sorted = [...pages].filter((page) => page >= 1 && page <= last).sort((a, b) => a - b);
    const result = [];
    for (let index = 0; index < sorted.length; index += 1) {
      if (index && sorted[index] - sorted[index - 1] > 1) result.push('…');
      result.push(sorted[index]);
    }
    return result;
  }

  function renderPager(lastPage) {
    const pager = $('#filmPager');
    if (!pager) return;
    if (lastPage <= 1) { pager.innerHTML = ''; pager.hidden = true; return; }
    pager.hidden = false;
    const buttons = [`<button type="button" data-page="${state.page - 1}"${state.page === 1 ? ' disabled' : ''}>上一页</button>`];
    for (const page of pageList(state.page, lastPage)) {
      buttons.push(page === '…'
        ? '<span class="pager-gap" aria-hidden="true">…</span>'
        : `<button type="button" data-page="${page}"${page === state.page ? ' aria-current="page"' : ''}>${page}</button>`);
    }
    buttons.push(`<button type="button" data-page="${state.page + 1}"${state.page === lastPage ? ' disabled' : ''}>下一页</button>`);
    pager.innerHTML = buttons.join('');
  }

  function scrollToList() {
    const anchor = $('.library-controls') || grid;
    anchor.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }

  function applyFilters(resetLimit = true) {
    if (resetLimit && state.limit !== Infinity) state.limit = pageSize();
    state.page = 1;
    syncControls();
    render();
    writeState();
  }

  function viewingSnapshot(film) {
    return {
      title: film.title,
      poster: (film.image.getAttribute('src') || '').split('?')[0],
      author: film.author,
      kind: film.kind,
      source: film.source,
    };
  }

  function recordViewing(film, action) {
    if (window.FramepickViewing) window.FramepickViewing.record(film.id, action, viewingSnapshot(film));
  }

  function resetFilters(access = 'all') {
    state = { ...defaults, access };
    applyFilters();
  }

  function toggleSave(id) {
    const focusedCard = document.activeElement?.closest('#filmGrid [data-film]');
    if (saved.has(id)) saved.delete(id); else saved.add(id);
    if (storageAvailable) {
      try { localStorage.setItem(storageKey, JSON.stringify([...saved])); }
      catch { storageAvailable = false; }
    }
    render();
    if (focusedCard?.hidden) {
      const next = grid.querySelector('[data-film]:not([hidden]) [data-save-film]') || $('#resetFilters');
      next.focus({ preventScroll: true });
    }
    notify(storageAvailable ? (saved.has(id) ? '已收藏，保存在此浏览器' : '已取消收藏') : '收藏仅在本次浏览中保留');
  }

  function syncDialogBody() {
    document.body.classList.toggle('has-dialog', filmDialog.open || membershipDialog.open);
  }

  function closeFilmUI() {
    if (!filmDialog.open) return;
    currentFilm = null;
    window.dispatchEvent(new CustomEvent('framepick:film-close'));
    filmDialog.close();
    document.title = defaultTitle;
    syncDialogBody();
    const target = opener?.isConnected && !opener.closest('[hidden]') ? opener : $('#entriesTitle');
    target.focus({ preventScroll: true });
  }

  function openFilm(id, push = false, trigger = null) {
    const film = lookupFilm(id);
    if (!film) {
      if (trigger) opener = trigger;
      loadCatalogue().then(() => {
        if (lookupFilm(id)) openFilm(id, push, trigger);
        else closeFilmUI();
      });
      return;
    }
    currentFilm = film;
    if (trigger) opener = trigger;
    $('#detailTitle').textContent = film.title;
    const sourceLabel = SOURCE_LABEL[film.source] || '原平台';
    const categoryLabel = CATEGORY_LABEL[film.category] || '作品';
    $('#detailKind').textContent = film.kind + ' / ' + categoryLabel;
    $('#detailAuthor').textContent = film.author + ' / ' + sourceLabel;
    $('#detailEpisode').textContent = film.episode;
    // 连载状态一行：状态 + 体量 + 续集关系，缺哪项就少显示哪项；全缺就整行隐藏。
    const status = $('#detailStatus');
    if (status) {
      const parts = [film.statusLabel, film.volume, film.relation].filter(Boolean);
      status.textContent = parts.length ? parts.join(' · ') : '';
      status.hidden = !parts.length;
    }
    // 原片发布日期：有就显示，没有就整行隐藏（收录日期只在今日更新榜里用，不在这里露）。
    const published = $('#detailPublished');
    if (published) {
      const when = film.published.replace(/-/g, '.');
      published.textContent = when ? '原片发布于 ' + when : '';
      published.hidden = !when;
    }
    $('#detailDescription').textContent = film.description;
    $('#detailReason').textContent = film.reason;
    // 左栏封面之下补一份可核对的作品档案；没有的字段整行隐藏，不留空壳。
    const archive = $('#detailArchive');
    if (archive) {
      const values = {
        author: film.author, runtime: film.runtime, source: sourceLabel,
        kind: film.kind + ' / ' + categoryLabel,
        published: film.published.replace(/-/g, '.'),
        score: film.score === null ? '待评' : film.score.toFixed(1) + ' / 10'
      };
      archive.querySelectorAll('[data-archive-row]').forEach((row) => {
        const value = values[row.dataset.archiveRow] || '';
        row.hidden = !value;
        const dd = row.querySelector('dd');
        if (dd) dd.textContent = value;
      });
      archive.hidden = false;
    }
    // 详情图优先换 1280w 大图（列表缩略图只有 640w，放大发虚）；没有大图的片就留缩略图。
    // 预载成功才换 src，避免加载期间闪空白；缩略图的宽高属性让浏览器按原比例占位，不跳版。
    const detailImage = $('#detailImage');
    // 左栏封面按原比例完整显示，右栏更高时下面会空出一块。拿同一张图放大模糊垫在背后，
    // 那块就不再是死黑的空白（裁成 object-fit:cover 会把海报两侧的片名字吃掉，不裁）。
    const detailCover = detailImage.closest('.detail-cover');
    const setCoverArt = (url) => {
      if (detailCover && url) detailCover.style.setProperty('--cover', `url("${url}")`);
    };
    detailImage.src = coverOf(film.image);
    setCoverArt(detailImage.src);
    detailImage.alt = film.image.alt;
    detailImage.setAttribute('width', film.image.getAttribute('width') || '');
    detailImage.setAttribute('height', film.image.getAttribute('height') || '');
    const large = new Image();
    large.onload = () => {
      if (currentFilm !== film) return;
      detailImage.src = large.src;
      setCoverArt(large.src);
    };
    large.src = coverOf(film.image).replace('-640w.webp', '-1280w.webp');
    const watch = $('#detailWatch');
    watch.href = film.link;
    watch.dataset.outboundFilm = film.id;
    watch.textContent = '前往' + sourceLabel + '观看';
    watch.insertAdjacentHTML('beforeend', '<svg aria-hidden="true"><use href="#arrow"/></svg>');
    $('#detailScore').textContent = film.score === null ? '编辑评分：待评。完成审核后公开，不计入评分榜单。' : '编辑评分：' + film.score.toFixed(1) + ' / 10';
    syncSaved();
    syncDetailWatchedButton(film);
    recordViewing(film, 'open');
    if (push) {
      const url = new URL(location.href);
      url.searchParams.set('film', id);
      try { history.pushState({ framepickFilm: true }, '', url); } catch { /* details still work without URL history */ }
    }
    if (!filmDialog.open) filmDialog.showModal();
    document.title = film.title + ' — ' + defaultTitle;
    syncDialogBody();
    window.dispatchEvent(new CustomEvent('framepick:film-open', { detail: { id: film.id, title: film.title, link: film.link, score: film.score } }));
  }

  function requestCloseFilm() {
    if (history.state?.framepickFilm && new URL(location.href).searchParams.has('film')) {
      history.back();
    } else {
      const url = new URL(location.href);
      url.searchParams.delete('film');
      try { history.replaceState({}, '', url); } catch { /* file viewers may restrict history */ }
      closeFilmUI();
    }
  }

  function syncFromURL() {
    readState();
    syncControls();
    render();
    const id = new URL(location.href).searchParams.get('film');
    if (!id) { closeFilmUI(); return; }
    if (!lookupFilm(id)) { loadCatalogue().then(() => openFilm(id)); return; }
    // 深链进来的作品可能排在别的页，先翻到它那一页再打开。
    const target = byId.get(id);
    if (target && target.card && target.card.hidden && Number.isFinite(state.limit) && !state.q.trim()) {
      const index = lastVisible.indexOf(id);
      if (index >= 0) { state.page = Math.floor(index / state.limit) + 1; render(); }
    }
    openFilm(id);
  }

  for (const [key, control] of Object.entries(controls)) {
    control.addEventListener(key === 'q' ? 'input' : 'change', () => {
      state[key] = control.value;
      applyFilters();
    });
  }
  for (const button of categories) button.addEventListener('click', () => {
    state.category = button.dataset.category;
    applyFilters();
  });
  const filmPager = $('#filmPager');
  if (filmPager) filmPager.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-page]');
    if (!button || button.disabled) return;
    state.page = Number(button.dataset.page);
    render();
    writeState();
    scrollToList();
  });
  // 跨过手机／桌面断点时每页数量变了，回到第一页重排，免得停在越界页。
  matchMedia(PAGE_QUERY).addEventListener('change', () => {
    if (state.limit === Infinity) return;
    state.limit = pageSize();
    state.page = 1;
    render();
  });
  $('#savedToggle').addEventListener('click', () => {
    state.saved = !state.saved;
    applyFilters();
    $('#entries').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  });
  $('#resetFilters').addEventListener('click', () => {
    resetFilters();
    $('#filmSearch').focus({ preventScroll: true });
  });
  for (const trigger of document.querySelectorAll('[data-open-film]')) {
    trigger.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
      event.preventDefault();
      openFilm(trigger.dataset.openFilm, true, trigger);
    });
  }
  for (const button of document.querySelectorAll('[data-save-film]')) button.addEventListener('click', () => toggleSave(button.dataset.saveFilm));
  $('#detailSave').addEventListener('click', () => { if (currentFilm) toggleSave(currentFilm.id); });
  const detailWatchedButton = $('#detailWatched');
  if (detailWatchedButton) detailWatchedButton.addEventListener('click', () => {
    if (!currentFilm || !window.FramepickViewing) return;
    if (window.FramepickViewing.isWatched(currentFilm.id)) {
      window.FramepickViewing.unmarkWatched(currentFilm.id);
      notify('已取消已看标记');
    } else {
      window.FramepickViewing.markWatched(currentFilm.id, viewingSnapshot(currentFilm));
      notify('已标记为看过，默认从片库隐藏');
    }
  });
  $('#detailWatch').addEventListener('click', () => { if (currentFilm) recordViewing(currentFilm, 'watch'); });
  const hideWatchedToggle = $('#hideWatchedToggle');
  if (hideWatchedToggle) hideWatchedToggle.addEventListener('click', () => {
    state.hideWatched = !state.hideWatched;
    applyFilters();
  });
  // 首页只铺一屏，完整列表交给 library.html，不再堆在主页上。

  $('[data-close-film]').addEventListener('click', requestCloseFilm);
  filmDialog.addEventListener('cancel', (event) => { event.preventDefault(); requestCloseFilm(); });
  filmDialog.addEventListener('click', (event) => { if (event.target === filmDialog) {
    const rect = filmDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) requestCloseFilm();
  } });
  for (const button of document.querySelectorAll('[data-membership]')) button.addEventListener('click', () => { membershipDialog.showModal(); syncDialogBody(); });
  $('[data-close-membership]').addEventListener('click', () => membershipDialog.close());
  membershipDialog.addEventListener('close', syncDialogBody);
  membershipDialog.addEventListener('click', (event) => { if (event.target === membershipDialog) {
    const rect = membershipDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) membershipDialog.close();
  } });
  $('#browseFree').addEventListener('click', () => resetFilters('free'));
  $('#memberBrowse').addEventListener('click', () => { membershipDialog.close(); resetFilters('free'); });
  window.addEventListener('popstate', syncFromURL);
  window.addEventListener('framepick:request-film', ({ detail }) => openFilm(detail.id, true, detail.trigger));
  // The independent review client supplies shared aggregates; editor scores stay intact.
  for (const film of films) {
    const summary = document.createElement('p');
    summary.className = 'community-score';
    summary.textContent = '站内评分 · 暂未连接';
    film.card.querySelector('.card-topline').after(summary);
  }
  // Watched badges ride on the card media, injected once; visibility follows render().
  for (const film of films) {
    const badge = document.createElement('span');
    badge.className = 'watched-badge';
    badge.hidden = true;
    badge.textContent = '已看';
    film.card.querySelector('.card-media').append(badge);
  }
  // Viewing records (watched flags) come from a separate module; re-render on change.
  window.addEventListener('framepick:viewing', () => render());
  window.addEventListener('framepick:review-summary', ({ detail }) => {
    const summaries = new Map((detail.films || []).map((item) => [item.filmId, item]));
    for (const film of films) {
      const entry = summaries.get(film.id);
      film.communityScore = detail.available && entry && Number.isFinite(entry.averageRating) && entry.averageRating >= 1 && entry.averageRating <= 10 && entry.ratingCount > 0 ? entry.averageRating : null;
      film.card.querySelector('.community-score').textContent = !detail.available || !entry ? '站内评分 · 暂未连接' : film.communityScore === null ? '站内评分 · 暂无评分' : '站内 ' + film.communityScore.toFixed(1) + ' / 10 · ' + entry.ratingCount + ' 人评分';
    }
    render();
  });
  for (const film of films) if (film.score !== null) {
    film.card.querySelector('.score').textContent = film.score.toFixed(1);
    film.card.querySelector('.score').setAttribute('aria-label', '编辑评分：' + film.score.toFixed(1) + '分');
  }
  // 首屏轮播：只靠 transform + 定时器，不引库。标记在 static HTML 里，这里只负责换页。
  function initHeroCarousel() {
    const hero = $('#heroCarousel');
    const track = hero && hero.querySelector('.hero-track');
    if (!track) return;
    const real = [...track.children];
    if (real.length < 2) return;
    // 无限循环：末尾挂一张第一张的副本。走到副本时看不出换页，下一拍再无声地跳回真的第一张，
    // 于是永远朝同一个方向走，不会像原来那样从最后一张倒着滑回开头。
    const edge = real.length;
    const clone = real[0].cloneNode(true);
    clone.classList.add('is-clone');
    clone.setAttribute('aria-hidden', 'true');
    clone.setAttribute('inert', '');
    // 副本只负责画面：不带打开详情的钩子，也不会被算成一次离站点击。
    for (const node of clone.querySelectorAll('[data-open-film], [data-outbound-film]')) {
      node.removeAttribute('data-open-film');
      node.removeAttribute('data-outbound-film');
    }
    for (const node of clone.querySelectorAll('img')) node.removeAttribute('fetchpriority');
    track.append(clone);

    const slides = [...track.children];
    const count = real.length;
    const dots = [...hero.querySelectorAll('[data-hero-dot]')];
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const AUTOPLAY_MS = 7000;
    let index = 0;
    let timer = 0;
    // 停在副本上时，读者看到的其实是第一张，无障碍和圆点都按第一张算。
    const shown = () => (index === edge ? 0 : index);

    const sync = () => {
      const visible = shown();
      slides.forEach((slide, i) => {
        const active = i === visible;
        slide.classList.toggle('is-active', active);
        // 副本永远留在无障碍树外，它的内容在第一张里已经有一份。
        if (i === edge) return;
        if (active) { slide.removeAttribute('inert'); slide.removeAttribute('aria-hidden'); }
        else { slide.setAttribute('inert', ''); slide.setAttribute('aria-hidden', 'true'); }
      });
    };
    const syncDots = () => {
      const visible = shown();
      dots.forEach((dot, i) => {
        if (i === visible) dot.setAttribute('aria-current', 'true');
        else dot.removeAttribute('aria-current');
      });
    };
    // 提前把下一张的封面要下来：切过去的那一刻不该是空框。
    const warm = (i) => {
      const img = slides[i] && slides[i].querySelector('img');
      if (img && img.loading === 'lazy') img.loading = 'eager';
    };
    const paint = (animate = true) => {
      if (animate) {
        track.style.transform = 'translate3d(' + -index * 100 + '%,0,0)';
      } else {
        track.style.transition = 'none';
        track.style.transform = 'translate3d(' + -index * 100 + '%,0,0)';
        // 强制回流，下一次改 transform 才仍然会走过渡。
        void track.offsetWidth;
        track.style.transition = '';
      }
      sync();
      syncDots();
      warm((shown() + 1) % count);
    };
    const jump = (target) => { index = target; paint(false); };
    // 前进：正常加一；已经在副本上就先无痕回到第一张，再往前走一步。
    const forward = () => {
      if (index === edge) jump(0);
      index += 1;
      paint();
    };
    // 后退：在第一张时先无痕挪到副本（画面一样），再往左滑出最后一张。
    const back = () => {
      if (index === 0) jump(edge);
      index -= 1;
      paint();
    };
    const goTo = (target) => {
      if (index === edge) jump(0);
      if (target === index) return;
      index = target;
      paint();
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = 0; } };
    const start = () => {
      stop();
      if (reduce.matches || document.hidden) return;
      timer = setInterval(forward, AUTOPLAY_MS);
    };
    // 手点／按键之后重新计时，免得刚切过去两秒又被自动换走。
    const step = (delta) => { if (delta > 0) forward(); else back(); start(); };

    const prev = hero.querySelector('[data-hero-prev]');
    const next = hero.querySelector('[data-hero-next]');
    if (prev) prev.addEventListener('click', () => step(-1));
    if (next) next.addEventListener('click', () => step(1));
    dots.forEach((dot, i) => dot.addEventListener('click', () => { goTo(i); start(); }));
    hero.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
    });
    // 手机上人人都会先横向划一下：横划换页，竖向仍然交给页面滚动。
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let swallowClick = 0;
    track.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      startX = event.clientX;
      startY = event.clientY;
      dragging = true;
    });
    track.addEventListener('pointercancel', () => { dragging = false; });
    track.addEventListener('pointerup', (event) => {
      if (!dragging) return;
      dragging = false;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      // 划完不要顺带点开详情：把紧随其后的那次 click 吞掉。
      swallowClick = 1;
      setTimeout(() => { swallowClick = 0; }, 400);
      step(dx < 0 ? 1 : -1);
    }, true);
    track.addEventListener('click', (event) => {
      if (!swallowClick) return;
      swallowClick = 0;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    // 鼠标停在大图上、键盘焦点落在控件里都先暂停，别在人正看的时候换页。
    hero.addEventListener('mouseenter', stop);
    hero.addEventListener('mouseleave', start);
    hero.addEventListener('focusin', stop);
    hero.addEventListener('focusout', (event) => { if (!hero.contains(event.relatedTarget)) start(); });
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    if (reduce.addEventListener) reduce.addEventListener('change', start);

    paint(false);
    start();
  }

  initHeroCarousel();
  document.documentElement.classList.add('js');
  syncFromURL();
  window.dispatchEvent(new CustomEvent('framepick:catalogue-ready'));
})();

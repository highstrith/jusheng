// 片库页：读 films-data.js，做筛选、排序和分页。
// 首页只铺一屏精选，完整列表在这里；数据由 scripts/build-framepick-library.mjs 生成。
(function () {
  const films = Array.isArray(window.FRAMEPICK_FILMS) ? window.FRAMEPICK_FILMS : [];
  const grid = document.getElementById('libGrid');
  const pager = document.getElementById('libPager');
  const pagerTop = document.getElementById('libPagerTop');
  const count = document.getElementById('libCount');
  const empty = document.getElementById('libEmpty');
  const meta = document.getElementById('libMeta');
  const tabs = document.getElementById('libTabs');
  const note = document.getElementById('libNote');
  const perSelect = document.getElementById('libPer');
  const perCustom = document.getElementById('libPerCustom');
  if (!grid) return;

  // 一页一屏：手机 6 部、桌面 12 部，翻页条上下各一条，不用滚到底才看得到页码。
  // 「每页」下拉可以自己定（预设或自定义数字）；定了就不再跟着屏幕断点变，选「自动」才交回屏幕。
  const PAGE_QUERY = '(max-width: 760px)';
  const PER_CHOICES = ['auto', '12', '24', '48', 'all', 'custom'];
  const PER_MIN = 1;
  const PER_MAX = 200;
  function autoPer() { return matchMedia(PAGE_QUERY).matches ? 6 : 12; }
  function clampPer(value) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number < PER_MIN) return null;
    return Math.min(number, PER_MAX);
  }
  function perPage() {
    if (state.per === 'all') return Number.MAX_SAFE_INTEGER;
    if (state.per === 'custom') return clampPer(state.perCustom) || autoPer();
    return clampPer(state.per) || autoPer();
  }
  const GENRE_LABELS = { fantasy: '奇幻', scifi: '科幻', wuxia: '武侠', xianxia: '仙侠', urban: '都市', romance: '情感', healing: '治愈', thriller: '悬疑' };
  const SOURCE_LABELS = { xiaohongshu: '小红书', douyin: '抖音', bilibili: '哔哩哔哩', youtube: 'YouTube', x: 'X' };
  const CATEGORY_LABELS = { film: '完整电影', series: '系列短剧', short: '剧情短片', ad: '商业广告', music: '音乐影像', experimental: '实验影像' };

  const state = { q: '', genre: 'all', source: 'all', category: 'all', sort: 'curated', page: 1, per: 'auto', perCustom: '', saved: false };

  // 收藏只存在这台浏览器。片库是唯一能让「我的收藏」覆盖全部作品的地方，
  // 首页只铺九部，筛不全。
  const SAVED_KEY = 'framepick:saved:v1';
  const saved = (() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
      return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
    } catch { return new Set(); }
  })();

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // 下拉和自定义数字框是同一件事的两半：只有选「自定义…」时才把输入框露出来。
  function syncPer(value) {
    if (!perSelect) return;
    perSelect.value = PER_CHOICES.includes(value) ? value : 'auto';
    const custom = perSelect.value === 'custom';
    if (!perCustom) return;
    perCustom.hidden = !custom;
    if (custom && document.activeElement !== perCustom) {
      perCustom.value = String(clampPer(state.perCustom) || autoPer());
    }
  }

  const seconds = (runtime) => {
    const parts = String(runtime || '').split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
  };

  function buildTabs() {
    const totals = new Map();
    for (const film of films) totals.set(film.category, (totals.get(film.category) || 0) + 1);
    const items = [['all', '全部作品', films.length]];
    for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
      const total = totals.get(key) || 0;
      if (total) items.push([key, label, total]);
    }
    tabs.innerHTML = items.map(([key, label, total]) =>
      `<button type="button" data-category="${key}" aria-pressed="${key === state.category}">${label} <span>${total}</span></button>`
    ).join('');
    tabs.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-category]');
      if (!button) return;
      state.category = button.dataset.category;
      state.page = 1;
      for (const node of tabs.querySelectorAll('button')) node.setAttribute('aria-pressed', String(node === button));
      render();
    });
  }

  function buildOptions() {
    const genres = [...new Set(films.flatMap((film) => film.genres))].filter((genre) => GENRE_LABELS[genre]);
    document.getElementById('libGenre').insertAdjacentHTML('beforeend',
      genres.map((genre) => `<option value="${esc(genre)}">${esc(GENRE_LABELS[genre])}</option>`).join(''));
    const sources = [...new Set(films.map((film) => film.source))].filter((source) => SOURCE_LABELS[source]);
    document.getElementById('libSource').insertAdjacentHTML('beforeend',
      sources.map((source) => `<option value="${esc(source)}">${esc(SOURCE_LABELS[source])}</option>`).join(''));
  }

  function card(film, index) {
    const titleId = `libTitle${state.page}-${index}`;
    const status = film.statusLabel
      ? `<span class="status-tag" data-completion="${esc(film.completion)}">${esc(film.statusLabel)}</span>` : '';
    return `<article class="card" data-film="${esc(film.id)}" aria-labelledby="${titleId}">
        <a class="card-media" href="${esc(film.sourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="前往${esc(film.sourceLabel)}观看《${esc(film.title)}》"><img src="${esc(film.cover)}" width="${film.coverWidth}" height="${film.coverHeight}" alt="${esc(film.coverAlt)}" loading="lazy" decoding="async"><span class="access-badge">${esc(film.badge)}</span></a>
        <div class="card-body"><div class="card-topline"><span class="kind">${esc(film.kind)}</span><span class="card-runtime">${esc(film.runtime)}</span>${status}<span class="score" aria-label="编辑评分：${esc(film.scoreText)}">${esc(film.scoreText)}</span></div><h3 id="${titleId}">${esc(film.title)}</h3><p class="film-author"><span class="author-name">${esc(film.author)}</span><span class="source-name">${esc(film.sourceLabel)}</span></p><p class="desc">${esc(film.description)}</p><div class="card-actions"><a class="watch" href="${esc(film.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(film.watchLabel)}<svg aria-hidden="true"><use href="#arrow"/></svg></a></div></div>
      </article>`;
  }

  // 页码超过 7 个时折成省略号，避免作品变多后翻页条横向撑爆。
  // 超过 7 页就固定给七个位置：翻页时页码条不伸长也不缩短，下面的内容不会跟着跳。
  function pageList(current, last) {
    if (last <= 7) return Array.from({ length: last }, (_, index) => index + 1);
    if (current <= 4) return [1, 2, 3, 4, 5, '…', last];
    if (current >= last - 3) return [1, '…', last - 4, last - 3, last - 2, last - 1, last];
    return [1, '…', current - 1, current, current + 1, '…', last];
  }

  const stepButton = (page, disabled, label, path) => `<button type="button" class="pager-step" data-page="${page}"${disabled ? ' disabled' : ''} aria-label="${label}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="${path}"/></svg><span>${label}</span></button>`;

  function renderPager(lastPage) {
    if (lastPage <= 1) { pager.innerHTML = ''; if (pagerTop) pagerTop.innerHTML = ''; return; }
    const buttons = [stepButton(state.page - 1, state.page === 1, '上一页', 'm15 5-7 7 7 7')];
    for (const page of pageList(state.page, lastPage)) {
      buttons.push(page === '…'
        ? '<span class="pager-gap" aria-hidden="true">…</span>'
        : `<button type="button" data-page="${page}"${page === state.page ? ' aria-current="page"' : ''}>${page}</button>`);
    }
    // 窄屏放不下七个页码时只留「第 x / y 页」，所以它夹在两个箭头中间。
    buttons.push(`<span class="pager-status">第 ${state.page} / ${lastPage} 页</span>`);
    buttons.push(stepButton(state.page + 1, state.page === lastPage, '下一页', 'm9 5 7 7-7 7'));
    const markup = buttons.join('');
    pager.innerHTML = markup;
    if (pagerTop) pagerTop.innerHTML = markup;
  }

  function render() {
    const query = state.q.trim().toLocaleLowerCase();
    let visible = films.filter((film) => {
      const haystack = `${film.title} ${film.author} ${film.kind} ${film.description} ${film.recommendation}`.toLocaleLowerCase();
      return (!query || haystack.includes(query))
        && (state.category === 'all' || film.category === state.category)
        && (state.genre === 'all' || film.genres.includes(state.genre))
        && (state.source === 'all' || film.source === state.source)
        && (!state.saved || saved.has(film.id));
    });
    if (state.sort === 'newest') visible = [...visible].sort((a, b) => String(b.intakeDate).localeCompare(String(a.intakeDate)));
    if (state.sort === 'longest') visible = [...visible].sort((a, b) => seconds(b.runtime) - seconds(a.runtime));

    const size = perPage();
    // 「自动」后面跟着当前实际的部数，免得读者猜自动到底是几部。
    const autoOption = perSelect && perSelect.querySelector('option[value="auto"]');
    if (autoOption) autoOption.textContent = `自动（${autoPer()} 部）`;
    syncPer(state.per);
    const lastPage = Math.max(1, Math.ceil(visible.length / size));
    if (state.page > lastPage) state.page = lastPage;
    const start = (state.page - 1) * size;
    const pageFilms = visible.slice(start, start + size);

    grid.innerHTML = pageFilms.map(card).join('');
    empty.hidden = visible.length !== 0;
    renderPager(lastPage);

    const range = visible.length
      ? `第 ${start + 1}–${start + pageFilms.length} 部，共 ${visible.length} 部`
      : '没有匹配的作品';
    count.textContent = (state.saved ? '我的收藏：' : '') + range
      + (visible.length > size ? ` · 第 ${state.page} / ${lastPage} 页` : '');
    note.innerHTML = state.saved
      ? `只看这台浏览器收藏的作品 · <a href="library.html">看全部 ${films.length} 部</a>`
      : `已收录 ${films.length} 部 · 正式评分陆续补充`;
    meta.textContent = state.saved
      ? `我的收藏 · 共 ${saved.size} 部 · 只在此浏览器`
      : `共 ${films.length} 部 · 每周更新`;
    empty.textContent = state.saved
      ? (saved.size
        ? '收藏的作品都不符合当前条件，换个筛选项，或看全部作品。'
        : '这台浏览器还没有收藏。在首页或片库的作品卡片上点书签，收藏会出现在这里。')
      : '没有匹配的作品，换个条件试试。';
  }

  function bind() {
    const search = document.getElementById('libSearch');
    search.addEventListener('input', () => { state.q = search.value; state.page = 1; render(); });
    for (const [id, key] of [['libGenre', 'genre'], ['libSource', 'source'], ['libSort', 'sort']]) {
      const control = document.getElementById(id);
      control.addEventListener('change', () => { state[key] = control.value; state.page = 1; render(); });
    }
    if (perSelect) perSelect.addEventListener('change', () => {
      const value = PER_CHOICES.includes(perSelect.value) ? perSelect.value : 'auto';
      state.per = value;
      // 每页数量变了，页码要回第一页，不然会停在越界页上看空。
      state.page = 1;
      if (value === 'custom') state.perCustom = clampPer(state.perCustom) || perPage();
      render();
      if (value === 'custom' && perCustom) { perCustom.focus(); perCustom.select(); }
    });
    if (perCustom) {
      // 自定义数字：回车或失焦时生效，越界夹到 1–200，填不出合法数字就退回原来的值。
      const applyCustom = () => {
        // 读者可能刚把下拉切回预设，这时补上来的 blur/change 不算数，否则会把选择又拽回「自定义」。
        if (perSelect && perSelect.value !== 'custom') return;
        const value = clampPer(perCustom.value);
        if (value === null) {
          perCustom.value = String(clampPer(state.perCustom) || autoPer());
          return;
        }
        // 把夹过的值写回输入框：填 999 就该看到 200，而不是留在 999 上骗人。
        perCustom.value = String(value);
        state.per = 'custom';
        state.perCustom = value;
        state.page = 1;
        render();
      };
      perCustom.addEventListener('change', applyCustom);
      perCustom.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); applyCustom(); }
      });
    }
    pager.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-page]');
      if (!button || button.disabled) return;
      state.page = Number(button.dataset.page);
      render();
      count.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    });
    if (pagerTop) pagerTop.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-page]');
      if (!button || button.disabled) return;
      state.page = Number(button.dataset.page);
      render();
      count.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    });
  }

  if (!films.length) {
    grid.innerHTML = '';
    count.textContent = '作品表还没生成';
    meta.textContent = '';
    empty.hidden = false;
    empty.textContent = '作品数据缺失，请先运行 scripts/build-framepick-library.mjs 重新生成。';
    return;
  }

  buildTabs();
  buildOptions();
  bind();
  render();

  // URL 里的筛选条件可以直接带进来，方便分享某类片单或某一页。
  const params = new URL(location.href).searchParams;
  const rawPer = params.get('per');
  // ?per= 认三种写法：预设（12/24/48/all）、任意数字（自定义）、不认识的退回自动。
  const customPer = clampPer(rawPer);
  const presetPer = rawPer === 'all' ? 'all'
    : ['12', '24', '48'].includes(rawPer) ? rawPer
      : customPer ? 'custom' : 'auto';
  const preset = { q: params.get('q') || '', genre: params.get('genre') || 'all', source: params.get('source') || 'all', category: params.get('category') || 'all', per: presetPer, saved: params.get('saved') === '1' };
  const presetPage = Number(params.get('page'));
  const page = Number.isFinite(presetPage) && presetPage >= 1 ? Math.floor(presetPage) : 1;
  if (preset.q || preset.genre !== 'all' || preset.source !== 'all' || preset.category !== 'all' || preset.per !== 'auto' || preset.saved || page > 1) {
    Object.assign(state, preset, { page });
    if (presetPer === 'custom') state.perCustom = customPer;
    document.getElementById('libSearch').value = preset.q;
    document.getElementById('libGenre').value = preset.genre;
    document.getElementById('libSource').value = preset.source;
    syncPer(preset.per);
    for (const node of tabs.querySelectorAll('button')) node.setAttribute('aria-pressed', String(node.dataset.category === preset.category));
    if (preset.saved) document.getElementById('libTitle').textContent = '我的收藏';
    render();
  }

  // 跨过手机／桌面断点时每页数量变了，回到第一页重排。自己定过每页几部就不受断点影响。
  matchMedia(PAGE_QUERY).addEventListener('change', () => { if (state.per !== 'auto') return; state.page = 1; render(); });
})();

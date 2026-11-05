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
  if (!grid) return;

  // 一页一屏：手机 6 部、桌面 12 部，翻页条上下各一条，不用滚到底才看得到页码。
  const PAGE_QUERY = '(max-width: 760px)';
  function perPage() { return matchMedia(PAGE_QUERY).matches ? 6 : 12; }
  const GENRE_LABELS = { fantasy: '奇幻', scifi: '科幻', wuxia: '武侠', xianxia: '仙侠', urban: '都市', romance: '情感', healing: '治愈', thriller: '悬疑' };
  const SOURCE_LABELS = { xiaohongshu: '小红书', douyin: '抖音', bilibili: '哔哩哔哩', youtube: 'YouTube', x: 'X' };
  const CATEGORY_LABELS = { film: '完整电影', series: '系列短剧', short: '剧情短片', ad: '商业广告', music: '音乐影像', experimental: '实验影像' };

  const state = { q: '', genre: 'all', source: 'all', category: 'all', sort: 'curated', page: 1 };

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
    if (lastPage <= 1) { pager.innerHTML = ''; if (pagerTop) pagerTop.innerHTML = ''; return; }
    const buttons = [`<button type="button" data-page="${state.page - 1}"${state.page === 1 ? ' disabled' : ''}>上一页</button>`];
    for (const page of pageList(state.page, lastPage)) {
      buttons.push(page === '…'
        ? '<span class="pager-gap" aria-hidden="true">…</span>'
        : `<button type="button" data-page="${page}"${page === state.page ? ' aria-current="page"' : ''}>${page}</button>`);
    }
    buttons.push(`<button type="button" data-page="${state.page + 1}"${state.page === lastPage ? ' disabled' : ''}>下一页</button>`);
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
        && (state.source === 'all' || film.source === state.source);
    });
    if (state.sort === 'newest') visible = [...visible].sort((a, b) => String(b.intakeDate).localeCompare(String(a.intakeDate)));
    if (state.sort === 'longest') visible = [...visible].sort((a, b) => seconds(b.runtime) - seconds(a.runtime));

    const size = perPage();
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
    count.textContent = range + (visible.length > size ? ` · 第 ${state.page} / ${lastPage} 页` : '');
    note.textContent = `已收录 ${films.length} 部 · 正式评分陆续补充`;
    meta.textContent = `共 ${films.length} 部 · 每周更新`;
  }

  function bind() {
    const search = document.getElementById('libSearch');
    search.addEventListener('input', () => { state.q = search.value; state.page = 1; render(); });
    for (const [id, key] of [['libGenre', 'genre'], ['libSource', 'source'], ['libSort', 'sort']]) {
      const control = document.getElementById(id);
      control.addEventListener('change', () => { state[key] = control.value; state.page = 1; render(); });
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
  const preset = { q: params.get('q') || '', genre: params.get('genre') || 'all', source: params.get('source') || 'all', category: params.get('category') || 'all' };
  const presetPage = Number(params.get('page'));
  const page = Number.isFinite(presetPage) && presetPage >= 1 ? Math.floor(presetPage) : 1;
  if (preset.q || preset.genre !== 'all' || preset.source !== 'all' || preset.category !== 'all' || page > 1) {
    Object.assign(state, preset, { page });
    document.getElementById('libSearch').value = preset.q;
    document.getElementById('libGenre').value = preset.genre;
    document.getElementById('libSource').value = preset.source;
    for (const node of tabs.querySelectorAll('button')) node.setAttribute('aria-pressed', String(node.dataset.category === preset.category));
    render();
  }

  // 跨过手机／桌面断点时每页数量变了，回到第一页重排。
  matchMedia(PAGE_QUERY).addEventListener('change', () => { state.page = 1; render(); });
})();

(() => {
  'use strict';
  const root = document.querySelector('#rankings');
  if (!root) return;
  const $ = (selector) => root.querySelector(selector);
  let films = [];
  let latestSummary = null;
  let latestOutbound = null;
  const dayMs = 86400000;
  // 每日更新榜最多列几条；超出部分用一句话指向片库，不把这一栏拉成独苗长条。
  const DAILY_LIMIT = 8;
  const futureSkewMs = 60000; // Permit small server/browser clock differences.
  const chinaDay = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const shortDay = (day) => day.slice(5).replace('-', '.');
  const validDay = (day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;

  function renderList(board, entries, limit = 10) {
    const list = $(board + ' .ranking-list');
    const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.rankingFilm : null;
    const existing = new Map([...list.children].map((item) => [item.querySelector('[data-ranking-film]').dataset.rankingFilm, item]));
    list.replaceChildren(...entries.slice(0, limit).map(({ film, label }, index) => {
      const previous = existing.get(film.id);
      if (previous) {
        previous.querySelector('.ranking-position').textContent = String(index + 1).padStart(2, '0');
        previous.querySelector('.ranking-film-info > span').textContent = label;
        return previous;
      }
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = film.link;
      link.dataset.rankingFilm = film.id;
      link.className = 'ranking-film';
      const rank = document.createElement('span');
      rank.className = 'ranking-position';
      rank.textContent = String(index + 1).padStart(2, '0');
      rank.setAttribute('aria-hidden', 'true');
      const image = document.createElement('img');
      image.src = film.image;
      image.alt = '';
      image.width = 64;
      image.height = 50;
      image.loading = 'lazy';
      const info = document.createElement('span');
      info.className = 'ranking-film-info';
      const title = document.createElement('strong');
      title.textContent = film.title;
      const meta = document.createElement('span');
      meta.textContent = label;
      info.append(title, meta);
      link.append(rank, image, info);
      item.append(link);
      return item;
    }));
    if (focusedId) {
      const next = [...list.querySelectorAll('[data-ranking-film]')].find((link) => link.dataset.rankingFilm === focusedId);
      (next || $('#rankingsTitle')).focus({ preventScroll: true });
    }
  }

  // 今日更新：只列今天收录的作品，条目上不出现任何日期（收录日期仅用于分组）。
  // 三栏里只有一栏有内容时，那栏独占整行、条目分两列排，空的两栏并排退到下一行——
  // 否则页面就是左边一根长条、右边两片空白，看着像坏了。
  const columns = root.querySelector('.ranking-columns');
  function syncLayout() {
    if (!columns) return;
    const populated = ['#rankingDaily', '#rankingPopular', '#rankingAcclaimed']
      .map((selector) => root.querySelector(selector))
      .filter((board) => board && board.querySelectorAll('[data-ranking-film]').length > 0);
    columns.classList.toggle('is-single', populated.length === 1);
  }

  function renderDaily() {
    const today = chinaDay();
    const entries = films.filter((film) => film.date === today);
    $('#dailyRankingStatus').textContent = entries.length
      ? '今日新收录 ' + entries.length + ' 部'
      : '今日暂无新收录。';
    // 一天收录十几部时，全塞进这一栏会把它拉成一根长条，旁边两栏却是空的。
    // 榜单只给前 8 条，剩下的如实说明并指向下方片库，不藏数字。
    const shown = entries.slice(0, DAILY_LIMIT);
    renderList('#rankingDaily', shown.map((film) => ({ film, label: film.runtime })), Infinity);
    const more = $('#dailyRankingMore');
    if (!more) return;
    const extra = entries.length - shown.length;
    more.textContent = extra > 0 ? `今日共 ${entries.length} 部，其余 ${extra} 部见下方片库。` : '';
    more.hidden = extra <= 0;
    syncLayout();
  }

  function renderPopular(data) {
    if (!data?.available) {
      $('#popularRankingStatus').textContent = data?.configured ? '共享跳转统计暂不可用，连接后恢复榜单。' : '共享跳转统计尚未配置，暂不能显示热门排名。';
      renderList('#rankingPopular', []);
      syncLayout();
      return;
    }
    const today = chinaDay();
    const start = new Date(Date.parse(today) - 9 * dayMs).toISOString().slice(0, 10);
    const seen = new Set();
    const updated = Date.parse(data.updatedAt);
    const valid = data.metric === 'outbound-clicks' && data.windowStart === start && data.windowEnd === today && Number.isFinite(updated) && updated <= Date.now() + futureSkewMs && Date.now() - updated < dayMs && Array.isArray(data.films) && data.films.every((entry) => {
      if (!entry || typeof entry.filmId !== 'string' || seen.has(entry.filmId) || !Number.isSafeInteger(entry.outboundClicks) || entry.outboundClicks < 0) return false;
      seen.add(entry.filmId);
      return true;
    });
    if (!valid) {
      $('#popularRankingStatus').textContent = '当前统计数据暂不可用，更新后恢复榜单。';
      renderList('#rankingPopular', []);
      syncLayout();
      return;
    }
    const counts = new Map(data.films.map((entry) => [entry.filmId, entry.outboundClicks]));
    const entries = films.filter((film) => (counts.get(film.id) || 0) > 0).sort((a, b) => counts.get(b.id) - counts.get(a.id) || a.index - b.index);
    $('#popularRankingStatus').textContent = shortDay(start) + '–' + shortDay(today) + (entries.length ? ' · 本站原作跳转' : ' · 暂无原作跳转，观看后更新');
    renderList('#rankingPopular', entries.map((film) => ({ film, label: counts.get(film.id).toLocaleString('zh-CN') + ' 次原作跳转' })));
    syncLayout();
  }

  window.addEventListener('framepick:catalogue-ready', () => {
    films = [...document.querySelectorAll('#filmGrid [data-film]')].map((card, index) => ({
      id: card.dataset.film, date: card.dataset.date, index,
      title: card.querySelector('h3').textContent.trim(), image: card.querySelector('img').src,
      link: card.querySelector('.watch').href, runtime: card.querySelector('.card-runtime')?.textContent.trim() || '时长待核实'
    }));
    renderDaily();
    renderPopular(latestOutbound);
    if (latestSummary) renderAcclaimed(latestSummary);
  });

  function renderAcclaimed(detail) {
    const summaries = new Map((detail.films || []).map((entry) => [entry.filmId, entry]));
    const entries = detail.available ? films.map((film) => ({ film, summary: summaries.get(film.id) })).filter(({ summary }) => Number.isFinite(summary?.averageRating) && summary.averageRating >= 8 && summary.averageRating <= 10 && Number.isInteger(summary.ratingCount) && summary.ratingCount >= 5) : [];
    const weighted = ({ summary }) => (summary.averageRating * summary.ratingCount + 7 * 20) / (summary.ratingCount + 20);
    entries.sort((a, b) => weighted(b) - weighted(a) || b.summary.ratingCount - a.summary.ratingCount || a.film.index - b.film.index);
    $('#acclaimedRankingStatus').textContent = !detail.available ? '共享评价暂不可用，连接后更新口碑榜。' : entries.length ? '站内口碑 · 随评价更新' : '暂未有作品达到入榜门槛，评分积累后自动更新。';
    renderList('#rankingAcclaimed', entries.map(({ film, summary }) => ({ film, label: summary.averageRating.toFixed(1) + ' / 10 · ' + summary.ratingCount + ' 人评分' })));
    syncLayout();
  }
  window.addEventListener('framepick:review-summary', ({ detail }) => {
    latestSummary = detail;
    renderAcclaimed(detail);
  });
  window.addEventListener('framepick:outbound-summary', ({ detail }) => {
    latestOutbound = detail;
    renderPopular(detail);
  });

  root.addEventListener('click', (event) => {
    const link = event.target.closest('[data-ranking-film]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('framepick:request-film', { detail: { id: link.dataset.rankingFilm, trigger: link } }));
  });
  // Refresh calendar-bound lists after a background tab passes midnight.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && films.length) { renderDaily(); renderPopular(latestOutbound); } });
})();

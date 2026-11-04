// 橘生梦厂「我的」页渲染：账号状态 + 观看历史。
// 数据全部来自 framepick-viewing.js（访客 = 本浏览器，登录 = 账号），
// 这里只做展示与行级操作，不再发自己的请求。
(() => {
  'use strict';
  // me.html 不加载 framepick.js，js-only 的显隐开关在这里补。
  document.documentElement.classList.add('js');
  const $ = (selector) => document.querySelector(selector);
  const list = $('#meHistory');
  if (!list || !window.FramepickViewing) return;

  const SOURCE_LABEL = { douyin: '抖音', xiaohongshu: '小红书', bilibili: '哔哩哔哩' };

  function notify(message) {
    const notice = $('#notice');
    if (!notice) return;
    notice.textContent = message;
    notice.classList.add('is-visible');
    clearTimeout(notify._timer);
    notice._timer = setTimeout(() => notice.classList.remove('is-visible'), 2800);
  }

  function formatWhen(iso) {
    if (!iso) return '时间未知';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '时间未知';
    const now = new Date();
    const sameYear = date.getFullYear() === now.getFullYear();
    return date.toLocaleString('zh-CN', {
      ...(sameYear ? {} : { year: 'numeric' }),
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  function historyRows() {
    const viewing = window.FramepickViewing;
    const rows = new Map(viewing.historyList().map((row) => [row.filmId, row]));
    // 已看但没进历史的（例如老数据只剩标记），也给一行，避免「已看 3 部却只显示 2 行」。
    for (const { filmId } of viewing.state().watched) {
      if (!rows.has(filmId)) {
        rows.set(filmId, { filmId, title: '', poster: '', author: '', kind: '', source: '', firstAt: '', lastAt: '', opens: 0, watched: true });
      }
    }
    return [...rows.values()].sort((a, b) => {
      const key = (row) => (row.lastAt || row.firstAt || '');
      return key(a) < key(b) ? 1 : -1;
    });
  }

  function renderAccountLine() {
    const line = $('#meAccountLine');
    const note = $('#meStorageNote');
    const viewing = window.FramepickViewing;
    if (!line) return;
    line.textContent = viewing.online()
      ? '账号服务已连接；登录后观看记录随账号走，换设备登录即可恢复。'
      : '账号服务未在此部署：当前记录只保存在这台浏览器。';
    if (note) note.textContent = viewing.online() ? '本浏览器或你的账号' : '保存在此浏览器';
    window.addEventListener('framepick:account', ({ detail }) => {
      line.textContent = detail?.signedIn
        ? `已登录：${detail.account?.nickname || detail.account?.email}。观看记录保存在账号下，换设备可恢复。`
        : (viewing.online() ? '未登录：记录保存在此浏览器，登录后合并进账号。' : '账号服务未在此部署：当前记录只保存在这台浏览器。');
    });
  }

  function render() {
    const viewing = window.FramepickViewing;
    const rows = historyRows();
    const openCount = rows.reduce((total, row) => total + (row.opens || 0), 0);
    const watchedCount = viewing.watchCount();

    $('#meWatchedCount').textContent = String(watchedCount);
    $('#meHistoryCount').textContent = String(rows.length);
    $('#meOpenCount').textContent = String(openCount);
    $('#meHistoryEmpty').hidden = rows.length !== 0;
    $('#meClearHistory').hidden = rows.length === 0;

    list.textContent = '';
    for (const row of rows) {
      const item = document.createElement('article');
      item.className = 'me-history-row';
      item.dataset.film = row.filmId;

      const cover = document.createElement('a');
      cover.className = 'me-history-cover';
      cover.href = 'index.html?film=' + encodeURIComponent(row.filmId);
      const image = document.createElement('img');
      // 旧记录保存的是相对路径或 Pages 地址；发布时统一从 OSS 展示，不改用户记录。
      let poster = row.poster || '';
      const legacy = poster.match(/^(?:img\/|(?:https:\/\/highstrith\.github\.io)?\/(?:jusheng|highstrithstate\/reel)\/img\/)([A-Za-z0-9._-]+)$/);
      if (window.FRAMEPICK_IMAGE_BASE && legacy) poster = window.FRAMEPICK_IMAGE_BASE + legacy[1];
      image.src = poster || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 640 360%22%3E%3Crect width=%22640%22 height=%22360%22 fill=%22%23191c21%22/%3E%3C/svg%3E';
      image.alt = row.title ? `《${row.title}》封面` : '作品封面';
      image.loading = 'lazy';
      image.decoding = 'async';
      cover.append(image);

      const main = document.createElement('div');
      main.className = 'me-history-main';
      const heading = document.createElement('h3');
      if (row.title) {
        const link = document.createElement('a');
        link.href = 'index.html?film=' + encodeURIComponent(row.filmId);
        link.textContent = row.title;
        heading.append(link);
      } else {
        heading.textContent = '一部作品';
      }
      if (row.watched) {
        const chip = document.createElement('span');
        chip.className = 'me-watched-chip';
        chip.textContent = '已看';
        heading.append(chip);
      }
      const meta = document.createElement('p');
      meta.className = 'me-history-meta';
      const parts = [];
      if (row.author) parts.push(row.author);
      if (row.kind) parts.push(row.kind);
      if (row.source) parts.push(SOURCE_LABEL[row.source] || '原平台');
      parts.push(row.opens > 0 ? `打开过 ${row.opens} 次` : '标记为已看');
      parts.push('最近 ' + formatWhen(row.lastAt || row.firstAt));
      if (row.firstAt && row.firstAt !== row.lastAt) parts.push('第一次 ' + formatWhen(row.firstAt));
      meta.textContent = parts.join(' · ');
      main.append(heading, meta);

      const actions = document.createElement('div');
      actions.className = 'me-history-actions';
      const watchedButton = document.createElement('button');
      watchedButton.type = 'button';
      watchedButton.className = 'button secondary';
      watchedButton.textContent = row.watched ? '已看 · 取消' : '标记已看';
      watchedButton.setAttribute('aria-pressed', String(Boolean(row.watched)));
      watchedButton.addEventListener('click', () => {
        if (viewing.isWatched(row.filmId)) {
          viewing.unmarkWatched(row.filmId);
          notify('已取消已看标记');
        } else {
          viewing.markWatched(row.filmId, { title: row.title, poster: row.poster, author: row.author, kind: row.kind, source: row.source });
          notify('已标记为看过');
        }
      });
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'review-retry';
      removeButton.textContent = '移除这条记录';
      removeButton.addEventListener('click', () => {
        viewing.removeHistory(row.filmId);
        notify('已移除该作品的观看记录');
      });
      actions.append(watchedButton, removeButton);

      item.append(cover, main, actions);
      list.append(item);
    }
  }

  $('#meClearHistory').addEventListener('click', () => {
    window.FramepickViewing.clearHistory();
    notify('观看历史已清空（已看标记保留）');
  });

  renderAccountLine();
  render();
  window.addEventListener('framepick:viewing', render);
})();

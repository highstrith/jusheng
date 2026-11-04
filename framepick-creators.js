(() => {
  'use strict';
  // Optional creator intake (PRD 9). Applying is self-service, review is manual:
  // nothing here publishes a film, sets a price or shows earnings.
  const $ = (selector) => document.querySelector(selector);
  const entry = $('#creatorEntry');
  const dialog = $('#creatorDialog');
  if (!entry || !dialog) return;

  const configured = String(window.FRAMEPICK_REVIEW_API || '').trim();
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  let api = configured || (loopback && /^https?:$/.test(location.protocol) ? '/api/framepick' : '');
  try {
    if (api && !/^https?:$/.test(new URL(api, location.href).protocol)) api = '';
  } catch { api = ''; }
  api = api.replace(/\/+$/, '');

  const body = $('#creatorBody');
  const availability = $('#creatorAvailability');
  const state = $('#creatorState');
  const applyForm = $('#creatorApplyForm');
  const submitForm = $('#creatorSubmitForm');
  const mine = $('#creatorMine');
  const error = $('#creatorError');
  const status = $('#creatorStatus');
  const notice = $('#notice');
  const applySubmit = $('#creatorApplySubmit');
  const workSubmit = $('#creatorSubmitSubmit');
  const saveDraft = $('#creatorSaveDraft');

  const APPLICATION_LABELS = { submitted: '已提交', reviewing: '审核中', approved: '已通过', rejected: '未通过', 'need-info': '需补充材料' };
  const SUBMISSION_LABELS = { draft: '草稿', submitted: '已提交', reviewing: '审核中', accepted: '已通过，待转入片库', rejected: '未通过', 'need-changes': '需修改', withdrawn: '已撤回', converted: '已转入片库' };

  const offline = '创作者服务尚未在正式站点部署。当前仍可通过邮箱交流作品合作，或提交后才由人工录入。';
  let me = null;
  let available = Boolean(api);
  let availabilityMessage = '';
  let noticeTimer;

  function notify(message) {
    if (!notice) return;
    notice.textContent = message;
    notice.classList.add('is-visible');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice.classList.remove('is-visible'), 2800);
  }

  function say(target, message) {
    if (target) target.textContent = message || '';
  }

  function syncDialogBody() {
    document.body.classList.toggle('has-dialog', dialog.open || Boolean($('#filmDialog')?.open));
  }

  function label(map, value) {
    return map[value] || value;
  }

  async function call(path, options = {}) {
    const response = await fetch(`${api}${path}`, {
      credentials: 'same-origin',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...options,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch { /* non-JSON error responses are reported by status alone */ }
    if (!response.ok) {
      const reason = new Error(payload?.error || '服务暂时不可用。');
      reason.status = response.status;
      throw reason;
    }
    return payload;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function showSignInPrompt() {
    clear(state);
    const paragraph = document.createElement('p');
    paragraph.textContent = '申请创作者身份需要先登录，方便你在别的设备上找回进度。';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary';
    button.id = 'creatorGotoLogin';
    button.textContent = '去登录 / 注册';
    button.addEventListener('click', () => {
      const accountEntry = $('#accountEntry');
      if (accountEntry) accountEntry.click();
    });
    state.append(paragraph, button);
  }

  function showApplicationStatus(application) {
    clear(state);
    const paragraph = document.createElement('p');
    paragraph.textContent = `创作者申请：${label(APPLICATION_LABELS, application.status)}（${application.name}）`;
    state.append(paragraph);
    if (application.reviewNote) {
      const note = document.createElement('p');
      note.textContent = `审核意见：${application.reviewNote}`;
      state.append(note);
    }
    if (application.status === 'rejected') {
      const hint = document.createElement('p');
      hint.textContent = '未通过不代表作品被否定，可按审核意见补充后再申请。';
      state.append(hint);
    }
  }

  function showSubmissions(list) {
    clear(mine);
    mine.hidden = !list.length;
    if (!list.length) return;
    const heading = document.createElement('p');
    heading.textContent = '我的投稿';
    const items = document.createElement('ul');
    for (const submission of list) {
      const item = document.createElement('li');
      item.textContent = `${submission.title} · ${label(SUBMISSION_LABELS, submission.status)}`;
      if (submission.reviewNote) item.textContent += ` · ${submission.reviewNote}`;
      items.append(item);
    }
    mine.append(heading, items);
  }

  function render() {
    if (!api || !available) {
      availabilityMessage = availabilityMessage || offline;
      entry.hidden = false;
      say(availability, availabilityMessage);
      body.hidden = true;
      return;
    }
    body.hidden = false;
    say(availability, availabilityMessage || '');
    if (!me || !me.signedIn) {
      showSignInPrompt();
      applyForm.hidden = true;
      submitForm.hidden = true;
      mine.hidden = true;
      return;
    }
    const application = me.application;
    if (!application) {
      clear(state);
      applyForm.hidden = false;
      submitForm.hidden = true;
      mine.hidden = true;
      return;
    }
    showApplicationStatus(application);
    const approved = application.status === 'approved';
    applyForm.hidden = true;
    submitForm.hidden = !approved;
    if (approved) {
      const hint = document.createElement('p');
      hint.textContent = '投稿为人工审核：需要完整成片、试看物料与授权材料说明。付费放映另需已确认授权。';
      state.append(hint);
    }
  }

  async function refresh() {
    if (!api) { render(); return; }
    try {
      const data = await call('/creators/me');
      me = data;
      available = true;
      availabilityMessage = '';
      showSubmissions([]);
      if (data.signedIn && data.isCreator) {
        const mineData = await call('/creators/submissions/mine');
        showSubmissions(mineData.submissions || []);
      }
    } catch (requestError) {
      me = null;
      if (requestError.status === 404) {
        available = false;
        availabilityMessage = offline;
      } else {
        availabilityMessage = `创作者服务暂时不可用：${requestError.message}`;
      }
    }
    render();
  }

  function open(trigger = null) {
    say(error, '');
    say(status, '');
    if (!dialog.open) dialog.showModal();
    syncDialogBody();
    $('#creatorClose').focus({ preventScroll: true });
    if (trigger) trigger.blur?.();
  }

  function close() {
    if (!dialog.open) return;
    dialog.close();
    syncDialogBody();
    entry.focus({ preventScroll: true });
  }

  entry.addEventListener('click', () => { open(entry); refresh(); });
  $('#creatorClose').addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });

  applyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!available) { say(error, '创作者服务尚未部署，暂不能提交申请。'); return; }
    say(error, '');
    say(status, '正在提交申请…');
    applySubmit.disabled = true;
    try {
      const samples = $('#creatorSamples').value.trim();
      await call('/creators/applications', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#creatorName').value.trim(),
          contact: $('#creatorContact').value.trim(),
          intro: $('#creatorIntro').value.trim(),
          aiUsage: $('#creatorAiUsage').value.trim(),
          samples: samples ? [samples] : [],
        }),
      });
      applyForm.reset();
      say(status, '申请已提交，会由人工核实，结果会显示在这里。');
      notify('创作者申请已提交');
      await refresh();
    } catch (requestError) {
      say(error, requestError.message);
      say(status, '');
    } finally {
      applySubmit.disabled = false;
    }
  });

  const workPayload = (draft) => {
    const episode = $('#creatorFilmEpisode').value.trim();
    const payload = {
      title: $('#creatorFilmTitle').value.trim(),
      author: $('#creatorFilmAuthor').value.trim(),
      source: $('#creatorFilmSource').value,
      sourceUrl: $('#creatorFilmUrl').value.trim(),
      category: $('#creatorFilmCategory').value,
      genres: [$('#creatorFilmGenre').value],
      runtime: $('#creatorFilmRuntime').value.trim(),
      synopsis: $('#creatorFilmSynopsis').value.trim(),
      access: 'free',
      rights: { status: $('#creatorFilmRights').value },
      materials: {
        completeFilm: $('#creatorFilmComplete').checked,
        previewUrl: $('#creatorFilmPreview').value.trim(),
        aiUsage: $('#creatorFilmAi').value.trim(),
        rightsEvidence: $('#creatorFilmEvidence').value.trim(),
      },
    };
    if (episode) payload.episode = episode;
    if (draft) payload.status = 'draft';
    return payload;
  };

  const sendWork = async (draft) => {
    if (!available) { say(error, '创作者服务尚未部署，暂不能投稿。'); return; }
    say(error, '');
    say(status, draft ? '正在存为草稿…' : '正在提交投稿…');
    workSubmit.disabled = true;
    saveDraft.disabled = true;
    try {
      await call('/creators/submissions', { method: 'POST', body: JSON.stringify(workPayload(draft)) });
      submitForm.reset();
      $('#creatorFilmComplete').checked = true;
      say(status, draft ? '已存为草稿，补充完整后再提交。' : '投稿已提交，进入人工审片。');
      notify(draft ? '投稿已存为草稿' : '投稿已提交，等待审片');
      await refresh();
    } catch (requestError) {
      say(error, requestError.message);
      say(status, '');
    } finally {
      workSubmit.disabled = false;
      saveDraft.disabled = false;
    }
  };

  submitForm.addEventListener('submit', (event) => {
    event.preventDefault();
    sendWork(false);
  });
  saveDraft.addEventListener('click', () => sendWork(true));

  // Sign-in state lives in the account module; follow it instead of guessing.
  window.addEventListener('framepick:account', () => refresh());
  // Tells the prototype module the creator module is present, so it does not add
  // its own fallback handler for the same entry point.
  window.framepickCreatorsReady = true;
  render();
  refresh();
  if (new URL(location.href).searchParams.get('creator') === '1') {
    let opened = false;
    const autoOpen = () => { if (!opened) { opened = true; open(); } };
    window.addEventListener('framepick:catalogue-ready', autoOpen, { once: true });
    setTimeout(autoOpen, 1200);
  }
})();

(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const entry = $('#accountEntry');
  const dialog = $('#accountDialog');
  if (!entry || !dialog) return;

  const configured = String(window.FRAMEPICK_ACCOUNT_API || window.FRAMEPICK_REVIEW_API || '').trim();
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  let api = configured || (loopback && /^https?:$/.test(location.protocol) ? '/api/framepick' : '');
  try {
    if (api && !/^https?:$/.test(new URL(api, location.href).protocol)) api = '';
  } catch { api = ''; }
  api = api.replace(/\/+$/, '');

  // 跨站登录态：Cookie 在 GitHub Pages → 函数计算这种跨站场景会被浏览器丢掉，
  // 所以会话同时以 Bearer token 的形式放在 localStorage，请求时带上。
  const TOKEN_KEY = 'framepick:session:v1';
  function readToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
  function saveToken(value) { try { value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY); } catch { /* 无痕模式：本次会话内存态 */ } }
  function authHeader() { const token = readToken(); return token ? { Authorization: `Bearer ${token}` } : {}; }

  const form = $('#accountForm');
  const email = $('#accountEmail');
  const password = $('#accountPassword');
  const nickname = $('#accountNickname');
  const nicknameRow = $('#accountNicknameRow');
  const submit = $('#accountSubmit');
  const switchMode = $('#accountSwitch');
  const availability = $('#accountAvailability');
  const error = $('#accountError');
  const status = $('#accountStatus');
  const signedInBox = $('#accountSignedIn');
  const who = $('#accountWho');
  const logout = $('#accountLogout');
  const notice = $('#notice');

  // 不登录就是访客，不需要切换：账号是可选的，不是浏览的前置条件。
  const offline = '账号服务尚未在正式站点部署。不登录也能继续浏览、评价与跳转原作。';
  let mode = 'login';
  let account = null;
  let opener = null;
  let noticeTimer;
  // Set by refresh(); render() must never clobber it with the default copy.
  let availabilityMessage = '';
  let available = Boolean(api);
  const unavailable = '账号服务尚未部署，暂不能登录或注册。不登录也能继续浏览、评价与跳转原作。';

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

  function setMode(next) {
    mode = next;
    const registering = mode === 'register';
    submit.textContent = registering ? '注册并登录' : '登录';
    switchMode.textContent = registering ? '已有账号？直接登录' : '还没有账号？注册';
    nicknameRow.hidden = !registering;
    password.setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
    say(error, '');
  }

  function render() {
    if (!api || !available) {
      availabilityMessage = availabilityMessage || offline;
      entry.hidden = false;
      entry.textContent = '登录 / 注册';
      entry.dataset.signedIn = 'false';
      say(availability, availabilityMessage);
      form.hidden = true;
      signedInBox.hidden = true;
      return;
    }
    if (account) {
      entry.textContent = account.nickname;
      entry.dataset.signedIn = 'true';
      entry.setAttribute('aria-label', `已登录为 ${account.nickname}，打开账号`);
      form.hidden = true;
      signedInBox.hidden = false;
      who.textContent = `已登录：${account.nickname}（${account.email}）。购票与观影权益将在开放后记录在这个账号下。`;
      say(availability, availabilityMessage);
    } else {
      entry.textContent = '登录 / 注册';
      entry.dataset.signedIn = 'false';
      entry.removeAttribute('aria-label');
      form.hidden = false;
      signedInBox.hidden = true;
      say(availability, availabilityMessage || '账号可选。登录只用于承载后续购买与观影权益，不合并访客评价。');
    }
  }

  async function call(path, options = {}) {
    const response = await fetch(`${api}${path}`, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...authHeader(), ...(options.headers || {}) },
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

  async function refresh() {
    if (!api) { render(); return; }
    try {
      const data = await call('/accounts/session');
      account = data.account || null;
      availabilityMessage = '';
      available = true;
    } catch (requestError) {
      account = null;
      // A missing endpoint means the shared service is not deployed here, which is
      // the honest state on GitHub Pages today - not a transient failure.
      if (requestError.status === 404) {
        available = false;
        availabilityMessage = offline;
      } else {
        availabilityMessage = `账号服务暂时不可用：${requestError.message}`;
      }
    }
    render();
    window.dispatchEvent(new CustomEvent('framepick:account', { detail: { signedIn: Boolean(account), account } }));
  }

  function open(trigger = null) {
    opener = trigger;
    say(error, '');
    say(status, '');
    if (!dialog.open) dialog.showModal();
    syncDialogBody();
    (api && !account ? email : $('#accountClose')).focus({ preventScroll: true });
  }

  function close() {
    if (!dialog.open) return;
    dialog.close();
    syncDialogBody();
    const target = opener?.isConnected ? opener : entry;
    target.focus({ preventScroll: true });
  }

  entry.addEventListener('click', () => open(entry));
  $('#accountClose').addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  switchMode.addEventListener('click', () => { setMode(mode === 'login' ? 'register' : 'login'); email.focus({ preventScroll: true }); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!available) { say(error, unavailable); return; }
    say(error, '');
    say(status, mode === 'register' ? '正在注册…' : '正在登录…');
    submit.disabled = true;
    try {
      const body = { email: email.value.trim(), password: password.value };
      if (mode === 'register') body.nickname = nickname.value.trim();
      const data = await call(mode === 'register' ? '/accounts/register' : '/accounts/login', { method: 'POST', body: JSON.stringify(body) });
      if (data?.token) saveToken(data.token);
      account = data.account || null;
      // No navigation and no reload: the open film and filters survive sign-in.
      setMode('login');
      password.value = '';
      nickname.value = '';
      render();
      say(status, '');
      close();
      notify(account ? `已登录：${account.nickname}` : '登录完成');
      window.dispatchEvent(new CustomEvent('framepick:account', { detail: { signedIn: Boolean(account), account } }));
    } catch (requestError) {
      say(error, requestError.message);
      say(status, '');
    } finally {
      submit.disabled = false;
    }
  });

  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      await call('/accounts/logout', { method: 'POST', body: JSON.stringify({}) });
      saveToken('');
      account = null;
      render();
      say(status, '');
      close();
      notify('已退出登录，仍可继续浏览与评价');
      window.dispatchEvent(new CustomEvent('framepick:account', { detail: { signedIn: false, account: null } }));
    } catch (requestError) {
      say(error, requestError.message);
    } finally {
      logout.disabled = false;
    }
  });

  setMode('login');
  render();
  refresh();
  // ?account=1 opens the dialog, but only after the catalogue has opened any film
  // dialog, otherwise the modal detail would cover the sign-in form.
  if (new URL(location.href).searchParams.get('account') === '1') {
    let opened = false;
    const autoOpen = () => { if (!opened) { opened = true; open(); } };
    window.addEventListener('framepick:catalogue-ready', autoOpen, { once: true });
    setTimeout(autoOpen, 1200);
  }
})();

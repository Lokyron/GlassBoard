/* Sign-in and first-run setup screens.
   Kept independent from the dashboard bundle: these pages must work before any
   configuration exists. */

const id = (s) => document.getElementById(s);
const svg = (name, style) =>
  `<svg class="i"${style ? ` style="${style}"` : ''} viewBox="0 0 256 256" fill="currentColor">${PH[name] || ''}</svg>`;

const root = document.documentElement;
const setTheme = (dark) => root.setAttribute('data-theme', dark ? 'dark' : 'light');

/* These screens run before any configuration can be read, so the look is
   restored from what the dashboard left behind. Without this the sign-in page
   would always be the default blue, whatever preset was chosen inside. */
try {
  const stored = localStorage.getItem('theme');
  setTheme(stored ? stored === 'dark' : matchMedia('(prefers-color-scheme:dark)').matches);
  root.setAttribute('data-preset', localStorage.getItem('preset') || 'default');
  root.setAttribute('data-orbs', localStorage.getItem('orbs') === 'off' ? 'off' : 'on');
} catch {
  setTheme(true);
}

setLocale(detectLocale());

let toastTimer = null;
function toast(message, kind = 'info') {
  const el = id('toast');
  el.textContent = message;
  el.className = `glass toast-${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

const ERROR_KEYS = {
  invalid_credentials: 'auth.errCredentials',
  invalid_code: 'auth.errCode',
  challenge_expired: 'auth.errExpired',
  locked: 'auth.errLocked',
  too_many_requests: 'qr.tooMany',
};

function describe(error) {
  const key = ERROR_KEYS[error.code];
  if (!key) return error.message;
  const minutes = Math.ceil((error.retryInSeconds || 0) / 60);
  return t(key, { minutes });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : {};
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.code = payload.code;
    error.retryInSeconds = payload.retryInSeconds;
    throw error;
  }
  return payload;
}

/** The heading of a panel: an optional chip saying where you are, then the
 *  step itself. The brand mark lives in the aside, so it is not repeated. */
function header(title, subtitle, icon = '', chip = '') {
  const badge = chip && icon ? `<span class="chip">${svg(icon)}${chip}</span>` : '';
  return `<div class="auth-head">${badge}<h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div>`;
}

/* --------------------------------- aside --------------------------------- */
/* The half of the card that does not change: who you are coming back to. */

/** Four slots rather than the dashboard's two — at 7am and at 11pm, "good
 *  morning" and "good evening" are both slightly wrong. */
function greetingKey(hour) {
  if (hour < 5) return 'hello.night';
  if (hour < 12) return 'hello.morning';
  if (hour < 18) return 'hello.afternoon';
  return 'hello.evening';
}

function startAside(taglineKey) {
  const greeting = id('auth-greeting');
  const tagline = id('auth-tagline');
  const clock = id('auth-clock');
  const date = id('auth-date');
  if (!greeting) return;

  const tick = () => {
    const now = new Date();
    greeting.textContent = t(greetingKey(now.getHours()));
    clock.textContent = now.toLocaleTimeString(currentLocale, { hour: '2-digit', minute: '2-digit' });
    date.textContent = now.toLocaleDateString(currentLocale, { weekday: 'long', day: 'numeric', month: 'long' });
  };
  tagline.textContent = t(taglineKey);
  tick();
  // Once a minute is enough for a clock without seconds, and it keeps the
  // sign-in screen from waking the device every second while it waits.
  setInterval(tick, 30_000);
}

const card = () => id('card');
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* A user agent string is chosen by the device asking to come in, so it is read,
   never trusted. This only picks a label out of it; the raw string is shown
   underneath, escaped, so a crafted one cannot hide behind a friendly name. */
function describeAgent(agent) {
  const ua = String(agent || '');
  if (!ua) return t('qr.unknownDevice');
  const browser = [
    [/\bEdg\//, 'Edge'], [/\bOPR\//, 'Opera'], [/\bFirefox\//, 'Firefox'],
    [/\bChrome\//, 'Chrome'], [/\bSafari\//, 'Safari'],
  ].find(([re]) => re.test(ua))?.[1];
  const system = [
    [/\bWindows\b/, 'Windows'], [/\b(iPhone|iPad|iPod)\b/, 'iOS'], [/\bMac OS X\b/, 'macOS'],
    [/\bAndroid\b/, 'Android'], [/\bLinux\b/, 'Linux'],
  ].find(([re]) => re.test(ua))?.[1];
  if (browser && system) return t('qr.agentOn', { browser, system });
  return browser || system || t('qr.unknownDevice');
}
const showError = (message) => {
  const box = id('auth-error');
  if (!box) return;
  box.textContent = message;
  box.hidden = !message;
};

/* --------------------------------- login --------------------------------- */

function renderLogin() {
  card().innerHTML = `${header(t('auth.signInTitle'), t('auth.signInHint'))}
    <div class="auth-err" id="auth-error" hidden></div>
    <form class="dlg" id="login-form">
      <label class="fld"><span class="fld-l">${t('auth.username')}</span>
        <input class="inp" name="username" autocomplete="username" autofocus required></label>
      <label class="fld"><span class="fld-l">${t('auth.password')}</span>
        <input class="inp" name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn primary" type="submit">${t('auth.continue')}</button>
    </form>
    <div class="auth-sep">${t('qr.or')}</div>
    <button class="btn ghost" type="button" id="use-phone">${svg('device-mobile')}${t('qr.signInWithPhone')}</button>`;
  id('use-phone').addEventListener('click', renderQrLogin);
  id('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const data = Object.fromEntries(new FormData(event.target));
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: data });
      // The password alone never opens a session: either the account still has
      // to enrol a second factor, or a code is required now.
      if (result.step === 'otp') renderLoginCode(result.username);
      else window.location.href = result.totpEnrolmentRequired ? '/setup' : '/';
    } catch (error) {
      showError(describe(error));
      button.disabled = false;
    }
  });
}

function renderLoginCode(username) {
  card().innerHTML = `${header(t('auth.totpTitle'), t('auth.otpSubtitle', { name: username }), 'shield-check', t('auth.chipSecurity'))}
    <div class="auth-err" id="auth-error" hidden></div>
    <form class="dlg" id="code-form">
      <label class="fld"><span class="fld-l">${t('auth.code')}</span>
        <input class="inp" name="token" inputmode="numeric" autocomplete="one-time-code"
               placeholder="${t('auth.codePlaceholder')}" autofocus required></label>
      <button class="btn primary" type="submit">${t('auth.verify')}</button>
      <button class="btn ghost" type="button" id="other-account">${t('auth.otherAccount')}</button>
    </form>`;
  id('other-account').addEventListener('click', async () => {
    await api('/api/auth/login/cancel', { method: 'POST' }).catch(() => {});
    renderLogin();
  });
  id('code-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const data = Object.fromEntries(new FormData(event.target));
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/auth/login/verify', { method: 'POST', body: data });
      window.location.href = '/';
    } catch (error) {
      showError(describe(error));
      // An expired challenge cannot be retried: send the user back to step one.
      if (error.code === 'challenge_expired') setTimeout(renderLogin, 1800);
      else {
        button.disabled = false;
        event.target.token.select();
      }
    }
  });
}

/* ---------------------------- sign in by QR ------------------------------- */
/* This screen holds no credentials and never will. It opens a request, shows
   it as a QR code, and waits. It is never told the secret: that power is in the
   code on screen, and only a phone that already carries a session can use it.
   What identifies the request is a cookie the server sets, so it appears in no
   URL and in no access log. */

const POLL_INTERVAL_MS = 2000;
let pollTimer = null;
const stopPolling = () => { clearInterval(pollTimer); pollTimer = null; };

async function renderQrLogin() {
  stopPolling();
  card().innerHTML = `${header(t('qr.title'), t('qr.subtitle'), 'device-mobile', t('auth.chipPhone'))}
    <div class="auth-err" id="auth-error" hidden></div>
    <div class="auth-steps">
      <div class="qr" id="qr-image">…</div>
      <div class="pair-code" id="qr-pair">····</div>
      <span class="fld-h">${t('qr.pairingHint')}</span>
      <div class="qr-wait" id="qr-wait"><span class="qr-dot"></span><span id="qr-wait-text">…</span></div>
      <button class="btn ghost" type="button" id="qr-password">${t('qr.usePassword')}</button>
    </div>`;
  id('qr-password').addEventListener('click', () => { stopPolling(); renderLogin(); });

  let request;
  try {
    request = await api('/api/auth/qr/start', { method: 'POST' });
  } catch (error) {
    // Nothing to scan: drop the frame rather than leave an empty one on screen.
    showError(describe(error));
    card().querySelector('.auth-steps').innerHTML =
      `<button class="btn ghost" type="button" id="qr-retry">${t('qr.newCode')}</button>
       <button class="btn ghost" type="button" id="qr-back">${t('qr.usePassword')}</button>`;
    id('qr-retry').addEventListener('click', renderQrLogin);
    id('qr-back').addEventListener('click', renderLogin);
    return;
  }
  id('qr-image').innerHTML = `<img alt="" src="${esc(request.qr)}">`;
  id('qr-pair').textContent = request.pairingCode;

  let remaining = request.expiresInSeconds;
  const countdown = () => {
    id('qr-wait-text').textContent = t('qr.expiresIn', { seconds: remaining });
  };
  countdown();

  pollTimer = setInterval(async () => {
    remaining -= POLL_INTERVAL_MS / 1000;
    if (remaining <= 0) return renderQrExpired();
    countdown();
    let state;
    try {
      // No id in the URL: the browser carries it in a cookie set by /qr/start.
      state = await api('/api/auth/qr/state');
    } catch {
      return undefined; // a dropped poll is not a failure; the next one will do
    }
    // The session cookie came back with this very response.
    if (state.state === 'approved') {
      stopPolling();
      id('qr-wait-text').textContent = t('qr.approved');
      window.location.href = '/';
    } else if (state.state === 'expired' || state.state === 'used') {
      renderQrExpired();
    }
    return undefined;
  }, POLL_INTERVAL_MS);
}

function renderQrExpired() {
  stopPolling();
  card().innerHTML = `${header(t('qr.title'), t('qr.expired'), 'timer', t('auth.chipPhone'))}
    <div class="auth-steps">
      <button class="btn primary" type="button" id="qr-again">${t('qr.newCode')}</button>
      <button class="btn ghost" type="button" id="qr-password">${t('qr.usePassword')}</button>
    </div>`;
  id('qr-again').addEventListener('click', renderQrLogin);
  id('qr-password').addEventListener('click', renderLogin);
}

/* ------------------------- approving from the phone ----------------------- */

/** The secret travels in the fragment, so it never reaches the server by
 *  itself. Read once, then wiped from the address bar: no need to leave it in
 *  the history of a phone that gets handed around. */
function readApprovalSecret() {
  const secret = window.location.hash.replace(/^#/, '');
  if (secret) history.replaceState(null, '', window.location.pathname);
  return secret;
}

function renderApprovalNotice(titleKey, bodyKey, { icon = 'warning', signIn = false, note = '' } = {}) {
  card().innerHTML = `${header(t(titleKey), '', icon, t('auth.chipPhone'))}
    <p class="fld-h">${t(bodyKey)}</p>
    ${note ? `<p class="fld-h">${t(note)}</p>` : ''}
    ${signIn ? `<button class="btn primary" type="button" id="go-login">${t('qr.goToLogin')}</button>` : ''}`;
  if (signIn) id('go-login').addEventListener('click', () => { window.location.href = '/login'; });
}

async function renderApprove() {
  const secret = readApprovalSecret();
  if (!secret) return renderApprovalNotice('qr.noCode', 'qr.noCodeBody', { icon: 'device-mobile' });

  const state = await api('/api/auth/state').catch(() => null);
  if (!state) return renderApprovalNotice('msg.error', 'qr.gone');
  if (state.setupRequired || (state.authenticated && state.totpEnrolmentRequired)) {
    window.location.href = '/setup';
    return undefined;
  }
  if (!state.authenticated) {
    return renderApprovalNotice('qr.needSession', 'qr.needSessionBody', {
      icon: 'lock-key', signIn: true, note: 'qr.needSessionNote',
    });
  }

  let request;
  try {
    request = await api(`/api/auth/qr/pending?secret=${encodeURIComponent(secret)}`);
  } catch (error) {
    return renderApprovalNotice('qr.gone', 'qr.goneBody', { icon: 'timer' });
  }

  const seconds = Math.max(0, Math.round((Date.now() - new Date(request.createdAt).getTime()) / 1000));
  card().innerHTML = `${header(t('qr.approveTitle'), t('qr.approveSubtitle'), 'shield-check', t('auth.chipSecurity'))}
    <div class="auth-err" id="auth-error" hidden></div>
    <div class="auth-steps">
      <div class="pair-code">${esc(request.pairingCode)}</div>
      <span class="fld-h">${t('qr.compare')}</span>
      <div class="req-facts">
        <div class="req-fact"><span class="k">${t('qr.factBrowser')}</span><span class="v" id="fact-agent"></span></div>
        <div class="req-fact"><span class="k">${t('qr.factAddress')}</span><span class="v" id="fact-ip"></span></div>
        <div class="req-fact"><span class="k">${t('qr.factWhen')}</span><span class="v">${t('qr.secondsAgo', { n: seconds })}</span></div>
        <div class="req-fact"><span class="k">${t('qr.factAccount')}</span><span class="v" id="fact-user"></span></div>
      </div>
      <div class="row">
        <button class="btn ghost" type="button" id="qr-reject">${t('qr.reject')}</button>
        <button class="btn primary" type="button" id="qr-approve">${t('qr.approve')}</button>
      </div>
    </div>`;
  // textContent, not innerHTML: these three strings come from the other device.
  id('fact-agent').textContent = describeAgent(request.userAgent);
  id('fact-agent').title = request.userAgent || '';
  id('fact-ip').textContent = request.clientIp || '—';
  id('fact-user').textContent = request.username;

  id('qr-approve').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      await api('/api/auth/qr/approve', { method: 'POST', body: { secret } });
      renderApprovalNotice('qr.doneTitle', 'qr.doneBody', { icon: 'seal-check' });
    } catch (error) {
      showError(error.message);
      event.target.disabled = false;
    }
  });
  id('qr-reject').addEventListener('click', async () => {
    await api('/api/auth/qr/reject', { method: 'POST', body: { secret } }).catch(() => {});
    renderApprovalNotice('qr.rejectedTitle', 'qr.rejectedBody', { icon: 'x' });
  });
  return undefined;
}

/* --------------------------------- setup --------------------------------- */

function renderCreateAccount() {
  card().innerHTML = `${header(t('auth.setupTitle'), t('auth.setupSubtitle'), 'sparkle', t('auth.chipWelcome'))}
    <div class="auth-err" id="auth-error" hidden></div>
    <form class="dlg" id="setup-form">
      <label class="fld"><span class="fld-l">${t('auth.username')}</span>
        <input class="inp" name="username" autocomplete="username" autofocus required></label>
      <label class="fld"><span class="fld-l">${t('auth.password')}</span>
        <input class="inp" name="password" type="password" autocomplete="new-password" required>
        <span class="fld-h">${t('auth.passwordHint')}</span></label>
      <button class="btn primary" type="submit">${t('auth.createAccount')}</button>
    </form>`;
  id('setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const data = Object.fromEntries(new FormData(event.target));
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/auth/setup', { method: 'POST', body: data });
      renderTotpEnrolment();
    } catch (error) {
      showError(error.message);
      button.disabled = false;
    }
  });
}

async function renderTotpEnrolment() {
  card().innerHTML = `${header(t('auth.totpTitle'), t('auth.totpSubtitle'), 'shield-check', t('auth.chipSecurity'))}
    <div class="auth-err" id="auth-error" hidden></div>
    <div class="auth-steps">
      <div class="qr" id="qr">…</div>
      <div class="secret" id="secret">…</div>
      <span class="fld-h">${t('auth.totpApps')}</span>
      <form class="dlg" id="totp-form">
        <label class="fld"><span class="fld-l">${t('auth.totpCode')}</span>
          <input class="inp" name="token" inputmode="numeric" autocomplete="one-time-code" required></label>
        <button class="btn primary" type="submit">${t('auth.totpEnable')}</button>
      </form>
    </div>`;
  try {
    const enrolment = await api('/api/auth/totp/start', { method: 'POST' });
    id('qr').innerHTML = `<img alt="TOTP QR code" src="${enrolment.qr}">`;
    id('secret').textContent = enrolment.secret;
  } catch (error) {
    showError(error.message);
  }
  id('totp-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(event.target));
      const result = await api('/api/auth/totp/confirm', { method: 'POST', body: data });
      renderRecoveryCodes(result.recoveryCodes);
    } catch (error) {
      showError(error.message);
      button.disabled = false;
    }
  });
}

function renderRecoveryCodes(codes) {
  card().innerHTML = `${header(t('auth.recoveryTitle'), t('auth.recoverySubtitle'), 'key', t('auth.chipRecovery'))}
    <div class="codes">${codes.map((code) => `<code>${code}</code>`).join('')}</div>
    <div class="row">
      <button class="btn ghost" id="copy-codes" type="button">${t('auth.copy')}</button>
      <button class="btn primary" id="go-dashboard" type="button">${t('auth.openDashboard')}</button>
    </div>
    <span class="fld-h">${t('auth.recoveryHint')}</span>`;
  id('copy-codes').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast(t('msg.copied'));
    } catch {
      toast(t('msg.copyFailed'), 'error');
    }
  });
  id('go-dashboard').addEventListener('click', () => { window.location.href = '/'; });
}

/* -------------------------------- invitation ------------------------------ */
/* The token lives in the fragment, exactly as the QR code's secret does: a
   fragment is never sent to the server, so the token reaches no access log and
   no proxy. The page asks the API about it explicitly, once. */

async function renderInvite() {
  const token = window.location.hash.slice(1);
  if (!token) {
    return renderApprovalNotice('invite.missingTitle', 'invite.missingBody', { icon: 'warning' });
  }

  let invitation;
  try {
    invitation = await api(`/api/auth/invite?token=${encodeURIComponent(token)}`);
  } catch {
    return renderApprovalNotice('invite.deadTitle', 'invite.deadBody', { icon: 'warning' });
  }

  // A username chosen by whoever sent the invitation is shown but not editable:
  // changing it would quietly make the account somebody else.
  const fixedName = Boolean(invitation.username);
  card().innerHTML = `${header(t('invite.title'), t('invite.subtitle'), 'sparkle', t('auth.chipWelcome'))}
    <div class="auth-err" id="auth-error" hidden></div>
    <form class="dlg" id="invite-form">
      <label class="fld"><span class="fld-l">${t('auth.username')}</span>
        <input class="inp" name="username" autocomplete="username" required
          value="${esc(invitation.username)}"${fixedName ? ' readonly' : ' autofocus'}>
        ${fixedName ? `<span class="fld-h">${t('invite.usernameFixed')}</span>` : ''}</label>
      <label class="fld"><span class="fld-l">${t('auth.password')}</span>
        <input class="inp" name="password" type="password" autocomplete="new-password" required
          ${fixedName ? 'autofocus' : ''}>
        <span class="fld-h">${t('auth.passwordHint')}</span></label>
      ${invitation.role === 'admin' ? `<p class="fld-h">${t('invite.asAdmin')}</p>` : ''}
      <button class="btn primary" type="submit">${t('auth.createAccount')}</button>
    </form>`;

  id('invite-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const data = Object.fromEntries(new FormData(event.target));
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/auth/invite', { method: 'POST', body: { ...data, token } });
      // The token is spent; drop it from the address bar before anything else
      // so a reload, or a shoulder, cannot pick it back up.
      history.replaceState(null, '', '/invite');
      renderTotpEnrolment();
    } catch (error) {
      showError(error.message);
      button.disabled = false;
    }
  });
  return undefined;
}

/* ---------------------------------- boot ---------------------------------- */

const TAGLINES = {
  login: 'hello.taglineSignIn',
  approve: 'hello.taglineApprove',
  setup: 'hello.taglineSetup',
  invite: 'hello.taglineInvite',
};

async function startAuthPage(page) {
  document.querySelectorAll('svg[data-i]').forEach((el) => { el.innerHTML = PH[el.dataset.i] || ''; });
  startAside(TAGLINES[page] || TAGLINES.login);
  if (page === 'login') return renderLogin();
  if (page === 'approve') return renderApprove();
  if (page === 'invite') return renderInvite();

  const state = await api('/api/auth/state');
  if (state.setupRequired) return renderCreateAccount();
  if (state.authenticated && state.totpEnrolmentRequired) return renderTotpEnrolment();
  window.location.href = '/';
  return undefined;
}

startAuthPage(document.body.dataset.page).catch((error) => toast(error.message, 'error'));

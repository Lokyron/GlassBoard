/* Sign-in and first-run setup screens.
   Kept independent from the dashboard bundle: these pages must work before any
   configuration exists. */

const id = (s) => document.getElementById(s);
const svg = (name, style) =>
  `<svg class="i"${style ? ` style="${style}"` : ''} viewBox="0 0 256 256" fill="currentColor">${PH[name] || ''}</svg>`;

const setTheme = (dark) => document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
try {
  const stored = localStorage.getItem('theme');
  setTheme(stored ? stored === 'dark' : matchMedia('(prefers-color-scheme:dark)').matches);
} catch {
  setTheme(true);
}

let toastTimer = null;
function toast(message, kind = 'info') {
  const el = id('toast');
  el.textContent = message;
  el.className = `glass toast-${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
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
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function header(title, subtitle, icon = 'house') {
  return `<div class="auth-head"><div class="brand">${svg(icon)}</div>
    <div><h1>${title}</h1><p>${subtitle}</p></div></div>`;
}

const card = () => id('card');
const showError = (message) => {
  const box = id('auth-error');
  if (!box) return;
  box.textContent = message;
  box.hidden = !message;
};

/* --------------------------------- login --------------------------------- */

function renderLogin() {
  card().innerHTML = `${header('Glassboard', 'Sign in to your dashboard', 'lock-key')}
    <div class="auth-err" id="auth-error" hidden></div>
    <form class="dlg" id="login-form">
      <label class="fld"><span class="fld-l">Username</span>
        <input class="inp" name="username" autocomplete="username" autofocus required></label>
      <label class="fld"><span class="fld-l">Password</span>
        <input class="inp" name="password" type="password" autocomplete="current-password" required></label>
      <label class="fld"><span class="fld-l">Authentication code</span>
        <input class="inp" name="token" inputmode="numeric" autocomplete="one-time-code"
               placeholder="123456 or a recovery code"></label>
      <button class="btn primary" type="submit">Sign in</button>
    </form>`;
  id('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const data = Object.fromEntries(new FormData(event.target));
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: data });
      window.location.href = result.totpEnrolmentRequired ? '/setup' : '/';
    } catch (error) {
      showError(error.message);
      button.disabled = false;
    }
  });
}

/* --------------------------------- setup --------------------------------- */

function renderCreateAccount() {
  card().innerHTML = `${header('Welcome to Glassboard', 'Create the administrator account', 'user-circle')}
    <div class="auth-err" id="auth-error" hidden></div>
    <form class="dlg" id="setup-form">
      <label class="fld"><span class="fld-l">Username</span>
        <input class="inp" name="username" autocomplete="username" autofocus required></label>
      <label class="fld"><span class="fld-l">Password</span>
        <input class="inp" name="password" type="password" autocomplete="new-password" required>
        <span class="fld-h">At least 12 characters. There is no default account and no default password.</span></label>
      <button class="btn primary" type="submit">Create account</button>
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
  card().innerHTML = `${header('Two-factor authentication', 'Scan this code with your authenticator app', 'shield-check')}
    <div class="auth-err" id="auth-error" hidden></div>
    <div class="auth-steps">
      <div class="qr" id="qr">…</div>
      <div class="secret" id="secret">…</div>
      <span class="fld-h">Works with Google Authenticator, Aegis, Bitwarden, 1Password and any other TOTP app.</span>
      <form class="dlg" id="totp-form">
        <label class="fld"><span class="fld-l">Code from the app</span>
          <input class="inp" name="token" inputmode="numeric" autocomplete="one-time-code" required></label>
        <button class="btn primary" type="submit">Enable two-factor authentication</button>
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
  card().innerHTML = `${header('Recovery codes', 'Store these somewhere safe — each one works once', 'key')}
    <div class="codes">${codes.map((code) => `<code>${code}</code>`).join('')}</div>
    <div class="row">
      <button class="btn ghost" id="copy-codes" type="button">Copy</button>
      <button class="btn primary" id="go-dashboard" type="button">Open the dashboard</button>
    </div>
    <span class="fld-h">If you lose your authenticator, one of these codes lets you sign in again.</span>`;
  id('copy-codes').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast('Recovery codes copied.');
    } catch {
      toast('Copy failed — select the codes manually.', 'error');
    }
  });
  id('go-dashboard').addEventListener('click', () => { window.location.href = '/'; });
}

/* ---------------------------------- boot ---------------------------------- */

async function startAuthPage(page) {
  document.querySelectorAll('svg[data-i]').forEach((el) => { el.innerHTML = PH[el.dataset.i] || ''; });
  if (page === 'login') return renderLogin();

  const state = await api('/api/auth/state');
  if (state.setupRequired) return renderCreateAccount();
  if (state.authenticated && state.totpEnrolmentRequired) return renderTotpEnrolment();
  window.location.href = '/';
  return undefined;
}

startAuthPage(document.body.dataset.page).catch((error) => toast(error.message, 'error'));

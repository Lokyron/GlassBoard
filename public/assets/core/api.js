/* Talking to our own server, and saying something went wrong. */
import { id } from './dom.js';

/* Leaving the dashboard is a one-way door, and it is taken at most once.
 *
 * A 401 or a 409 used to send the page straight to /login or /setup. Both of
 * those bounce a reader who is in fact signed in right back to the dashboard,
 * which loads, asks again, and leaves again — a reload loop with no way out,
 * and nothing on screen to say why. One route answering badly should never
 * cost someone their whole dashboard.
 *
 * So the session is confirmed first, against the one public route that knows,
 * and the flag makes sure a second failure cannot start a second navigation
 * while the first is still in flight. If the answer is that the session is
 * fine, the caller gets an ordinary error to show and the page stays put. */
let leaving = false;

async function sessionIsReallyGone(status) {
  try {
    const response = await fetch('/api/auth/state', { credentials: 'same-origin' });
    if (!response.ok) return false;
    const state = await response.json();
    return status === 409 ? state.setupRequired === true : state.authenticated !== true;
  } catch {
    // No answer at all — offline, or the server is restarting. Staying is the
    // safe reading: a dashboard that waits beats one that throws you out.
    return false;
  }
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401 || response.status === 409) {
    if (!leaving && await sessionIsReallyGone(response.status)) {
      leaving = true;
      window.location.href = response.status === 409 ? '/setup' : '/login';
      throw new Error('unauthenticated');
    }
    const error = new Error(`${path} answered ${response.status} on a live session`);
    error.status = response.status;
    error.code = 'spurious_auth_failure';
    // Said out loud: this is the shape of bug that used to be invisible,
    // because the page left before anyone could read the console.
    console.error('[glassboard]', error.message);
    throw error;
  }
  const payload = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : null;
  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`);
    error.details = payload?.details;
    // Several routes answer with a machine-readable code next to the message.
    // Carrying it through is what lets a caller react to a particular failure
    // rather than only display it.
    error.code = payload?.code ?? null;
    error.status = response.status;
    throw error;
  }
  return payload;
}

let toastTimer = null;
export function toast(message, kind = 'info') {
  const el = id('toast');
  el.textContent = message;
  el.className = `glass toast-${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

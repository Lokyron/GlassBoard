/* Talking to our own server, and saying something went wrong. */
import { id } from './dom.js';

export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401 || response.status === 409) {
    window.location.href = response.status === 409 ? '/setup' : '/login';
    throw new Error('unauthenticated');
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

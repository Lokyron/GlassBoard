/* The smallest shared vocabulary: finding a node, making one, escaping text,
   and drawing an icon. Nothing here knows what a dashboard is.
 *
 * PH comes from /assets/icons.js, a classic script the sign-in pages share
 * with the dashboard. A top-level const in a classic script is visible to
 * module code as a free variable, and classic scripts run before deferred
 * modules, so it is there by the time any of this is called. */

export const html = document.documentElement;
export const id = (s) => document.getElementById(s);
export const safe = (el, value) => { if (el) el.textContent = value; };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const iconName = (n) => (n || '').replace(/^ph-/, '');
export const svg = (name, style) =>
  `<svg class="i"${style ? ` style="${style}"` : ''} viewBox="0 0 256 256" fill="currentColor">${PH[iconName(name)] || PH.link || ''}</svg>`;
export const hydrateIcons = (root = document) =>
  root.querySelectorAll('svg[data-i]').forEach((node) => { node.innerHTML = PH[node.dataset.i] || ''; });

/** Build an element in one expression: attributes, handlers and children. */
export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const clone = (value) => JSON.parse(JSON.stringify(value));
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Today in the browser's own timezone. toISOString() would give UTC, which is
 *  the wrong day for anyone east of Greenwich late in the evening. */
export function localDayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "07:38" out of an Open-Meteo local timestamp, or '' when there is none. */
export const clockOf = (stamp) => (typeof stamp === 'string' && stamp.length >= 16 ? stamp.slice(11, 16) : '');

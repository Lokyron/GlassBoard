/* Leaflet, fetched the first time a map is actually wanted.
 *
 * It was a <script> and a <link> in the page, so every visit paid for 160 kB
 * of parsing whether or not the dashboard had a map on it. It is vendored, so
 * this is a request to our own origin and the content security policy needs
 * no exception.
 *
 * The promise is kept: two tiles asking at the same instant load it once. */
let pending = null;

const load = (tag, attrs, { first = false } = {}) => new Promise((resolve, reject) => {
  const node = Object.assign(document.createElement(tag), attrs);
  node.onload = resolve;
  node.onerror = () => reject(new Error('Leaflet did not load.'));
  /* A stylesheet goes BEFORE the application's own, which is where it sat
     when the page loaded it statically. Leaflet and this dashboard style the
     same classes with the same specificity, so whichever comes last wins:
     appended at the end, .leaflet-marker-icon{display:block} quietly beat
     .gr-pin{display:grid} and the motorcycle slid into the corner of its
     own pin. The script may go anywhere. */
  const anchor = first ? document.head.querySelector('link[rel="stylesheet"], style') : null;
  if (anchor) anchor.before(node);
  else document.head.appendChild(node);
});

export function leaflet() {
  if (window.L) return Promise.resolve(window.L);
  pending ??= load('link', { rel: 'stylesheet', href: '/assets/vendor/leaflet.css' }, { first: true })
    .then(() => load('script', { src: '/assets/vendor/leaflet.js' }))
    .then(() => window.L)
    .catch((error) => { pending = null; throw error; });
  return pending;
}

/* Leaflet, fetched the first time a map is actually wanted.
 *
 * It was a <script> and a <link> in the page, so every visit paid for 160 kB
 * of parsing whether or not the dashboard had a map on it. It is vendored, so
 * this is a request to our own origin and the content security policy needs
 * no exception.
 *
 * The promise is kept: two tiles asking at the same instant load it once. */
let pending = null;

const load = (tag, attrs) => new Promise((resolve, reject) => {
  const node = Object.assign(document.createElement(tag), attrs);
  node.onload = resolve;
  node.onerror = () => reject(new Error('Leaflet did not load.'));
  document.head.appendChild(node);
});

export function leaflet() {
  if (window.L) return Promise.resolve(window.L);
  pending ??= load('link', { rel: 'stylesheet', href: '/assets/vendor/leaflet.css' })
    .then(() => load('script', { src: '/assets/vendor/leaflet.js' }))
    .then(() => window.L)
    .catch((error) => { pending = null; throw error; });
  return pending;
}

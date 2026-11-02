/* Offline page, served by the service worker when the server cannot be reached. */

try {
  const stored = localStorage.getItem('theme');
  const dark = stored ? stored === 'dark' : matchMedia('(prefers-color-scheme:dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
} catch { /* private mode: stay dark */ }

setLocale(detectLocale());
applyTranslations();

const retry = () => location.reload();
document.getElementById('retry').addEventListener('click', retry);
// The page swaps itself back for the dashboard the moment the network returns.
addEventListener('online', retry);

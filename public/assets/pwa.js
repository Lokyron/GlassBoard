/* Installable app: service worker registration and the install prompt.
   Shared by the dashboard and the sign-in pages. */

const pwa = {
  prompt: null,
  onChange: () => {},
  /** Already running as an installed app. */
  get standalone() {
    return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  },
  /** iOS has no install prompt: installing goes through the Share menu. */
  get ios() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },
  /** Something to offer: the browser's own prompt, or the manual steps on iOS. */
  get available() {
    return !this.standalone && (Boolean(this.prompt) || this.ios);
  },
};

// A service worker needs HTTPS (localhost aside), and so does installing.
if ('serviceWorker' in navigator && window.isSecureContext) {
  addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

// Chrome, Edge and Android announce that the app can be installed; keep the
// event so the account menu can offer it too.
addEventListener('beforeinstallprompt', (event) => {
  pwa.prompt = event;
  pwa.onChange();
});
addEventListener('appinstalled', () => {
  pwa.prompt = null;
  pwa.onChange();
});

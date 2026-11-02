/* The shell around the dashboard: the account menu, the update badge, the
   install offer and the changelog window. Everything here belongs to the
   application rather than to any one feature. */
import { id, el, safe } from './dom.js';
import { api, toast } from './api.js';
import { state } from './state.js';
import { openDialog, closeDialog } from './dialogs.js';

/** A quiet daily check: a dot on the account button when a version is waiting. */
export async function checkForUpdateBadge() {
  try {
    const payload = await api('/api/update');
    const behind = Boolean(payload.latest?.commit && payload.installed?.commit && payload.latest.commit !== payload.installed.commit);
    id('account-toggle').classList.toggle('has-badge', behind);
    document.querySelector('#dock [aria-label]')?.classList.remove('has-badge');
    document.querySelectorAll('#dock .dock-item').forEach((item) => {
      if (item.getAttribute('aria-label') === t('set.account')) item.classList.toggle('has-badge', behind);
    });
    id('account-menu').querySelector('[data-action="settings"]')?.classList.toggle('has-badge', behind);
  } catch { /* an instance without the update route: nothing to show */ }
}

/* ------------------------------- install app ------------------------------ */

/** The menu offers installing only where the browser can, and not from inside the app. */
export function syncInstallItem() {
  id('account-menu').querySelector('[data-action="install"]').hidden = !pwa.available;
}

export async function installApp() {
  if (pwa.prompt) {
    const prompt = pwa.prompt;
    pwa.prompt = null; // a prompt can be shown only once
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    syncInstallItem();
    if (outcome === 'accepted') toast(t('pwa.installed'));
    return;
  }
  if (pwa.ios) {
    openDialog({ title: t('menu.install'), body: el('div', { class: 'dlg' }, [el('p', { class: 'fld-h', text: t('pwa.ios') })]) });
  }
}

/* ------------------------------- what's new ------------------------------- */
/* After an update, the page comes back on a new build and this says what
   changed. Once per account per build: the acknowledgement is stored server
   side, so it is not something a cleared browser brings back. */

const NEWS_KINDS = { added: 'news.added', changed: 'news.changed', fixed: 'news.fixed', removed: 'news.removed' };

/** One changelog section, as a block of the dialog. */
function newsSection(section) {
  const groups = section.groups.map((group) =>
    el('div', { class: 'news-group' }, [
      el('div', { class: 'news-kind', text: NEWS_KINDS[group.kind] ? t(NEWS_KINDS[group.kind]) : group.kind }),
      el('ul', { class: 'news-items' }, group.items.map((item) =>
        el('li', {}, [
          // Entries without a headline — the Changed and Fixed lists mostly —
          // are a single paragraph, and look right that way.
          item.lead ? el('strong', { class: 'news-lead', text: item.lead }) : null,
          item.text ? el('span', { text: item.text }) : null,
        ]))),
    ])
  );
  return el('section', { class: 'news-section' }, [
    el('div', { class: 'news-head' }, [
      el('h4', { text: section.released ? section.version : t('news.unreleased') }),
      section.date ? el('span', { class: 'news-date', text: section.date }) : null,
    ]),
    section.summary ? el('p', { class: 'news-summary', text: section.summary }) : null,
    ...groups,
  ]);
}

function newsBody(sections, { acknowledge = true } = {}) {
  const body = el('div', { class: 'dlg news' });
  // The notes are English while the interface is not, so the dialog says so
  // rather than leaving the reader to wonder whether something is broken.
  body.appendChild(el('p', { class: 'fld-h', text: t('news.inEnglish') }));
  sections.forEach((section) => body.appendChild(newsSection(section)));
  body.appendChild(el('div', { class: 'dlg-foot' }, [
    el('button', {
      class: 'btn primary', type: 'button', text: t('news.gotIt'),
      onclick: async () => {
        if (acknowledge) await api('/api/update/news/seen', { method: 'POST', body: {} }).catch(() => {});
        closeDialog();
      },
    }),
  ]));
  return body;
}

/** Ask once at start-up, and open the dialog only when there is something
 *  unread. A failure here is silent: a dashboard that cannot reach its own
 *  changelog is still a working dashboard. */
export async function checkForNews() {
  try {
    const news = await api('/api/update/news');
    state.news = news;
    if (!news.unread || news.sections.length === 0) return;
    openDialog({
      title: t('news.title'),
      subtitle: news.installed?.version ? t('news.subtitle', { version: news.installed.version }) : '',
      body: newsBody(news.sections),
    });
  } catch {
    /* no changelog, or no network to our own server: nothing to show */
  }
}

/** The same thing, asked for deliberately from the settings. Shows the recent
 *  history rather than only the unread part, and acknowledges nothing: reading
 *  it on purpose is not the same as being told. */
export async function openNewsHistory() {
  try {
    const news = state.news ?? await api('/api/update/news');
    const sections = news.all?.length ? news.all : news.sections;
    if (!sections?.length) return toast(t('news.none'));
    openDialog({ title: t('news.title'), subtitle: '', body: newsBody(sections, { acknowledge: false }) });
  } catch (error) {
    toast(error.message, 'error');
  }
  return undefined;
}

/* ------------------------------ account menu ------------------------------ */

export function toggleAccountMenu(force) {
  const menu = id('account-menu');
  const open = force ?? menu.hidden;
  menu.hidden = !open;
  id('account-toggle').setAttribute('aria-expanded', String(open));
}

export async function doLogout() {
  await api('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

export function downloadExport(includeSecrets) {
  const url = `/api/config/export${includeSecrets ? '?secrets=1' : ''}`;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}


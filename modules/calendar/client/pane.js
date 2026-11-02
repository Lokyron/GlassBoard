/* The Calendar settings tab: the calendars this dashboard subscribes to.
 *
 * One address per calendar, and nothing else — no account to connect, no
 * consent screen, no token. The address is sent once and stored encrypted
 * server side; it never comes back, and the line under each feed is all this
 * page ever learns about it.
 *
 * Why it is treated as a secret: a published calendar address is a
 * credential. Google calls it the "secret address in iCal format", and
 * anybody holding it can read that calendar until it is reset. So it lives in
 * the secrets table, encrypted with APP_SECRET, and not in the configuration
 * document — which is a file people mail each other. */
import {
  el, api, toast, field, textInput, checkbox, slider, colourPicker, uid,
} from '/assets/core/kernel.js';

/* Kept in step with MAX_FEEDS in the manifest, which this file may not import:
   only client/ is served over HTTP, so a manifest import would resolve on
   disk here and 404 in the browser. */
const MAX_FEEDS = 8;

export function pane(draft) {
  const calendar = draft.integrations.calendar;
  const pane = el('div', { class: 'pane' });

  pane.appendChild(el('p', { class: 'fld-h', text: t('set.calHowTo') }));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.calReadOnly') }));

  const list = el('div', { class: 'cal-list' });
  pane.appendChild(list);

  const add = el('button', {
    class: 'btn ghost', type: 'button', text: t('set.calAdd'),
    onclick: () => {
      if (calendar.feeds.length >= MAX_FEEDS) return toast(t('set.calTooMany', { n: MAX_FEEDS }), 'error');
      calendar.feeds.push({ id: uid('cal'), name: '', colour: '#0a84ff', shown: true });
      paintList();
    },
  });
  pane.appendChild(el('div', { class: 'row' }, [add]));

  /* What this pane knows that the configuration does not: which feeds already
     have an address stored. */
  const stored = new Map();

  function paintList() {
    list.innerHTML = '';
    if (!calendar.feeds.length) {
      list.appendChild(el('p', { class: 'fld-h', text: t('set.calNoFeeds') }));
      return;
    }
    calendar.feeds.forEach((feed) => list.appendChild(feedRow(feed)));
  }

  function feedRow(feed) {
    const status = el('div', { class: 'status', text: stored.get(feed.id) ? t('set.calHasUrl') : t('set.calNoUrl') });

    const name = textInput(feed.name, {
      placeholder: t('set.calUnnamed'),
      oninput: (e) => { feed.name = e.target.value; },
    });

    const url = textInput('', {
      type: 'url',
      placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
      autocomplete: 'off', spellcheck: 'false',
    });

    const save = el('button', {
      class: 'btn primary', type: 'button', text: t('set.calSaveUrl'),
      onclick: async () => {
        save.disabled = true;
        try {
          await api(`/api/m/calendar/feeds/${encodeURIComponent(feed.id)}/url`, {
            method: 'PUT', body: { url: url.value },
          });
          stored.set(feed.id, true);
          url.value = '';
          status.textContent = t('set.calHasUrl');
          toast(t('msg.saved'));
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          save.disabled = false;
        }
      },
    });

    /* The one thing that tells somebody they pasted the page they look at the
       calendar on rather than the .ics address — which is the mistake this
       field invites, because both are a URL and only one of them works. */
    const check = el('button', {
      class: 'btn ghost', type: 'button', text: t('set.calCheck'),
      onclick: async () => {
        check.disabled = true;
        status.textContent = t('set.calChecking');
        try {
          const result = await api('/api/m/calendar/probe', { method: 'POST', body: { url: url.value } });
          status.textContent = t('set.calCheckOk', { n: result.events, name: result.name || t('set.calUnnamed') });
          /* A calendar that names itself saves somebody typing that name in.
             The field is filled rather than the list redrawn: redrawing would
             throw away the line that has just been written above, which is
             the answer they pressed the button for. */
          if (result.name && !feed.name) {
            feed.name = result.name;
            name.value = result.name;
          }
        } catch (error) {
          status.textContent = error.message;
        } finally {
          check.disabled = false;
        }
      },
    });

    const remove = el('button', {
      class: 'btn ghost cal-danger', type: 'button', text: t('set.calRemove'),
      onclick: async () => {
        if (!confirm(t('set.calRemoveConfirm', { name: feed.name || t('set.calUnnamed') }))) return;
        // The address goes now; the row goes when the settings are saved.
        await api(`/api/m/calendar/feeds/${encodeURIComponent(feed.id)}/url`, { method: 'DELETE' }).catch(() => {});
        calendar.feeds = calendar.feeds.filter((f) => f.id !== feed.id);
        stored.delete(feed.id);
        paintList();
      },
    });

    return el('div', { class: 'cal-list-row' }, [
      field(t('set.calName'), name),
      field(t('set.calUrl'), url, t('set.calUrlHint')),
      status,
      el('div', { class: 'row' }, [save, check, remove]),
      colourPicker(feed.colour, (value) => { feed.colour = value; }),
      checkbox(t('set.calShown'), feed.shown, (value) => { feed.shown = value; }),
    ]);
  }

  /* ---------------------------- how it is drawn -------------------------- */

  pane.appendChild(el('div', { class: 'divider' }));
  pane.appendChild(checkbox(t('set.calMonday'), calendar.weekStartsMonday, (value) => { calendar.weekStartsMonday = value; }));
  pane.appendChild(checkbox(t('set.calYearBar'), calendar.showYearProgress, (value) => { calendar.showYearProgress = value; }));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.calYearBarHint') }));
  pane.appendChild(field(t('set.calUpcoming'), slider(calendar.upcomingCount, 1, 12, 1, (value) => { calendar.upcomingCount = value; })));
  pane.appendChild(field(t('set.refresh'), textInput(calendar.refreshMinutes, {
    type: 'number', min: '5', max: '720',
    oninput: (e) => { calendar.refreshMinutes = Number(e.target.value); },
  }), t('set.calRefreshHint')));

  api('/api/m/calendar/status')
    .then((result) => {
      for (const feed of result.feeds ?? []) if (feed.hasUrl) stored.set(feed.id, true);
      paintList();
    })
    .catch(() => paintList());

  paintList();
  return pane;
}

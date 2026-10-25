/* The Calendar settings tab: the Google client this instance authorises
 * against, the account itself, and which calendars the dashboard draws.
 *
 * The client secret is sent once and stored encrypted server side; it never
 * comes back, and the status line is all this page ever learns about it.
 *
 * The sign-in has two shapes and the pane shows whichever applies. An
 * instance Google can redirect to — a real hostname over HTTPS — gets one
 * click. An instance reached at an address Google refuses as a redirect URI,
 * which on a homelab means any IP address, sends the reader to a loopback
 * page that fails to load and asks them to paste its address back. That paste
 * is not a workaround for something the dashboard could do itself: Google
 * will not redirect to 192.168.1.50, and no amount of code here changes it. */
import {
  el, api, toast, field, textInput, checkbox, slider, colourPicker,
} from '/assets/core/kernel.js';

export function pane(draft) {
  const calendar = draft.integrations.calendar;
  /* What this pane knows that the configuration does not: the redirect URI as
     the server has it saved, the two addresses worth registering with Google,
     and which calendars may be written to. Declared first because the
     controls below close over it. */
  const own = { redirectUri: null, callbackUri: '', loopbackUri: '', writable: [] };
  const pane = el('div', { class: 'pane' });
  const status = el('div', { class: 'status', text: '…' });
  pane.appendChild(status);

  /* ----------------------------- the client ----------------------------- */

  pane.appendChild(el('p', { class: 'fld-h', text: t('set.calHowTo') }));

  const clientId = textInput('', {
    placeholder: '1234567890-abcdef.apps.googleusercontent.com',
    autocomplete: 'off', spellcheck: 'false',
  });
  const clientSecret = textInput('', { type: 'password', placeholder: '••••••••••••••••', autocomplete: 'off' });

  const saveClient = el('button', {
    class: 'btn primary', type: 'button', text: t('set.calSaveClient'),
    onclick: async () => {
      saveClient.disabled = true;
      try {
        await api('/api/m/calendar/client', {
          method: 'PUT',
          body: { clientId: clientId.value, clientSecret: clientSecret.value },
        });
        clientSecret.value = '';
        await showStatus();
        toast(t('msg.saved'));
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        saveClient.disabled = false;
      }
    },
  });

  const forgetClient = el('button', {
    class: 'btn ghost', type: 'button', text: t('set.calForgetClient'),
    onclick: async () => {
      if (!confirm(t('set.calForgetConfirm'))) return;
      await api('/api/m/calendar/client', { method: 'DELETE' });
      clientId.value = '';
      clientSecret.value = '';
      await showStatus();
      toast(t('msg.saved'));
    },
  });

  pane.appendChild(field(t('set.calClientId'), clientId, t('set.calClientIdHint')));
  pane.appendChild(field(t('set.calClientSecret'), clientSecret));
  pane.appendChild(el('div', { class: 'row' }, [saveClient, forgetClient]));

  /* --------------------------- the redirect URI -------------------------- */

  const redirect = textInput(calendar.redirectUri, {
    autocomplete: 'off', spellcheck: 'false',
    oninput: (e) => { calendar.redirectUri = e.target.value.trim(); },
  });
  const redirectHint = el('p', { class: 'fld-h', text: t('set.calRedirectHint') });
  pane.appendChild(field(t('set.calRedirect'), redirect, t('set.calRedirectWhich')));
  pane.appendChild(redirectHint);

  /* Both of the addresses worth registering in Google's console, as buttons
     rather than prose: one of them is this instance's own callback, which
     nobody should have to assemble by hand. */
  const use = (which) => () => {
    const value = own[which];
    if (!value) return;
    redirect.value = value;
    calendar.redirectUri = value;
  };
  const useCallback = el('button', { class: 'btn ghost', type: 'button', text: t('set.calUseCallback'), onclick: use('callbackUri') });
  const useLoopback = el('button', { class: 'btn ghost', type: 'button', text: t('set.calUseLoopback'), onclick: use('loopbackUri') });
  pane.appendChild(el('div', { class: 'row' }, [useCallback, useLoopback]));

  pane.appendChild(el('div', { class: 'divider' }));

  /* ----------------------------- the account ---------------------------- */

  const paste = textInput('', { placeholder: 'http://127.0.0.1:33333/?state=…&code=…', autocomplete: 'off', spellcheck: 'false' });
  const pasteRow = el('div', { class: 'cal-paste' }, [
    el('p', { class: 'fld-h', text: t('set.calPasteHint') }),
    field(t('set.calPasteLabel'), paste),
  ]);
  const finish = el('button', {
    class: 'btn primary', type: 'button', text: t('set.calPasteFinish'),
    onclick: async () => {
      finish.disabled = true;
      try {
        await api('/api/m/calendar/connect/paste', { method: 'POST', body: { pasted: paste.value } });
        paste.value = '';
        await showStatus();
        await refreshCalendars();
        toast(t('set.calConnectedToast'));
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        finish.disabled = false;
      }
    },
  });
  pasteRow.appendChild(finish);
  pasteRow.hidden = true;

  const connect = el('button', {
    class: 'btn primary', type: 'button', text: t('set.calConnect'),
    onclick: async () => {
      connect.disabled = true;
      try {
        /* The redirect URI the server will use is the saved one, so a value
           typed into the field above has to be saved before it counts. Said
           out loud rather than silently using the old one. */
        if (calendar.redirectUri !== (own.redirectUri ?? calendar.redirectUri)) {
          toast(t('set.calSaveFirst'), 'error');
          return;
        }
        const result = await api('/api/m/calendar/connect', { method: 'POST' });
        window.open(result.url, '_blank', 'noopener');
        pasteRow.hidden = result.mode !== 'paste';
        status.textContent = result.mode === 'paste' ? t('set.calWaitingPaste') : t('set.calWaitingCallback');
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        connect.disabled = false;
      }
    },
  });

  const disconnect = el('button', {
    class: 'btn ghost', type: 'button', text: t('set.calDisconnect'),
    onclick: async () => {
      if (!confirm(t('set.calDisconnectConfirm'))) return;
      disconnect.disabled = true;
      try {
        await api('/api/m/calendar/disconnect', { method: 'POST' });
        await showStatus();
        toast(t('msg.saved'));
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        disconnect.disabled = false;
      }
    },
  });

  pane.appendChild(el('div', { class: 'row' }, [connect, disconnect]));
  pane.appendChild(pasteRow);

  pane.appendChild(el('div', { class: 'divider' }));

  /* ---------------------------- the calendars --------------------------- */

  const list = el('div', { class: 'cal-list' });
  const defaultPick = el('select', { class: 'inp', onchange: (e) => { calendar.defaultCalendarId = e.target.value; } });

  const reread = el('button', {
    class: 'btn ghost', type: 'button', text: t('set.calReread'),
    onclick: async () => {
      reread.disabled = true;
      try {
        await refreshCalendars({ force: true });
        toast(t('set.calRereadDone', { n: calendar.calendars.length }));
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        reread.disabled = false;
      }
    },
  });

  pane.appendChild(el('div', { class: 'fld-l', text: t('set.calCalendars') }));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.calCalendarsHint') }));
  pane.appendChild(list);
  pane.appendChild(el('div', { class: 'row' }, [reread]));
  pane.appendChild(field(t('set.calDefault'), defaultPick, t('set.calDefaultHint')));

  /** The saved list, drawn with a switch and a colour per calendar. */
  function paintList() {
    list.innerHTML = '';
    if (!calendar.calendars.length) {
      list.appendChild(el('p', { class: 'fld-h', text: t('set.calNoCalendars') }));
    }
    calendar.calendars.forEach((entry) => {
      const row = el('div', { class: 'cal-list-row' }, [
        checkbox(entry.name || entry.id, entry.shown, (value) => { entry.shown = value; }),
        colourPicker(entry.colour, (value) => { entry.colour = value; }),
      ]);
      list.appendChild(row);
    });

    defaultPick.innerHTML = '';
    defaultPick.appendChild(el('option', { value: '', text: t('set.calPrimary') }));
    for (const entry of own.writable ?? []) {
      const option = el('option', { value: entry.id, text: entry.name });
      if (calendar.defaultCalendarId === entry.id) option.selected = true;
      defaultPick.appendChild(option);
    }
  }

  /**
   * Bring the saved list in line with what Google says.
   *
   * A calendar already in the list keeps the reader's own choices — whether
   * it is drawn, and in what colour — because those are settings and not
   * something to be overwritten by a sync. One that has appeared since is
   * added, shown, in the colour Google gives it. One that has gone is
   * dropped: it cannot be fetched any more.
   */
  async function refreshCalendars({ force = false } = {}) {
    const payload = await api(`/api/m/calendar/calendars${force ? '?refresh=1' : ''}`);
    const fromGoogle = payload.calendars ?? [];
    own.writable = fromGoogle.filter((entry) => entry.writable);
    if (!fromGoogle.length) return paintList();

    const kept = new Map(calendar.calendars.map((entry) => [entry.id, entry]));
    calendar.calendars = fromGoogle.map((entry) => {
      const mine = kept.get(entry.id);
      return {
        id: entry.id,
        name: entry.name,
        colour: mine?.colour ?? normaliseColour(entry.colour),
        shown: mine ? mine.shown : entry.selected !== false,
      };
    });
    paintList();
  }

  /* The configuration takes #rrggbb and Google is not always that tidy. */
  const normaliseColour = (value) =>
    (/^#[0-9a-fA-F]{6}$/.test(String(value ?? '')) ? String(value).toLowerCase() : '#0a84ff');

  /* ---------------------------- how it is drawn -------------------------- */

  pane.appendChild(el('div', { class: 'divider' }));
  pane.appendChild(checkbox(t('set.calMonday'), calendar.weekStartsMonday, (value) => { calendar.weekStartsMonday = value; }));
  pane.appendChild(checkbox(t('set.calYearBar'), calendar.showYearProgress, (value) => { calendar.showYearProgress = value; }));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.calYearBarHint') }));
  pane.appendChild(field(t('set.calUpcoming'), slider(calendar.upcomingCount, 1, 12, 1, (value) => { calendar.upcomingCount = value; })));
  pane.appendChild(field(t('set.refresh'), textInput(calendar.refreshMinutes, {
    type: 'number', min: '1', max: '720',
    oninput: (e) => { calendar.refreshMinutes = Number(e.target.value); },
  }), t('set.calRefreshHint')));

  /* -------------------------------- status ------------------------------- */

  async function showStatus() {
    try {
      const result = await api('/api/m/calendar/status');
      own.redirectUri = result.redirectUri;
      own.callbackUri = result.callbackUri;
      own.loopbackUri = result.loopbackUri;
      clientId.value = result.clientId || '';
      redirectHint.textContent = result.mode === 'callback'
        ? t('set.calRedirectCallback', { uri: result.callbackUri })
        : t('set.calRedirectLoopback', { uri: result.loopbackUri, callback: result.callbackUri });

      connect.disabled = !result.configured;
      disconnect.hidden = !result.connected;
      // Nothing left to paste once the account is on.
      if (result.connected) pasteRow.hidden = true;

      status.textContent = !result.configured
        ? t('set.calNoClient')
        : result.connected
          ? t('set.calConnected', { account: result.account || t('set.calUnknownAccount') })
          : t('set.calNotConnected');
    } catch (error) {
      status.textContent = error.message;
    }
  }

  paintList();
  showStatus().then(() => refreshCalendars().catch(() => {}));
  return pane;
}

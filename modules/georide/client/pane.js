/* The GeoRide settings tab: signing in to the GeoRide account, picking a
 * tracker, and how often the rides are brought up to date.
 *
 * The password is sent once and stored encrypted server side; it never comes
 * back, and the status line is all this page ever learns about it. */
import { el, api, toast, field, textInput, checkbox } from '/assets/core/kernel.js';

export function pane(draft) {
  const georide = draft.integrations.georide;
  const pane = el('div', { class: 'pane' });
  const status = el('div', { class: 'status', text: '…' });
  pane.appendChild(status);

  const trackerSelect = el('select', { class: 'inp', onchange: (e) => {
    georide.trackerId = e.target.value ? Number(e.target.value) : null;
    georide.trackerName = e.target.selectedOptions[0]?.dataset.name || '';
  } });

  const fillTrackers = (trackers) => {
    trackerSelect.innerHTML = '';
    trackers.forEach((tracker) => {
      const option = el('option', { value: tracker.trackerId, text: `${tracker.trackerName} (#${tracker.trackerId})`, 'data-name': tracker.trackerName });
      if (Number(georide.trackerId) === Number(tracker.trackerId)) option.selected = true;
      trackerSelect.appendChild(option);
    });
    if (!georide.trackerId && trackers[0]) {
      georide.trackerId = trackers[0].trackerId;
      georide.trackerName = trackers[0].trackerName;
    }
  };

  const email = textInput('', { type: 'email', placeholder: 'you@example.org' });
  const password = textInput('', { type: 'password' });
  const connect = el('button', { class: 'btn primary', type: 'button', text: t('set.georideConnect'), onclick: async () => {
    connect.disabled = true;
    try {
      const result = await api('/api/m/georide/login', { method: 'POST', body: { email: email.value, password: password.value } });
      fillTrackers(result.trackers);
      status.textContent = t('set.georideConnected', { email: email.value });
      password.value = '';
      toast(t('msg.saved'));
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      connect.disabled = false;
    }
  } });
  const disconnect = el('button', { class: 'btn ghost', type: 'button', text: t('set.georideDisconnect'), onclick: async () => {
    await api('/api/m/georide/logout', { method: 'POST' });
    status.textContent = t('gr.notConfigured');
    toast(t('msg.saved'));
  } });

  pane.appendChild(field(t('set.georideEmail'), email));
  pane.appendChild(field(t('set.georidePassword'), password));
  pane.appendChild(el('div', { class: 'row' }, [connect, disconnect]));
  pane.appendChild(field(t('set.georideTracker'), trackerSelect));
  pane.appendChild(field(t('set.periodDays'), textInput(georide.periodDays, { type: 'number', min: '1', max: '31', oninput: (e) => { georide.periodDays = Number(e.target.value); } })));
  pane.appendChild(field(t('set.refresh'), textInput(georide.refreshMinutes, { type: 'number', min: '1', max: '720', oninput: (e) => { georide.refreshMinutes = Number(e.target.value); } })));
  pane.appendChild(checkbox(t('set.georideMap'), georide.showMap, (value) => { georide.showMap = value; }));

  api('/api/m/georide/status')
    .then(async (result) => {
      status.textContent = result.configured ? t('set.georideConnected', { email: result.email || '—' }) : t('gr.notConfigured');
      if (result.configured) {
        try { fillTrackers((await api('/api/m/georide/trackers')).trackers); } catch { /* offline */ }
      }
    })
    .catch(() => { status.textContent = t('gr.unavailable'); });

  return pane;
}

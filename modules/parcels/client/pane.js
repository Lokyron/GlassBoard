/* The parcels settings tab: the 17TRACK key, what the tile shows, and the
 * mailbox the scan reads.
 *
 * Neither secret is ever read back. Each has its own route and the page only
 * learns whether one is set. */
import { el, api, toast, field, textInput, checkbox } from '/assets/core/kernel.js';

export function pane(draft) {
  const parcels = draft.integrations.parcels;
  const pane = el('div', { class: 'pane' });
  const status = el('div', { class: 'status', text: '…' });
  pane.appendChild(status);

  const key = textInput('', { type: 'password', placeholder: '••••••••••••', autocomplete: 'off' });
  const save = el('button', { class: 'btn primary', type: 'button', text: t('set.parcelsSaveKey'), onclick: async () => {
    save.disabled = true;
    try {
      await api('/api/m/parcels/key', { method: 'PUT', body: { apiKey: key.value } });
      key.value = '';
      await showStatus();
      toast(t('msg.saved'));
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      save.disabled = false;
    }
  } });
  const forget = el('button', { class: 'btn ghost', type: 'button', text: t('set.parcelsForgetKey'), onclick: async () => {
    await api('/api/m/parcels/key', { method: 'DELETE' });
    await showStatus();
    toast(t('msg.saved'));
  } });

  // The remaining allowance matters here: with this provider a unit is spent
  // when a parcel is added, never when its status is read.
  async function showStatus() {
    try {
      const result = await api('/api/m/parcels/status');
      if (!result.hasKey) {
        status.textContent = t('set.parcelsNoKey');
      } else if (result.quota) {
        status.textContent = t('set.parcelsQuota', { remaining: result.quota.remaining, total: result.quota.total });
      } else {
        status.textContent = result.error || t('set.parcelsConnected');
      }
    } catch (error) {
      status.textContent = error.message;
    }
  }

  pane.appendChild(field(t('set.parcelsKey'), key, t('set.parcelsKeyHint')));
  pane.appendChild(el('div', { class: 'row' }, [save, forget]));
  pane.appendChild(field(t('set.refresh'), textInput(parcels.refreshMinutes, { type: 'number', min: '15', max: '1440', oninput: (e) => { parcels.refreshMinutes = Number(e.target.value); } }), t('set.parcelsRefreshHint')));
  pane.appendChild(field(t('set.parcelsHideAfter'), textInput(parcels.hideDeliveredAfterDays, { type: 'number', min: '0', max: '30', oninput: (e) => { parcels.hideDeliveredAfterDays = Number(e.target.value); } }), t('set.parcelsHideAfterHint')));
  pane.appendChild(field(t('set.parcelsMaxOnTile'), textInput(parcels.maxOnTile, { type: 'number', min: '1', max: '10', oninput: (e) => { parcels.maxOnTile = Number(e.target.value); } })));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.parcelsManualHint') }));

  /* -------------------------- the mailbox scan -------------------------- */

  const mail = parcels.mail;
  pane.appendChild(el('h4', { class: 'pane-title', text: t('set.mailTitle') }));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.mailIntro') }));

  const mailStatus = el('div', { class: 'status', text: '…' });
  pane.appendChild(mailStatus);

  const mailPassword = textInput('', { type: 'password', placeholder: '••••••••••••', autocomplete: 'off' });
  const saveMail = el('button', { class: 'btn primary', type: 'button', text: t('set.mailSave'), onclick: async () => {
    saveMail.disabled = true;
    try {
      await api('/api/m/parcels/mail/password', { method: 'PUT', body: { password: mailPassword.value } });
      mailPassword.value = '';
      mail.enabled = true;
      await showMailStatus();
      toast(t('msg.saved'));
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      saveMail.disabled = false;
    }
  } });
  const forgetMail = el('button', { class: 'btn ghost', type: 'button', text: t('set.mailForget'), onclick: async () => {
    await api('/api/m/parcels/mail/password', { method: 'DELETE' });
    mail.enabled = false;
    await showMailStatus();
    toast(t('msg.saved'));
  } });
  // Saving the whole settings dialog is not needed to find out whether the
  // credentials work: the test signs in and hangs up, and says what failed.
  const testMail = el('button', { class: 'btn ghost', type: 'button', text: t('set.mailTest'), onclick: async () => {
    testMail.disabled = true;
    mailStatus.textContent = t('set.mailTesting');
    try {
      const result = await api('/api/m/parcels/mail/test', { method: 'POST' });
      mailStatus.textContent = t('set.mailWorks', { n: result.recent });
    } catch (error) {
      mailStatus.textContent = error.message;
    } finally {
      testMail.disabled = false;
    }
  } });

  async function showMailStatus() {
    try {
      const result = await api('/api/m/parcels/status');
      if (!result.mail?.configured) {
        mailStatus.textContent = t('set.mailNoPassword');
      } else if (result.mail.lastScan) {
        mailStatus.textContent = t('set.mailLastScan', {
          when: new Date(result.mail.lastScan).toLocaleString(state.config.site.locale),
          n: result.mail.pending,
        });
      } else {
        mailStatus.textContent = t('set.mailNeverScanned');
      }
    } catch (error) {
      mailStatus.textContent = error.message;
    }
  }

  pane.appendChild(checkbox(t('set.mailEnabled'), mail.enabled, (value) => { mail.enabled = value; }));
  pane.appendChild(field(t('set.mailAddress'), textInput(mail.user, { type: 'email', placeholder: 'you@gmail.com', oninput: (e) => { mail.user = e.target.value.trim(); } })));
  pane.appendChild(field(t('set.mailPassword'), mailPassword, t('set.mailPasswordHint')));
  pane.appendChild(el('div', { class: 'row' }, [saveMail, forgetMail, testMail]));
  pane.appendChild(field(t('set.mailHost'), textInput(mail.host, { oninput: (e) => { mail.host = e.target.value.trim(); } })));
  pane.appendChild(field(t('set.mailPort'), textInput(mail.port, { type: 'number', min: '1', max: '65535', oninput: (e) => { mail.port = Number(e.target.value); } })));
  pane.appendChild(field(t('set.mailSenders'), textInput(mail.senders, { placeholder: '@colissimo.fr, @amazon.fr', oninput: (e) => { mail.senders = e.target.value; } }), t('set.mailSendersHint')));
  pane.appendChild(field(t('set.mailSinceDays'), textInput(mail.sinceDays, { type: 'number', min: '1', max: '60', oninput: (e) => { mail.sinceDays = Number(e.target.value); } }), t('set.mailSinceDaysHint')));
  pane.appendChild(field(t('set.mailScanHours'), textInput(mail.scanHours, { type: 'number', min: '1', max: '48', oninput: (e) => { mail.scanHours = Number(e.target.value); } })));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.mailPrivacy') }));

  showStatus();
  showMailStatus();
  return pane;
}

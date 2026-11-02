/* The Proxmox settings tab: where the hypervisor is, the token to read it
 * with, and which node the card shows.
 *
 * The token secret is sent once and stored encrypted server side; it never
 * comes back, and the status line is all this page ever learns about it. */
import { el, api, toast, field, textInput, checkbox } from '/assets/core/kernel.js';

export function pane(draft) {
  const pve = draft.integrations.pve;
  const pane = el('div', { class: 'pane' });
  const status = el('div', { class: 'status', text: '…' });
  pane.appendChild(status);

  /* How to make the token. Written out rather than linked: it is four clicks
     in an interface the reader already has open, and the one thing that
     decides whether this works is the role — an audit token cannot be made to
     switch anything off by a bug in this dashboard. */
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.pveHowTo') }));

  const host = textInput(pve.host, {
    placeholder: '192.168.1.10',
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: (e) => { pve.host = e.target.value.trim(); },
  });
  const port = textInput(pve.port, {
    type: 'number', min: '1', max: '65535',
    oninput: (e) => { pve.port = Number(e.target.value); },
  });

  const tokenId = textInput('', {
    placeholder: 'glassboard@pve!dashboard',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const tokenSecret = textInput('', { type: 'password', placeholder: '••••••••-••••-••••-••••-••••••••••••', autocomplete: 'off' });

  const nodeSelect = el('select', { class: 'inp', onchange: (e) => { pve.node = e.target.value; } });
  const fillNodes = (names) => {
    nodeSelect.innerHTML = '';
    // An empty value is a real choice and not a blank: on a standalone host
    // there is one node and naming it in the configuration would only make
    // the configuration wrong the day the host is renamed.
    nodeSelect.appendChild(el('option', { value: '', text: t('set.pveFirstNode') }));
    names.forEach((name) => {
      const option = el('option', { value: name, text: name });
      if (pve.node === name) option.selected = true;
      nodeSelect.appendChild(option);
    });
  };
  fillNodes(pve.node ? [pve.node] : []);

  const save = el('button', {
    class: 'btn primary', type: 'button', text: t('set.pveSaveToken'),
    onclick: async () => {
      save.disabled = true;
      try {
        await api('/api/m/pve/token', { method: 'PUT', body: { tokenId: tokenId.value, tokenSecret: tokenSecret.value } });
        tokenSecret.value = '';
        await showStatus();
        toast(t('msg.saved'));
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        save.disabled = false;
      }
    },
  });

  const forget = el('button', {
    class: 'btn ghost', type: 'button', text: t('set.pveForgetToken'),
    onclick: async () => {
      await api('/api/m/pve/token', { method: 'DELETE' });
      tokenId.value = '';
      await showStatus();
      toast(t('msg.saved'));
    },
  });

  /* The test is the only way a reader finds out they have to accept a
     self-signed certificate, so it runs against the saved settings and
     reports exactly what the host said. */
  const test = el('button', {
    class: 'btn ghost', type: 'button', text: t('set.pveTest'),
    onclick: async () => {
      test.disabled = true;
      status.textContent = t('set.pveTesting');
      try {
        const result = await api('/api/m/pve/test', { method: 'POST' });
        fillNodes(result.nodes ?? []);
        status.textContent = t('set.pveWorks', { nodes: (result.nodes ?? []).length, guests: result.guests ?? 0 });
      } catch (error) {
        status.textContent = error.message;
      } finally {
        test.disabled = false;
      }
    },
  });

  async function showStatus() {
    try {
      const result = await api('/api/m/pve/status');
      tokenId.value = result.tokenId || '';
      status.textContent = result.configured
        ? t('set.pveConnected', { token: result.tokenId || '—' })
        : t('set.pveNoToken');
    } catch (error) {
      status.textContent = error.message;
    }
  }

  pane.appendChild(field(t('set.pveHost'), host, t('set.pveHostHint')));
  pane.appendChild(field(t('set.pvePort'), port));
  pane.appendChild(checkbox(t('set.pveSelfSigned'), pve.allowSelfSigned, (value) => { pve.allowSelfSigned = value; }));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.pveSelfSignedHint') }));
  pane.appendChild(field(t('set.pveTokenId'), tokenId, t('set.pveTokenIdHint')));
  pane.appendChild(field(t('set.pveTokenSecret'), tokenSecret));
  pane.appendChild(el('div', { class: 'row' }, [save, forget, test]));
  pane.appendChild(field(t('set.pveNode'), nodeSelect, t('set.pveNodeHint')));
  pane.appendChild(field(t('set.refresh'), textInput(pve.refreshMinutes, {
    type: 'number', min: '1', max: '60',
    oninput: (e) => { pve.refreshMinutes = Number(e.target.value); },
  })));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.pveReadOnly') }));

  showStatus();
  return pane;
}

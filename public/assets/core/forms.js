/* The form vocabulary the settings and the editors are built from.
 *
 * Shared rather than private to the editor, because a module writes its own
 * settings pane and must be able to produce controls that look like every
 * other one on the page. */
import { el, svg, iconName } from './dom.js';
import { closeDialog } from './dialogs.js';


export const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const PALETTE = ['#0a84ff', '#5e5ce6', '#64d2ff', '#16a34a', '#34c759', '#eab308', '#f97316', '#ea580c', '#ef4444', '#ec4899', '#a129cc', '#8b5cf6', '#3b82f6', '#10b981', '#14b8a6', '#475569'];


export function field(label, control, hint) {
  return el('label', { class: 'fld' }, [
    el('span', { class: 'fld-l', text: label }),
    control,
    hint ? el('span', { class: 'fld-h', text: hint }) : null,
  ]);
}

export function textInput(value, attributes = {}) {
  return el('input', { class: 'inp', type: 'text', value: value ?? '', ...attributes });
}

export function checkbox(label, checked, onChange) {
  const input = el('input', { type: 'checkbox', onchange: (event) => onChange(event.target.checked) });
  input.checked = Boolean(checked);
  return el('label', { class: 'chk' }, [input, el('span', { text: label })]);
}

export function colourPicker(value, onChange) {
  const wrap = el('div', { class: 'swatches' });
  const native = el('input', { class: 'swatch-native', type: 'color', value, onchange: (e) => { onChange(e.target.value); paint(e.target.value); } });
  const buttons = PALETTE.map((colour) =>
    el('button', {
      class: 'swatch', type: 'button', 'data-colour': colour,
      style: `background:${colour}`,
      onclick: () => { native.value = colour; onChange(colour); paint(colour); },
    })
  );
  function paint(selected) {
    buttons.forEach((button) => button.classList.toggle('on', button.dataset.colour === selected));
  }
  buttons.forEach((button) => wrap.appendChild(button));
  wrap.appendChild(native);
  paint(value);
  return wrap;
}

export function iconPicker(value, onChange) {
  const wrap = el('div', { class: 'iconpick' });
  const names = Object.keys(PH).sort();
  const buttons = names.map((name) =>
    el('button', {
      class: `iconopt${name === iconName(value) ? ' on' : ''}`, type: 'button', 'data-icon': name,
      title: name, html: svg(name),
      onclick: () => {
        onChange(name);
        wrap.querySelectorAll('.iconopt').forEach((b) => b.classList.toggle('on', b.dataset.icon === name));
      },
    })
  );
  buttons.forEach((button) => wrap.appendChild(button));
  return wrap;
}

export function slider(value, min, max, step, onChange) {
  const output = el('span', { class: 'fld-h', text: String(value) });
  const input = el('input', {
    class: 'range', type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
    oninput: (event) => {
      const next = Number(event.target.value);
      output.textContent = String(next);
      onChange(next);
    },
  });
  return el('div', { class: 'rangerow' }, [input, output]);
}

export function dialogFooter(onSave, onCancel = closeDialog, saveLabel = t('dlg.save')) {
  return el('div', { class: 'dlg-foot' }, [
    el('button', { class: 'btn ghost', type: 'button', text: t('dlg.cancel'), onclick: onCancel }),
    el('button', { class: 'btn primary', type: 'button', text: saveLabel, onclick: onSave }),
  ]);
}

/* ------------------------------- edit mode ------------------------------- */

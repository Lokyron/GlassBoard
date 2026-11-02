/* The interface strings.
 *
 * These tests exist because the language setting used to reach most of the
 * dashboard and not all of it: a few names came from the server, which has no
 * locale, and a couple of keys were referenced by code that no table defined —
 * so a reader in French met English words and one raw key. Parity and
 * reachability are checkable, so they are checked here rather than noticed
 * later by somebody switching language.
 *
 * i18n.js is a classic script, not a module: it declares `const I18N` and
 * expects to run in a browser. It is read as text and its table is evaluated
 * on its own, which is also what keeps this test free of a DOM. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULES } from '../server/modules/registry.js';
import { THEME_PRESETS } from '../server/config-schema.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const i18nSource = read('public/assets/i18n.js');

/** The I18N table, lifted out of the classic script that declares it. */
const table = (() => {
  const start = i18nSource.indexOf('const I18N = {');
  const end = i18nSource.indexOf('\n};', start);
  assert.ok(start !== -1 && end > start, 'the I18N table is where this test expects it');
  const literal = i18nSource.slice(start + 'const I18N = '.length, end + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${literal}`)();
})();

const LOCALES = Object.keys(table);
const REFERENCE = 'en';

/** Every .js and .html file the interface is built from. */
function sourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'vendor', '.git'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(ROOT, 'public'));
  walk(path.join(ROOT, 'modules'));
  return files;
}

/** key -> the file that asks for it. */
function keysUsedInCode() {
  const used = new Map();
  const patterns = [
    /\bt\(\s*'([^']+)'/g,          // t('key')
    /\btranslate\(\s*'([^']+)'/g,  // the kernel's re-export
    /data-t[pa]?="([^"]+)"/g,      // markup: text, placeholder, accessible name
  ];
  for (const file of sourceFiles()) {
    if (file.endsWith(`assets${path.sep}i18n.js`)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (!used.has(match[1])) used.set(match[1], path.relative(ROOT, file));
      }
    }
  }
  return used;
}

describe('the translation tables', () => {
  it('offers the languages the settings let you pick', () => {
    assert.deepEqual(LOCALES, ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl']);
  });

  it('defines the same keys in every language', () => {
    const reference = Object.keys(table[REFERENCE]).sort();
    for (const locale of LOCALES) {
      if (locale === REFERENCE) continue;
      const keys = Object.keys(table[locale]).sort();
      const missing = reference.filter((key) => !keys.includes(key));
      const extra = keys.filter((key) => !reference.includes(key));
      assert.deepEqual(missing, [], `${locale} is missing: ${missing.join(', ')}`);
      assert.deepEqual(extra, [], `${locale} defines keys English does not: ${extra.join(', ')}`);
    }
  });

  it('keeps the same {placeholders} in every language', () => {
    /* A translation that drops a placeholder shows a sentence with a hole in
       it, and one that invents a placeholder shows the braces. */
    const names = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, english] of Object.entries(table[REFERENCE])) {
      for (const locale of LOCALES) {
        if (locale === REFERENCE) continue;
        assert.deepEqual(names(table[locale][key]), names(english), `${locale}.${key}`);
      }
    }
  });

  it('leaves no string empty', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(table[locale])) {
        assert.equal(typeof value, 'string', `${locale}.${key}`);
        assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
      }
    }
  });
});

describe('the keys the interface asks for', () => {
  it('all exist, so no reader is ever shown a raw key', () => {
    const unknown = [...keysUsedInCode()]
      .filter(([key]) => !(key in table[REFERENCE]))
      .map(([key, file]) => `${key} (${file})`);
    assert.deepEqual(unknown, [], `undefined keys: ${unknown.join(', ')}`);
  });
});

describe('the names that come from the server', () => {
  /* A module, a tile type and a theme are named by the server, which has no
     locale. Each therefore carries a translation key beside its English
     label, and the interface prefers the key — which only works if the key
     is actually in the table. */
  const named = [
    ...MODULES.map((module) => [`module ${module.id}`, module.labelKey]),
    ...MODULES.flatMap((module) =>
      Object.entries(module.tiles ?? {}).map(([type, tile]) => [`tile ${type}`, tile.labelKey])),
    ...Object.entries(THEME_PRESETS).map(([id, preset]) => [`theme ${id}`, preset.labelKey]),
  ];

  it('each declare one', () => {
    for (const [what, key] of named) assert.ok(key, `${what} has no labelKey`);
  });

  it('and every one of them is translated', () => {
    for (const [what, key] of named) {
      assert.ok(key in table[REFERENCE], `${what}: no translation for "${key}"`);
    }
  });
});

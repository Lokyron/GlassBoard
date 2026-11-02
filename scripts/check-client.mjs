#!/usr/bin/env node
/* A standing check on the browser code, which no test runner loads.
 *
 * It parses and *links* every ES module under public/assets/core,
 * public/assets/main.js and modules/<id>/client with the engine's own parser
 * and module loader. Linking is the part that earns its keep: it resolves
 * every import specifier against the real file and checks that the other side
 * actually exports that name. A path left behind by a move, a helper renamed
 * on one side only, a binding that was never exported — all of them fail here
 * rather than in somebody's browser.
 *
 * It does not execute anything and makes no claim to type-check. A reference
 * to a local that no longer exists is a runtime error the browser alone can
 * see, which is why loading the page is still part of the job.
 *
 *   node --experimental-vm-modules scripts/check-client.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (file) => path.relative(ROOT, file);

/** Entry points: everything the page loads as a module, directly or not. */
function entries() {
  const found = [];
  const main = path.join(ROOT, 'public', 'assets', 'main.js');
  if (fs.existsSync(main)) found.push(main);
  const modulesDir = path.join(ROOT, 'modules');
  if (fs.existsSync(modulesDir)) {
    for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const client = path.join(modulesDir, entry.name, 'client');
      if (!fs.existsSync(client)) continue;
      for (const file of fs.readdirSync(client)) {
        if (file.endsWith('.js')) found.push(path.join(client, file));
      }
    }
  }
  return found;
}

const cache = new Map();
const context = vm.createContext({});

/* The browser resolves /assets/... and /modules/... against the document
   root; on disk those live under public/ and the project root respectively. */
function resolve(specifier, fromFile) {
  if (specifier.startsWith('/assets/')) return path.join(ROOT, 'public', specifier);
  if (specifier.startsWith('/modules/')) {
    const [, , moduleId, ...rest] = specifier.split('/');
    return path.join(ROOT, 'modules', moduleId, 'client', ...rest);
  }
  if (specifier.startsWith('.')) return path.resolve(path.dirname(fromFile), specifier);
  throw new Error(`cannot resolve "${specifier}" from ${rel(fromFile)}`);
}

function load(file) {
  if (cache.has(file)) return cache.get(file);
  if (!fs.existsSync(file)) throw new Error(`${rel(file)} does not exist`);
  const module = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), {
    identifier: pathToFileURL(file).href,
    context,
    initializeImportMeta: (meta) => { meta.url = pathToFileURL(file).href; },
    importModuleDynamically: (specifier) => load(resolve(specifier, file)),
  });
  module.__file = file;
  cache.set(file, module);
  return module;
}

const linker = (specifier, referencing) => load(resolve(specifier, referencing.__file));

let failures = 0;
for (const entry of entries()) {
  try {
    const module = load(entry);
    await module.link(linker);
  } catch (error) {
    console.error(`${rel(entry)}: ${error.message}`);
    failures += 1;
  }
}

/* A dynamic import names a file the linker never walks, so the specifiers are
   checked on their own. This is how a module's tile is reached. */
const DYNAMIC = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const [file] of cache) {
  for (const match of fs.readFileSync(file, 'utf8').matchAll(DYNAMIC)) {
    try {
      const target = resolve(match[1], file);
      if (!fs.existsSync(target)) throw new Error(`${match[1]} does not exist`);
      await load(target).link(linker);
    } catch (error) {
      console.error(`${rel(file)}: dynamic import — ${error.message}`);
      failures += 1;
    }
  }
}

if (failures) {
  console.error(`\n${failures} problem(s) in the browser code.`);
  process.exit(1);
}
console.log(`browser code: ${cache.size} module(s) parsed and linked`);

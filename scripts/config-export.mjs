#!/usr/bin/env node
// Export the dashboard configuration to a file (or stdout).
//
//   npm run config:export -- --out backup.json
//   npm run config:export -- --user alice --out backup.json
//   npm run config:export -- --out backup.json --include-secrets
//   npm run config:export -- --stdout > backup.json
import fs from 'node:fs';
import path from 'node:path';
import { buildExport } from '../server/store.js';
import { instanceId } from '../server/auth.js';
import { resolveAccount } from './account.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};

if (has('--help') || has('-h')) {
  console.log(`Usage: npm run config:export -- [--user <name>] [--out <file>] [--include-secrets] [--stdout]

  --user <name|id>    Which account to export. Optional while the instance has
                      only one; required as soon as it has several.
  --out <file>        Write to this file (default: glassboard-<id>-<user>-<date>.json)
  --include-secrets   Also export integration credentials, IN PLAIN TEXT
  --stdout            Print to standard output instead of writing a file`);
  process.exit(0);
}

const includeSecrets = has('--include-secrets');
const account = resolveAccount(valueOf('--user'));
const payload = buildExport(account.id, { includeSecrets });
const json = JSON.stringify(payload, null, 2);

if (has('--stdout')) {
  process.stdout.write(`${json}\n`);
  process.exit(0);
}

const target = path.resolve(
  valueOf('--out') ||
    `glassboard-${instanceId()}-${account.username}-${new Date().toISOString().slice(0, 10)}${includeSecrets ? '-with-secrets' : ''}.json`
);
fs.writeFileSync(target, json, { mode: includeSecrets ? 0o600 : 0o644 });

console.log(`Configuration of "${account.username}" exported to ${target}`);
console.log(`  tiles: ${payload.config.tiles.length}, shortcuts: ${payload.config.links.length}`);
if (payload.containsSecrets) {
  console.warn('  WARNING: this file contains credentials in plain text. Keep it private.');
} else {
  console.log('  secrets: not included (use --include-secrets to add them)');
}

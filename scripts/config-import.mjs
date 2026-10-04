#!/usr/bin/env node
// Restore a dashboard configuration from an exported file.
//
//   npm run config:import -- backup.json
//   npm run config:import -- backup.json --user alice
//   npm run config:import -- backup.json --include-secrets
import fs from 'node:fs';
import path from 'node:path';
import { importExport } from '../server/store.js';
import { resolveAccount } from './account.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};
// The value of --user is not the file, even though it does not start with a
// dash: without this, "--user alice backup.json" would import "alice".
const userValue = valueOf('--user');
const file = args.find((arg) => !arg.startsWith('-') && arg !== userValue);

if (!file || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: npm run config:import -- <file.json> [--user <name>] [--include-secrets]

  --user <name|id>    Which account to import into. Optional while the instance
                      has only one; required as soon as it has several.
  --include-secrets   Also restore credentials contained in the file

The current configuration is written to the backups folder in your data
directory before anything is changed.`);
  process.exit(file ? 0 : 1);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
} catch (error) {
  console.error(`Cannot read ${file}: ${error.message}`);
  process.exit(1);
}

const account = resolveAccount(userValue);

try {
  const result = importExport(account.id, payload, { includeSecrets: args.includes('--include-secrets') });
  console.log(`Configuration imported into "${account.username}".`);
  console.log(`  previous configuration saved to ${result.backup}`);
  if (result.restored.secrets.length) console.log(`  secrets restored: ${result.restored.secrets.join(', ')}`);
  if (result.warnings.length) {
    console.warn('  the file needed fixing up:');
    result.warnings.forEach((warning) => console.warn(`    - ${warning}`));
  }
  console.log('  restart is not required: the dashboard reads the new configuration on its next load.');
} catch (error) {
  console.error(`Import refused: ${error.message}`);
  (error.details || []).forEach((detail) => console.error(`  - ${detail}`));
  process.exit(1);
}

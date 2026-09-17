#!/usr/bin/env node
// Restore a dashboard configuration from an exported file.
//
//   npm run config:import -- backup.json
//   npm run config:import -- backup.json --include-secrets
import fs from 'node:fs';
import path from 'node:path';
import { importExport } from '../server/store.js';

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('-'));

if (!file || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: npm run config:import -- <file.json> [--include-secrets]

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

try {
  const result = importExport(payload, { includeSecrets: args.includes('--include-secrets') });
  console.log('Configuration imported.');
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

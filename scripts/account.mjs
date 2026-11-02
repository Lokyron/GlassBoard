#!/usr/bin/env node
// Shared by the two configuration scripts: turn --user into an account.
import { listAccounts } from '../server/auth.js';

/* Which account. The scripts used to have no such question: there was one
   configuration and one of everything. Now the answer has to be explicit as
   soon as there is more than one account, because silently picking the first
   would mean exporting, or worse overwriting, the wrong person's dashboard. */
export function resolveAccount(nameOrId) {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    console.error('This instance has no account yet. Open /setup first.');
    process.exit(1);
  }
  if (!nameOrId) {
    if (accounts.length === 1) return accounts[0];
    console.error('This instance has several accounts, so --user is required:');
    accounts.forEach((a) => console.error(`  ${String(a.id).padStart(3)}  ${a.username}${a.role === 'admin' ? '  (administrator)' : ''}`));
    process.exit(1);
  }
  const wanted = String(nameOrId).trim().toLowerCase();
  const found = accounts.find((a) => a.username === wanted || String(a.id) === wanted);
  if (!found) {
    console.error(`No account called "${nameOrId}". Known accounts: ${accounts.map((a) => a.username).join(', ')}`);
    process.exit(1);
  }
  return found;
}

// Self-update, without ever giving the web application the right to write its
// own code.
//
// The app only drops a request file in its data directory. A systemd path unit
// watching that file runs the updater as root, which downloads the new version,
// installs it and restarts the service, then writes its progress to a status
// file the app reads back. See deploy/ for the units and the script.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT_DIR, UPDATE_ENABLED, UPDATE_REPO, UPDATE_BRANCH, UPDATE_CHECK_HOURS } from './env.js';

const REQUEST_FILE = path.join(DATA_DIR, 'update.request');
const STATUS_FILE = path.join(DATA_DIR, 'update.status');
const VERSION_FILE = path.join(ROOT_DIR, 'VERSION');

let lastCheck = null; // { at, commit, message, date }

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** What is installed: written by the updater, or unknown on a manual install. */
export function installedVersion() {
  const fromFile = readJson(VERSION_FILE);
  const pkg = readJson(path.join(ROOT_DIR, 'package.json'));
  return {
    version: pkg?.version ?? null,
    commit: fromFile?.commit ?? null,
    branch: fromFile?.branch ?? null,
    installedAt: fromFile?.installedAt ?? null,
  };
}

/** Ask GitHub for the head of the tracked branch. Cached, so a tab left open does not hammer it. */
export async function checkForUpdate({ force = false } = {}) {
  const maxAge = Math.max(1, UPDATE_CHECK_HOURS) * 3_600_000;
  if (!force && lastCheck && Date.now() - new Date(lastCheck.at).getTime() < maxAge) return lastCheck;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/commits/${UPDATE_BRANCH}`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Glassboard' },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const data = await response.json();
    lastCheck = {
      at: new Date().toISOString(),
      commit: String(data.sha || '').slice(0, 40),
      message: String(data.commit?.message || '').split('\n')[0].slice(0, 120),
      date: data.commit?.committer?.date ?? null,
    };
    return lastCheck;
  } finally {
    clearTimeout(timer);
  }
}

export function updateStatus() {
  const status = readJson(STATUS_FILE);
  return status && typeof status.state === 'string' ? status : { state: 'idle' };
}

/** Drop the request file the updater watches for. */
export function requestUpdate() {
  if (!UPDATE_ENABLED) {
    const error = new Error('In-app updates are turned off on this instance.');
    error.code = 'disabled';
    throw error;
  }
  const running = updateStatus();
  if (running.state === 'running') {
    const error = new Error('An update is already running.');
    error.code = 'busy';
    throw error;
  }
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ state: 'running', step: 'requested', at: new Date().toISOString() }));
  fs.writeFileSync(REQUEST_FILE, `${new Date().toISOString()}\n`);
}

export function updateSettings() {
  return { enabled: UPDATE_ENABLED, repo: UPDATE_REPO, branch: UPDATE_BRANCH };
}

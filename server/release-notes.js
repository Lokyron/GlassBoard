// What changed, read out of CHANGELOG.md.
//
// The changelog is the source of truth rather than a second file written for
// the dialog: two lists of the same changes drift, and the one nobody reads is
// always the one that goes stale. The format is Keep a Changelog, which this
// repository follows, so the parser below only has to understand the handful
// of shapes that actually appear in it.
//
// It is **English**, like the README and unlike the interface. Release notes
// are content, not chrome: translating every entry into seven languages at
// every release is not a promise this project can keep, and a half-translated
// changelog is worse than an honest English one. The dialog around them is
// translated, and says which language the notes are in.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './env.js';

const CHANGELOG = path.join(ROOT_DIR, 'CHANGELOG.md');
/** How many sections a reader is shown at most. Someone who has not opened the
 *  dashboard in a year does not want the whole history in a modal. */
const MAX_SECTIONS = 4;
/** And how many bullets within one section, for the same reason. */
const MAX_ITEMS_PER_GROUP = 8;

/** Markdown inline formatting, removed: the dialog renders text, not HTML. */
const plain = (text) =>
  String(text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // [label](url) keeps the label
    .replace(/\*\*([^*]+)\*\*/g, '$1')          // bold
    .replace(/`([^`]+)`/g, '$1')                // code
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')      // italic
    .replace(/\s+/g, ' ')
    .trim();

/**
 * An entry, split at its headline.
 *
 * This changelog opens almost every bullet with a bold sentence that says what
 * the change is, and follows it with the detail. That is a headline and a body,
 * and flattening the two into one paragraph is what turns a what's-new dialog
 * into a wall of text — so the shape the author wrote is kept.
 *
 * Not every bold opening is a headline, though: some are the first words of a
 * sentence that carries on through them ("**A mail server, in Settings**, used
 * to send invitations"). What follows tells them apart — a continuation starts
 * with a lowercase letter or a comma, a headline does not — and a continuation
 * is put back together rather than broken in two.
 */
function splitLead(raw) {
  const bold = /^\s*\*\*(.+?)\*\*(.*)$/s.exec(raw);
  if (!bold) return { lead: '', text: plain(raw) };
  const [, boldText, rest] = bold;
  if (/^\s*[,;:]|^\s+[a-z]/.test(rest)) return { lead: '', text: plain(`${boldText}${rest}`) };
  return { lead: plain(boldText).replace(/[.:\s]+$/, ''), text: plain(rest) };
}

/**
 * Parse the changelog into sections.
 * @returns {Array<{version: string, released: boolean, date: string|null, summary: string,
 *                  groups: Array<{kind: string, items: Array<{lead: string, text: string}>}>}>}
 */
export function parseChangelog(markdown) {
  const sections = [];
  let section = null;
  let group = null;
  let item = null;

  const closeItem = () => {
    if (item && group) group.items.push(splitLead(item));
    item = null;
  };
  const closeGroup = () => {
    closeItem();
    if (group && group.items.length > 0 && section) {
      group.items = group.items.slice(0, MAX_ITEMS_PER_GROUP);
      section.groups.push(group);
    }
    group = null;
  };

  for (const line of String(markdown).split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading && !line.startsWith('###')) {
      closeGroup();
      // "1.8.0 — 2026-10-03", or just "Unreleased". Both dashes appear in the
      // wild, so neither is assumed.
      const [, title] = heading;
      const parts = title.split(/\s+[—–-]\s+/);
      const version = parts[0].trim();
      section = {
        version,
        released: !/^unreleased$/i.test(version),
        date: parts[1]?.trim() ?? null,
        summary: '',
        groups: [],
      };
      sections.push(section);
      continue;
    }
    if (!section) continue;

    const subheading = /^###\s+(.+?)\s*$/.exec(line);
    if (subheading) {
      closeGroup();
      group = { kind: plain(subheading[1]).toLowerCase(), items: [] };
      continue;
    }

    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet) {
      closeItem();
      item = bullet[1];
      continue;
    }

    // A bullet wrapped onto the next line: indented, and we are inside one.
    if (item !== null && /^\s+\S/.test(line)) {
      item += ` ${line.trim()}`;
      continue;
    }

    closeItem();
    // A paragraph straight under the version heading is its one-line summary.
    if (!group && line.trim() && section.summary === '') section.summary = plain(line);
  }
  closeGroup();

  return sections.filter((entry) => entry.groups.length > 0 || entry.summary);
}

let cached = null;

/** The changelog, parsed once and re-read when the file changes under us —
 *  which is exactly what an update does. */
export function releaseNotes() {
  try {
    const stat = fs.statSync(CHANGELOG);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (cached?.stamp === stamp) return cached.sections;
    const sections = parseChangelog(fs.readFileSync(CHANGELOG, 'utf8'));
    cached = { stamp, sections };
    return sections;
  } catch {
    // No changelog, or an unreadable one: the dialog simply never appears.
    return [];
  }
}

/** Compare two dotted versions. Anything unparseable sorts lowest. */
export function compareVersions(a, b) {
  const parse = (value) => String(value ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * The sections an account has not been shown yet.
 *
 * `seenVersion` is the released version they last acknowledged. Unreleased work
 * always counts as new, which is what makes this useful on the beta channel:
 * there, the package version does not move between builds, so a version
 * comparison alone would never show anything.
 *
 * On a first ever visit there is nothing to compare against, and dumping the
 * entire history into a modal would be a poor welcome, so only the top section
 * is offered.
 */
export function newsSince(seenVersion) {
  const sections = releaseNotes();
  if (sections.length === 0) return [];
  if (!seenVersion) return sections.slice(0, 1);
  const fresh = sections.filter(
    (entry) => !entry.released || compareVersions(entry.version, seenVersion) > 0
  );
  return fresh.slice(0, MAX_SECTIONS);
}

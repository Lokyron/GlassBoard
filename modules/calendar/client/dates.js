/* Dates, as this module needs them.
 *
 * All of it is local time. The server sends an event exactly as the feed
 * stated it — a plain YYYY-MM-DD for an all-day event, an instant for a timed
 * one — and placing either into a day is the browser's job, because the
 * browser is the only part of this that knows what timezone the reader is
 * in.
 *
 * Its own file because the card, the grid and the editor all need the same
 * answers, and three slightly different ways of asking "which day is this
 * event on" is how a calendar ends up disagreeing with itself. */
import { localDayKey } from '/assets/core/kernel.js';

export const DAY_MS = 86_400_000;

export const dayKey = localDayKey;

/** A day key read back as a Date at local midnight. */
export function fromDayKey(key) {
  const [year, month, day] = String(key).split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

export const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

/** "2026-10" for a date. */
export const monthKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

/** A month label shifted by whole months. */
export function shiftMonth(label, by) {
  const [year, index] = String(label).split('-').map(Number);
  return monthKey(new Date(year, index - 1 + by, 1));
}

export const firstOfMonth = (label) => {
  const [year, index] = String(label).split('-').map(Number);
  return new Date(year, index - 1, 1);
};

export const isSameMonth = (key, label) => String(key).slice(0, 7) === label;

/**
 * The six weeks a month grid draws.
 *
 * Six and not "as many as it takes": a grid that is five rows one month and
 * six the next makes the whole panel jump every time you page through it, and
 * the days from either side are worth seeing anyway.
 */
export function monthGrid(label, weekStartsMonday) {
  const first = firstOfMonth(label);
  const offset = (first.getDay() - (weekStartsMonday ? 1 : 0) + 7) % 7;
  const start = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** The weekday names in the reader's own language, in their own order. */
export function weekdayNames(locale, weekStartsMonday) {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  // The 4th of January 1970 was a Sunday, which makes it a convenient zero.
  return Array.from({ length: 7 }, (_, i) =>
    format.format(new Date(1970, 0, 4 + i + (weekStartsMonday ? 1 : 0))));
}

/* ------------------------------- the events ------------------------------- */

/**
 * Every day an event touches, as day keys.
 *
 * An all-day event's end is the day after the last one, as iCalendar has it,
 * so a one-day event spans one key and not two. A timed event that runs past
 * midnight shows on both days, which is what a reader expects of a night
 * shift or a long flight.
 */
export function daysOf(event) {
  if (event.allDay) {
    const start = fromDayKey(event.start);
    const endExclusive = event.end ? fromDayKey(event.end) : addDays(start, 1);
    const keys = [];
    for (let day = start; day < endExclusive && keys.length < 400; day = addDays(day, 1)) {
      keys.push(dayKey(day));
    }
    return keys.length ? keys : [dayKey(start)];
  }
  const start = new Date(event.start);
  const end = event.end ? new Date(event.end) : start;
  if (Number.isNaN(start.getTime())) return [];
  const keys = [dayKey(start)];
  /* The end instant itself is excluded: an event from 9 to midnight sharp
     belongs to the one day it was lived on, not to the next one as well. */
  for (let day = addDays(start, 1); day < end && keys.length < 400; day = addDays(day, 1)) {
    keys.push(dayKey(day));
  }
  return keys;
}

/** When an event starts, as an instant, for sorting and for "what is next". */
export const startsAt = (event) =>
  (event.allDay ? fromDayKey(event.start).getTime() : new Date(event.start).getTime());

/** When it is over, so something happening now still counts as happening. */
export const endsAt = (event) => {
  if (event.allDay) {
    const end = event.end ? fromDayKey(event.end) : addDays(fromDayKey(event.start), 1);
    return end.getTime();
  }
  const end = event.end ? new Date(event.end).getTime() : startsAt(event);
  return Number.isNaN(end) ? startsAt(event) : end;
};

/** day key -> the events on it, each already sorted by when it starts. */
export function byDay(events) {
  const map = new Map();
  for (const event of events) {
    for (const key of daysOf(event)) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(event);
    }
  }
  for (const list of map.values()) {
    // All-day first: it is the frame the timed events of that day sit in.
    list.sort((a, b) => (a.allDay === b.allDay ? startsAt(a) - startsAt(b) : a.allDay ? -1 : 1));
  }
  return map;
}

/* ------------------------------- formatting ------------------------------- */

export const timeOf = (event, locale) =>
  (event.allDay
    ? ''
    : new Date(event.start).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }));

export const rangeOf = (event, locale) => {
  if (event.allDay) return '';
  const from = new Date(event.start).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const to = event.end
    ? new Date(event.end).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : '';
  return to && to !== from ? `${from} – ${to}` : from;
};

export const longDay = (key, locale) =>
  fromDayKey(key).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });

export const monthTitle = (label, locale) =>
  firstOfMonth(label).toLocaleDateString(locale, { month: 'long', year: 'numeric' });

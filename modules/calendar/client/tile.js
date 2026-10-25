/* The calendar: a card in the sidebar, and the month behind it.
 *
 * This module draws no tile. Its place is the sidebar card that used to show
 * nothing but how far through the year we were — a percentage answers "what
 * is today" and never "what is today for" — and the year is still there, as
 * the thin bar along the bottom.
 *
 * The browser never talks to Google: it reads months the server has already
 * fetched and filed, which is what keeps the OAuth grant on the server and
 * the card's load off the request path. A month the reader pages to that the
 * server has not got is fetched once, in its worker, and cached like the
 * rest — so wandering back through last spring costs one call per month and
 * no more, however many times it is paged over.
 *
 * Writing goes the same way round: the panel sends four strings and a flag,
 * and Google's own idea of an event — its attendees, its reminders, its
 * conferencing — is never touched by an edit made here. That is deliberate.
 * An editor that round-trips fields it does not show is an editor that
 * quietly drops them. */
import {
  id, safe, esc, svg, el, state, moduleState, api, toast,
  openModal, closeModal, openDialog, closeDialog,
  field, textInput, checkbox, dialogFooter,
  onClockTick, yearProgress,
} from '/assets/core/kernel.js';
import {
  dayKey, fromDayKey, addDays, monthKey, shiftMonth, monthGrid, weekdayNames,
  isSameMonth, byDay, startsAt, endsAt, rangeOf, timeOf, longDay, monthTitle,
  localStamp, timeZone, defaultStart,
} from './dates.js';

/* How many events fit in a grid cell before the rest become a count. Three
   is what a cell holds at the panel's width without the row growing; past
   that the day is a block of text and the month stops being readable. */
const CHIPS_PER_DAY = 3;

const own = moduleState('calendar');
Object.assign(own, {
  status: own.status ?? null,
  months: own.months ?? new Map(),     // "2026-10" -> the server's answer
  loading: own.loading ?? new Set(),
  view: own.view ?? monthKey(new Date()),
  selected: own.selected ?? dayKey(new Date()),
  today: own.today ?? dayKey(new Date()),
  index: own.index ?? new Map(),       // token -> event, filled while painting
  card: own.card ?? null,
  error: own.error ?? '',
  wired: own.wired ?? false,
});

const settings = () => state.config?.integrations?.calendar ?? {};
const locale = () => state.config?.site?.locale || 'en';
const mondayFirst = () => settings().weekStartsMonday !== false;
const connected = () => own.status?.connected === true;

/* ------------------------------- the events ------------------------------- */

/** One event, one token: the id alone is not unique once a repeating event
 *  has been expanded into its occurrences. */
const token = (event) => `${event.calendarId}|${event.id}|${event.start}`;

/** The calendars as the settings hold them, for colours and for hiding. */
const chosenCalendars = () => new Map((settings().calendars ?? []).map((c) => [c.id, c]));

const colourOf = (event) => chosenCalendars().get(event.calendarId)?.colour || event.colour || '#0a84ff';

/**
 * The events of the given months, de-duplicated and filtered to what the
 * reader has asked to see.
 *
 * An event spanning a month boundary comes back in both months' answers, so
 * the token is what keeps it one event. A calendar switched off in the
 * settings is dropped here as well as server side: the cached month predates
 * the switch, and nobody expects to have to wait for a refresh to see a
 * checkbox take effect.
 */
function eventsOf(labels) {
  const chosen = chosenCalendars();
  const seen = new Map();
  for (const label of labels) {
    for (const event of own.months.get(label)?.events ?? []) {
      // Explicitly switched off, and not merely unknown: a calendar added in
      // Google since the last visit should appear, not vanish.
      if (chosen.get(event.calendarId)?.shown === false) continue;
      seen.set(token(event), event);
    }
  }
  return [...seen.values()].sort((a, b) => startsAt(a) - startsAt(b));
}

/** The months the upcoming list is read from: this one and the two after. */
const upcomingMonths = () => {
  const here = monthKey(new Date());
  return [here, shiftMonth(here, 1), shiftMonth(here, 2)];
};

/** What is still to come, nearest first. Something happening right now is
 *  still coming up — it is the thing the reader most wants named. */
function upcoming(limit = settings().upcomingCount ?? 5) {
  const now = Date.now();
  return eventsOf(upcomingMonths())
    .filter((event) => endsAt(event) >= now)
    .slice(0, limit);
}

/* --------------------------------- loading -------------------------------- */

async function loadStatus() {
  try {
    own.status = await api('/api/m/calendar/status');
    own.error = '';
  } catch (error) {
    own.error = error.message;
  }
}

async function loadMonth(label, { force = false } = {}) {
  if (!force && own.months.has(label)) return own.months.get(label);
  if (own.loading.has(label)) return null;
  own.loading.add(label);
  try {
    const payload = await api(`/api/m/calendar/month/${label}`);
    own.months.set(label, payload);
    own.error = '';
    return payload;
  } catch (error) {
    /* A month that cannot be fetched leaves whatever was there. An empty
       grid says less than yesterday's one with a word about why. */
    own.error = error.message;
    return null;
  } finally {
    own.loading.delete(label);
  }
}

const ensureMonths = (labels, options) =>
  Promise.all([...new Set(labels)].map((label) => loadMonth(label, options)));

/** The months the panel needs for the month it is showing: the grid spills
 *  into both neighbours, and a day shown is a day whose events are shown. */
const panelMonths = () => [shiftMonth(own.view, -1), own.view, shiftMonth(own.view, 1)];

/** Everything on screen, redrawn from what is now in hand. */
function paint() {
  paintCard();
  if (id('calendar-modal')?.classList.contains('open')) paintPanel();
}

/* ------------------------------ the side card ----------------------------- */

function cardMarkup() {
  const now = new Date();
  const today = dayKey(now);
  const next = upcoming(1)[0] ?? null;
  const year = yearProgress(now);
  const showYear = settings().showYearProgress !== false;

  const head = `<div class="lbl">${esc(t('cal.title'))}</div>`;

  const date = `<div class="cal-card-date">
      <div class="cal-card-num">${now.getDate()}</div>
      <div class="cal-card-when">
        <strong>${esc(now.toLocaleDateString(locale(), { weekday: 'long' }))}</strong>
        <span>${esc(now.toLocaleDateString(locale(), { month: 'long', year: 'numeric' }))}</span>
      </div>
    </div>`;

  const mini = miniMonth(monthKey(now), today);

  const nextLine = connected()
    ? (next
      ? `<div class="cal-card-next">
           <span class="cal-dot" style="background:${esc(colourOf(next))}"></span>
           <span class="cal-card-next-title">${esc(next.title || t('cal.untitled'))}</span>
           <span class="cal-card-next-when">${esc(whenShort(next))}</span>
         </div>`
      : `<div class="cal-card-next muted">${esc(t('cal.nothingUpcoming'))}</div>`)
    : `<div class="cal-card-next muted">${esc(t('cal.notConnectedShort'))}</div>`;

  const yearRow = showYear
    ? `<div class="cal-card-year">
         <div class="prog"><div style="width:${year.percent}%"></div></div>
         <div class="cal-card-year-sub">${esc(t('side.day'))} ${year.day} / ${year.total} · ${year.percent}%</div>
       </div>`
    : '';

  return `${head}${date}${mini}${nextLine}${yearRow}`;
}

/** The compact month on the card: the shape of the month, and a dot under
 *  every day that has something on it. No titles — there is no room for one,
 *  and the panel is one click away. */
function miniMonth(label, today) {
  const days = byDay(eventsOf([label]));
  const names = weekdayNames(locale(), mondayFirst());
  const cells = monthGrid(label, mondayFirst()).map((date) => {
    const key = dayKey(date);
    const classes = ['cal-mini-day'];
    if (!isSameMonth(key, label)) classes.push('out');
    if (key === today) classes.push('today');
    const busy = days.has(key) && isSameMonth(key, label);
    return `<div class="${classes.join(' ')}">${date.getDate()}${busy ? '<i class="cal-mini-dot"></i>' : ''}</div>`;
  });
  return `<div class="cal-mini">
      <div class="cal-mini-week">${names.map((name) => `<span>${esc(name.slice(0, 2))}</span>`).join('')}</div>
      <div class="cal-mini-grid">${cells.join('')}</div>
    </div>`;
}

/** "today 18:30", "Thu 09:00", "12 Nov" — as little as says it. */
function whenShort(event) {
  const start = new Date(startsAt(event));
  const key = dayKey(start);
  const time = timeOf(event, locale());
  if (key === own.today) return time || t('cal.today').toLowerCase();
  if (key === dayKey(addDays(new Date(), 1))) return `${t('cal.tomorrow')}${time ? ` ${time}` : ''}`;
  const day = start.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric' });
  return time ? `${day} ${time}` : day;
}

function paintCard() {
  if (!own.card?.isConnected) return;
  own.card.innerHTML = cardMarkup();
}

function buildCard() {
  const card = el('div', {
    class: 'wcard-s cal-card',
    role: 'button',
    tabindex: '0',
    'aria-haspopup': 'dialog',
    onclick: () => openPanel(card),
    onkeydown: (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openPanel(card);
    },
  });
  own.card = card;
  card.innerHTML = cardMarkup();
  /* The card is drawn from whatever is in hand and asks for the rest after.
     A sidebar that waits on the network is a sidebar that is blank on every
     page load. */
  ensureMonths(upcomingMonths()).then(paint);
  return card;
}

/* -------------------------------- the panel ------------------------------- */

function openPanel(origin = null) {
  openModal('calendar-modal', origin ?? own.card);
  paintPanel();
  // Status first: whether there is an account behind this decides most of
  // what the panel says, and it is one small request.
  loadStatus().then(() => ensureMonths(panelMonths())).then(paint);
}

const closePanel = () => closeModal('calendar-modal');

function goToMonth(label) {
  own.view = label;
  /* Paging to another month moves the selected day with it, to the same day
     of the month where there is one. Leaving the selection on a day the grid
     no longer shows would empty the day column for no reason a reader could
     see. */
  const dayOfMonth = Number(own.selected.slice(8, 10));
  const first = fromDayKey(`${label}-01`);
  const lastOfMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  own.selected = label === monthKey(new Date())
    ? dayKey(new Date())
    : dayKey(new Date(first.getFullYear(), first.getMonth(), Math.min(dayOfMonth, lastOfMonth)));
  paintPanel();
  ensureMonths(panelMonths()).then(paint);
}

function paintPanel() {
  const events = eventsOf(panelMonths());
  const days = byDay(events);

  safe(id('cal-title'), monthTitle(own.view, locale()));
  safe(id('cal-sub'), subtitle());

  const names = weekdayNames(locale(), mondayFirst());
  id('cal-weekdays').innerHTML = names.map((name) => `<div>${esc(name)}</div>`).join('');

  own.index = new Map(events.map((event) => [token(event), event]));

  id('cal-grid').innerHTML = monthGrid(own.view, mondayFirst())
    .map((date) => cell(date, days))
    .join('');

  paintDay(days);
  paintUpcoming();
  paintLegend(events);

  const add = id('cal-add');
  if (add) add.disabled = !connected();
}

function subtitle() {
  if (own.error) return own.error;
  if (!own.status) return '';
  if (!own.status.configured) return t('cal.noClient');
  if (!own.status.connected) return t('cal.notConnected');
  const stale = panelMonths().some((label) => own.months.get(label)?.stale);
  return stale
    ? t('cal.stale', { account: own.status.account || t('cal.yourCalendar') })
    : (own.status.account || t('cal.yourCalendar'));
}

function cell(date, days) {
  const key = dayKey(date);
  const list = days.get(key) ?? [];
  const classes = ['cal-cell'];
  if (!isSameMonth(key, own.view)) classes.push('out');
  if (key === own.today) classes.push('today');
  if (key === own.selected) classes.push('sel');

  const chips = list.slice(0, CHIPS_PER_DAY).map((event) => {
    const time = timeOf(event, locale());
    return `<button class="cal-chip${event.allDay ? ' all-day' : ''}" type="button" data-ev="${esc(token(event))}"
        style="--chip:${esc(colourOf(event))}" title="${esc(event.title || t('cal.untitled'))}">
        ${time ? `<span class="cal-chip-time">${esc(time)}</span>` : ''}
        <span class="cal-chip-title">${esc(event.title || t('cal.untitled'))}</span></button>`;
  });
  const more = list.length > CHIPS_PER_DAY
    ? `<div class="cal-more">${esc(t('cal.more', { n: list.length - CHIPS_PER_DAY }))}</div>`
    : '';

  return `<div class="${classes.join(' ')}" data-day="${key}">
      <div class="cal-cell-num">${date.getDate()}</div>
      <div class="cal-cell-events">${chips.join('')}${more}</div>
    </div>`;
}

function paintDay(days) {
  safe(id('cal-day-title'), longDay(own.selected, locale()));
  const list = days.get(own.selected) ?? [];
  id('cal-day').innerHTML = list.length
    ? list.map((event) => eventRow(event)).join('')
    : `<p class="cal-empty">${esc(connected() ? t('cal.nothingThisDay') : t('cal.notConnectedHint'))}</p>`;
}

function paintUpcoming() {
  const list = upcoming();
  id('cal-upcoming').innerHTML = list.length
    ? list.map((event) => eventRow(event, { withDay: true })).join('')
    : `<p class="cal-empty">${esc(connected() ? t('cal.nothingUpcoming') : t('cal.notConnectedHint'))}</p>`;
}

function eventRow(event, { withDay = false } = {}) {
  const when = event.allDay
    ? t('cal.allDay')
    : rangeOf(event, locale());
  /* startsAt gives local midnight for an all-day event and the instant for a
     timed one, so one call answers both. */
  const day = withDay
    ? `<span class="cal-row-day">${esc(new Date(startsAt(event)).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' }))}</span>`
    : '';
  return `<button class="cal-row" type="button" data-ev="${esc(token(event))}">
      <span class="cal-dot" style="background:${esc(colourOf(event))}"></span>
      <span class="cal-row-main">
        <span class="cal-row-title">${esc(event.title || t('cal.untitled'))}</span>
        <span class="cal-row-meta">${day}<span>${esc(when)}</span>${event.location ? `<span>${esc(event.location)}</span>` : ''}</span>
      </span>
      ${event.recurring ? svg('arrow-counter-clockwise', 'font-size:13px;opacity:.5') : ''}
    </button>`;
}

/** Which calendar each colour is, because a grid of coloured chips with no
 *  key is decoration. */
function paintLegend(events) {
  const seen = new Map();
  for (const event of events) {
    if (!seen.has(event.calendarId)) seen.set(event.calendarId, event);
  }
  const box = id('cal-legend');
  if (!box) return;
  box.hidden = seen.size < 2;
  box.innerHTML = [...seen.values()]
    .map((event) => `<span class="cal-legend-item"><span class="cal-dot" style="background:${esc(colourOf(event))}"></span>${esc(event.calendarName || event.calendarId)}</span>`)
    .join('');
}

/* -------------------------------- the editor ------------------------------ */

/** The calendars an event may be put in. Google's own name for the account's
 *  main calendar is "primary", which needs no lookup to use — so there is
 *  always at least one destination, even before the first sync answers. */
function writableCalendars() {
  const listed = (own.status?.calendars ?? []).filter((calendar) => calendar.writable);
  return listed.length ? listed : [{ id: 'primary', name: t('cal.primary'), writable: true }];
}

/**
 * Open an event, or a new one on the day given.
 *
 * One occurrence of a repeating event is shown and not offered for editing.
 * Changing it here would quietly move one Tuesday and leave the series where
 * it was, which is not what anybody means by dragging an event — so it goes
 * to Google's own interface, where the choice between "this one" and "all of
 * them" is a question the reader gets asked.
 */
function openEditor(event = null, onDay = null) {
  const editing = Boolean(event);
  const readOnly = Boolean(event && (event.recurring || !event.writable));
  const body = el('div', { class: 'pane cal-editor' });

  const start = event ? new Date(startsAt(event)) : defaultStart(onDay ?? own.selected);
  const end = event
    ? new Date(endsAt(event))
    : new Date(start.getTime() + 3_600_000);

  const draft = {
    calendarId: event?.calendarId || settings().defaultCalendarId || writableCalendars()[0].id,
    title: event?.title ?? '',
    allDay: event?.allDay ?? false,
    startDate: dayKey(start),
    startTime: localStamp(start).slice(11),
    /* An all-day event's end is the day after the last one, as Google states
       it. The editor shows the last day instead, because "the 3rd to the 4th"
       for a one-day event on the 3rd is a bug as far as a reader is
       concerned. */
    endDate: event?.allDay ? dayKey(addDays(new Date(endsAt(event)), -1)) : dayKey(end),
    endTime: localStamp(end).slice(11),
    location: event?.location ?? '',
    description: event?.description ?? '',
  };

  const title = textInput(draft.title, {
    placeholder: t('cal.titlePlaceholder'),
    oninput: (e) => { draft.title = e.target.value; },
    ...(readOnly ? { readonly: true } : {}),
  });

  const startDate = textInput(draft.startDate, { type: 'date', oninput: (e) => { draft.startDate = e.target.value; } });
  const startTime = textInput(draft.startTime, { type: 'time', oninput: (e) => { draft.startTime = e.target.value; } });
  const endDate = textInput(draft.endDate, { type: 'date', oninput: (e) => { draft.endDate = e.target.value; } });
  const endTime = textInput(draft.endTime, { type: 'time', oninput: (e) => { draft.endTime = e.target.value; } });

  const times = el('div', { class: 'cal-times' }, [startTime, endTime]);
  /* The whole field goes, label and all. Hiding the two inputs and leaving
     "Time" above the gap they left reads as a form that has broken. */
  const timeField = field(t('cal.time'), times);
  const applyAllDay = () => { timeField.hidden = draft.allDay; };
  const allDay = checkbox(t('cal.allDay'), draft.allDay, (value) => { draft.allDay = value; applyAllDay(); });
  applyAllDay();

  const calendar = el('select', { class: 'inp', onchange: (e) => { draft.calendarId = e.target.value; } });
  for (const option of writableCalendars()) {
    const node = el('option', { value: option.id, text: option.name });
    if (option.id === draft.calendarId) node.selected = true;
    calendar.appendChild(node);
  }
  /* An event does not move between calendars here: Google has no such
     operation, it is a delete and an insert, and doing that silently behind a
     dropdown is how an event loses its history. */
  if (editing) calendar.disabled = true;

  const location = textInput(draft.location, { oninput: (e) => { draft.location = e.target.value; }, ...(readOnly ? { readonly: true } : {}) });
  const description = el('textarea', {
    class: 'inp', rows: '3', oninput: (e) => { draft.description = e.target.value; },
    ...(readOnly ? { readonly: true } : {}),
  });
  description.value = draft.description;

  if (readOnly) {
    body.appendChild(el('p', {
      class: 'status',
      text: event.recurring ? t('cal.recurringHint') : t('cal.readOnlyHint'),
    }));
  }
  body.appendChild(field(t('cal.eventTitle'), title));
  body.appendChild(allDay);
  body.appendChild(field(t('cal.start'), startDate));
  body.appendChild(field(t('cal.end'), endDate));
  body.appendChild(timeField);
  body.appendChild(field(t('cal.calendar'), calendar));
  body.appendChild(field(t('cal.location'), location));
  body.appendChild(field(t('cal.description'), description));

  if (event?.link) {
    body.appendChild(el('a', {
      class: 'btn ghost', href: event.link, target: '_blank', rel: 'noopener',
      text: t('cal.openInGoogle'),
    }));
  }

  const payload = () => {
    const allDayNow = draft.allDay;
    return {
      calendarId: draft.calendarId,
      title: draft.title,
      allDay: allDayNow,
      start: allDayNow ? draft.startDate : `${draft.startDate}T${draft.startTime}:00`,
      // Back to Google's exclusive end for an all-day event.
      end: allDayNow ? dayKey(addDays(fromDayKey(draft.endDate), 1)) : `${draft.endDate}T${draft.endTime}:00`,
      location: draft.location,
      description: draft.description,
      timeZone: timeZone(),
    };
  };

  const save = async () => {
    try {
      if (editing) {
        await api(`/api/m/calendar/events/${encodeURIComponent(event.id)}`, { method: 'PATCH', body: payload() });
      } else {
        await api('/api/m/calendar/events', { method: 'POST', body: payload() });
      }
      closeDialog();
      toast(t(editing ? 'cal.updated' : 'cal.created'));
      await reload();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  const remove = async () => {
    if (!confirm(t('cal.confirmDelete', { name: event.title || t('cal.untitled') }))) return;
    try {
      await api(`/api/m/calendar/events/${encodeURIComponent(event.id)}?calendarId=${encodeURIComponent(event.calendarId)}`, { method: 'DELETE' });
      closeDialog();
      toast(t('cal.deleted'));
      await reload();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  const footer = dialogFooter(save, closeDialog, t('dlg.save'));
  if (readOnly) {
    footer.querySelector('.btn.primary')?.remove();
  } else if (editing) {
    footer.prepend(el('button', { class: 'btn ghost cal-danger', type: 'button', text: t('cal.delete'), onclick: remove }));
  }
  body.appendChild(footer);

  openDialog({
    title: editing ? (event.title || t('cal.untitled')) : t('cal.newEvent'),
    subtitle: editing ? (event.calendarName || '') : longDay(onDay ?? own.selected, locale()),
    body,
  });
}

/** After a write: the server has dropped its cached months, so ours go too. */
async function reload() {
  own.months.clear();
  await ensureMonths([...new Set([...panelMonths(), ...upcomingMonths()])], { force: true });
  paint();
}

/* ------------------------------- the contract ----------------------------- */

const eventFrom = (node) => own.index.get(node?.dataset.ev ?? '') ?? null;

export default {
  id: 'calendar',

  /* No tile. This module's surface is the sidebar card, which the core asks
     for through the slot it added for exactly this. */
  tiles: {},

  sidebarCards: () => [{
    /* It stands in for the core's own year card: everything that card said is
       on this one, along with the date and what is on today. */
    primary: true,
    render: buildCard,
  }],

  mounted() {
    if (own.wired) return;
    own.wired = true;

    id('calendar-modal')?.addEventListener('click', (event) => {
      if (event.target === id('calendar-modal')) closePanel();
    });
    id('cal-prev')?.addEventListener('click', () => goToMonth(shiftMonth(own.view, -1)));
    id('cal-next')?.addEventListener('click', () => goToMonth(shiftMonth(own.view, 1)));
    id('cal-today')?.addEventListener('click', () => {
      own.view = monthKey(new Date());
      own.selected = dayKey(new Date());
      paintPanel();
      ensureMonths(panelMonths()).then(paint);
    });
    id('cal-add')?.addEventListener('click', () => openEditor(null, own.selected));

    /* One listener for the grid rather than one per cell: the grid is redrawn
       on every paint, and forty-two cells with chips in them is a lot of
       listeners to attach and drop several times a minute. */
    id('cal-grid')?.addEventListener('click', (click) => {
      const chip = click.target.closest('[data-ev]');
      if (chip) {
        click.stopPropagation();
        const event = eventFrom(chip);
        if (event) openEditor(event);
        return;
      }
      const cell = click.target.closest('[data-day]');
      if (!cell) return;
      own.selected = cell.dataset.day;
      // A day in another month is also a request to go there.
      if (!isSameMonth(own.selected, own.view)) return goToMonth(own.selected.slice(0, 7));
      paintPanel();
    });
    id('cal-grid')?.addEventListener('dblclick', (click) => {
      const cell = click.target.closest('[data-day]');
      if (cell && connected() && !click.target.closest('[data-ev]')) openEditor(null, cell.dataset.day);
    });

    for (const box of ['cal-day', 'cal-upcoming']) {
      id(box)?.addEventListener('click', (click) => {
        const event = eventFrom(click.target.closest('[data-ev]'));
        if (event) openEditor(event);
      });
    }

    /* Midnight. The card names today, and a dashboard left open overnight
       showing yesterday is the kind of wrong that makes a reader stop
       trusting the rest of it. The core already ticks every second; this
       listens for the day to turn and does nothing the rest of the time. */
    onClockTick(() => {
      const today = dayKey(new Date());
      if (today === own.today) return;
      own.today = today;
      own.view = monthKey(new Date());
      own.selected = today;
      own.months.clear();
      ensureMonths(upcomingMonths()).then(paint);
    });

    loadStatus().then(paint);
  },

  refresh() {
    const months = id('calendar-modal')?.classList.contains('open')
      ? [...panelMonths(), ...upcomingMonths()]
      : upcomingMonths();
    loadStatus()
      .then(() => ensureMonths(months, { force: true }))
      .then(paint);
  },

  navEntries: () => [{
    icon: 'calendar',
    label: t('cal.title'),
    short: t('cal.title'),
    run: () => openPanel(),
  }],

  closeViews: () => { closePanel(); },
};

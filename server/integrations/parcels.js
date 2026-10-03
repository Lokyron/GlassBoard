// Parcel tracking.
//
// Provider: 17TRACK, from the official documentation at https://api.17track.net/en/doc
// (version 2.4). Endpoints used, all POST, all authenticated with the `17token`
// header, all taking and returning `{ code, data: { accepted, rejected } }`:
//   /register       -> declare tracking numbers, carrier auto-detected
//   /gettrackinfo   -> the current status and event history of declared numbers
//   /deletetrack    -> stop following a number
//   /getquota       -> quota_total / quota_used / quota_remain
//   /gettracklist   -> everything the account follows, however it was declared
//
// Quota discipline, which shapes the whole module: a unit is spent when a number
// is *registered*, not when its status is read. So registration happens once, on
// the explicit request of the user, and never automatically; reading statuses is
// free and batched, up to 40 numbers per call.
//
// A parcel can also be followed manually, with no provider at all: a label and a
// link to the order page. That is the only thing that works for an Amazon
// Logistics shipment (a `TBA…` number), which no third party can query.
import {
  getSecret, setSecret, listParcelRows, getParcelRow, findParcelByNumber,
  insertParcelRow, updateParcelInfo, deleteParcelRow,
  cacheGet, cacheSet, cacheDeletePrefix, now,
} from '../db.js';
import { encrypt, decrypt } from '../crypto.js';

const BASE_URL = 'https://api.17track.net/track/v2.4';
const SECRET_KEY = 'parcels.17track_key';
const MAX_PER_CALL = 40;      // documented limit of register and gettrackinfo
const MAX_IMPORT_PAGES = 20;  // a stop, so a surprising answer cannot loop for ever
const CACHE_KEY = 'parcels:list';
/* A number registered moments ago has nothing to say yet: the provider answers
   "within seconds after the tracking number is registered (sometime it may go
   over 5 minutes)". Caching that silence for the whole refresh window is what
   left a freshly added parcel empty for hours, so as long as one recent parcel
   is still waiting for its first answer the list is re-read in a minute. Past
   the window, silence is the answer and the normal rhythm resumes. */
const SETTLING_TTL_SECONDS = 60;
const SETTLING_WINDOW_MS = 30 * 60_000;

/* ------------------------------ credentials ------------------------------ */

/** A key that cannot be decrypted is no key: that happens when APP_SECRET
 *  changed under a restored database, and saying "configured" would only turn
 *  every call into a confusing failure. */
export function isConfigured() {
  return Boolean(apiKey());
}

const apiKey = () => decrypt(getSecret(SECRET_KEY));

export function setApiKey(key) {
  setSecret(SECRET_KEY, key ? encrypt(String(key).trim()) : null);
  cacheDeletePrefix('parcels:');
}

/* -------------------------------- transport ------------------------------ */

/**
 * One call to 17TRACK. The envelope carries a `code` of 0 on success and a
 * per-number `rejected` list, so a partial failure is normal and not an error.
 */
async function call(path, body, { timeoutMs = 20_000 } = {}) {
  const key = apiKey();
  if (!key) {
    const error = new Error('No 17TRACK API key is stored yet.');
    error.code = 'not_configured';
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { '17token': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (response.status === 401 || response.status === 403) {
      const error = new Error('17TRACK refused the API key.');
      error.code = 'bad_key';
      throw error;
    }
    if (response.status === 429) {
      const error = new Error('17TRACK is rate limiting the instance. Try again in a moment.');
      error.code = 'rate_limited';
      throw error;
    }
    if (!response.ok) throw new Error(`17TRACK answered ${response.status}`);
    if (payload && payload.code !== 0 && !payload.data) {
      throw new Error(payload.message || `17TRACK answered code ${payload.code}`);
    }
    return payload ?? {};
  } finally {
    clearTimeout(timer);
  }
}

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/* ------------------------------ normalisation ---------------------------- */

// The nine documented statuses, folded into the handful of states worth their
// own colour on a dashboard. Anything unknown lands on 'pending' rather than
// pretending to know.
const STATE_BY_STATUS = {
  NotFound: 'pending',
  InfoReceived: 'pending',
  InTransit: 'transit',
  OutForDelivery: 'delivery',
  AvailableForPickup: 'pickup',
  Delivered: 'delivered',
  DeliveryFailure: 'problem',
  Exception: 'problem',
  Expired: 'problem',
};

const stateOf = (status) => STATE_BY_STATUS[status] ?? 'pending';

/** Events come newest-first from some carriers and oldest-first from others. */
const byTimeDesc = (a, b) => (b.at ?? 0) - (a.at ?? 0);

const timeOf = (event) => {
  const raw = event?.time_utc || event?.time_iso || event?.time_raw;
  if (!raw) return null;
  const parsed = new Date(typeof raw === 'string' ? raw : String(raw));
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
};

const cleanEvent = (event) => ({
  at: timeOf(event),
  location: String(event?.location || '').trim(),
  description: String(event?.description_translation || event?.description || '').trim(),
  // An event carries no `status`: what it has is a milestone and a sub-status.
  status: event?.stage || event?.sub_status || null,
});

/** Turn one `accepted` entry of gettrackinfo into the shape the browser gets. */
function normalise(entry) {
  const info = entry?.track_info ?? {};
  const latest = info.latest_status ?? {};
  const metrics = info.time_metrics ?? {};
  // track_info.tracking.providers, and not track_info.providers: the carriers
  // sit one level deeper than they read in the documentation. Reading the wrong
  // path is silent -- an empty list of events and a nameless carrier, with the
  // status still arriving because it comes from latest_status -- which is
  // exactly how this went unnoticed. Confirmed against a live answer.
  const providers = Array.isArray(info.tracking?.providers) ? info.tracking.providers : [];
  const events = providers
    .flatMap((provider) => (Array.isArray(provider?.events) ? provider.events : []))
    .map(cleanEvent)
    .filter((event) => event.description || event.at)
    .sort(byTimeDesc)
    .slice(0, 40);

  const status = latest.status || 'NotFound';
  const lastEvent = info.latest_event ? cleanEvent(info.latest_event) : events[0] ?? null;

  return {
    status,
    state: stateOf(status),
    subStatus: latest.sub_status || null,
    carrier: {
      id: Number(entry?.carrier) || Number(providers[0]?.provider?.key) || null,
      name: providers[0]?.provider?.name || '',
    },
    lastEvent,
    destination: info.shipping_info?.recipient_address?.city || '',
    // Documented counters only. The API states no delivery estimate, so none is
    // shown rather than one being guessed.
    daysInTransit: Number.isFinite(Number(metrics.days_of_transit)) ? Number(metrics.days_of_transit) : null,
    daysSinceUpdate: Number.isFinite(Number(metrics.days_after_last_update)) ? Number(metrics.days_after_last_update) : null,
    events,
  };
}

/* --------------------------------- parcels -------------------------------- */

const shortId = () => `pcl-${Math.random().toString(36).slice(2, 10)}`;

const TRACKING_NUMBER = /^[A-Za-z0-9-]{5,50}$/; // the documented format

/** The stored row, plus its last known status, as the browser sees it. */
function present(row) {
  let info = null;
  try {
    info = row.info ? JSON.parse(row.info) : null;
  } catch {
    info = null;
  }
  return {
    id: row.id,
    label: row.label,
    trackingNumber: row.tracking_no,
    provider: row.provider,
    url: row.url,
    registered: Boolean(row.registered),
    createdAt: row.created_at,
    checkedAt: row.checked_at,
    status: info?.status ?? null,
    state: info?.state ?? (row.provider === 'manual' ? 'manual' : 'pending'),
    subStatus: info?.subStatus ?? null,
    carrier: info?.carrier ?? { id: row.carrier ?? null, name: '' },
    lastEvent: info?.lastEvent ?? null,
    destination: info?.destination ?? '',
    daysInTransit: info?.daysInTransit ?? null,
    daysSinceUpdate: info?.daysSinceUpdate ?? null,
    events: info?.events ?? [],
  };
}

/**
 * Follow a new parcel. A tracking number is declared to the provider right
 * away, which is the one operation that spends quota: it happens here and
 * nowhere else. Without a number the parcel is followed manually.
 */
// Amazon Logistics runs a closed network: registering one of its numbers would
// spend a credit to be told, at best, that nothing is known about it. Such a
// parcel is followed by hand even though it does carry a number.
const AMAZON_OWN_NETWORK = /^TBA\d/i;

export async function addParcel(
  { label = '', trackingNumber = '', carrier = null, url = '' } = {},
  { refreshMinutes = 180 } = {}
) {
  const number = String(trackingNumber || '').trim();
  const provider = number && !AMAZON_OWN_NETWORK.test(number) ? '17track' : 'manual';

  if (number && !TRACKING_NUMBER.test(number)) {
    const error = new Error('A tracking number is 5 to 50 letters, digits or hyphens.');
    error.code = 'bad_number';
    throw error;
  }
  if (!number && !String(label).trim()) {
    const error = new Error('Give at least a name or a tracking number.');
    error.code = 'empty';
    throw error;
  }
  if (number && findParcelByNumber(number)) {
    const error = new Error('This parcel is already being followed.');
    error.code = 'duplicate';
    throw error;
  }

  const row = {
    id: shortId(),
    label: String(label || '').trim().slice(0, 80),
    tracking_no: number,
    carrier: Number.isFinite(Number(carrier)) && Number(carrier) > 0 ? Number(carrier) : null,
    provider,
    url: String(url || '').trim().slice(0, 2000),
    status: '',
    info: null,
    registered: 0,
    created_at: now(),
    updated_at: now(),
  };

  if (provider === '17track') {
    const payload = await call('/register', [{
      number,
      ...(row.carrier ? { carrier: row.carrier } : { auto_detection: true }),
    }]);
    const rejected = payload?.data?.rejected?.[0];
    // -18019901 means the number was already registered on this account, which
    // is a success for us: it is followed, and it costs nothing to reuse.
    if (rejected && rejected.error?.code !== -18019901) {
      const error = new Error(rejected.error?.message || 'The provider refused this tracking number.');
      error.code = 'rejected';
      error.providerCode = rejected.error?.code ?? null;
      throw error;
    }
    const accepted = payload?.data?.accepted?.[0];
    if (accepted?.carrier) row.carrier = Number(accepted.carrier) || row.carrier;
    row.registered = 1;
  }

  insertParcelRow(row);
  cacheDeletePrefix('parcels:');
  // The parcel exists from here on, and the credit is spent either way. A first
  // read that fails or finds nothing must not make the whole call look like a
  // failure: the next one is a minute away.
  if (row.registered) {
    try {
      await refresh({ force: true, refreshMinutes });
    } catch { /* still settling upstream, or the API blinked */ }
  }
  return present(getParcelRow(row.id));
}

export async function removeParcel(id) {
  const row = getParcelRow(id);
  if (!row) {
    const error = new Error('Unknown parcel.');
    error.code = 'not_found';
    throw error;
  }
  // Tell the provider to stop following it, but never let that failure keep the
  // parcel on the dashboard: the user asked for it to go.
  if (row.registered && row.tracking_no) {
    try {
      await call('/deletetrack', [{ number: row.tracking_no, ...(row.carrier ? { carrier: row.carrier } : {}) }]);
    } catch { /* already gone upstream, or the API is down */ }
  }
  deleteParcelRow(id);
  cacheDeletePrefix('parcels:');
  return true;
}

/**
 * Read the status of every registered parcel, in as few calls as possible.
 * Free of quota, so the only thing worth throttling is politeness towards the
 * API: the answer is cached for `refreshMinutes`.
 */
export async function refresh({ force = false, refreshMinutes = 180 } = {}) {
  const rows = listParcelRows().filter((row) => row.registered && row.tracking_no);
  if (rows.length === 0) return { checked: 0 };
  if (!force && cacheGet(CACHE_KEY)) return { checked: 0, cached: true };

  const byNumber = new Map(rows.map((row) => [row.tracking_no.toLowerCase(), row]));
  let checked = 0;
  for (const batch of chunk(rows, MAX_PER_CALL)) {
    const payload = await call('/gettrackinfo', batch.map((row) => ({
      number: row.tracking_no,
      ...(row.carrier ? { carrier: row.carrier } : {}),
    })));
    for (const entry of payload?.data?.accepted ?? []) {
      const row = byNumber.get(String(entry.number || '').toLowerCase());
      if (!row) continue;
      const info = normalise(entry);
      updateParcelInfo(row.id, {
        status: info.status,
        info,
        carrier: info.carrier.id,
        checkedAt: now(),
      });
      checked += 1;
    }
  }
  // The cache entry is a timestamp, not the payload: the rows are the truth.
  const ttl = stillSettling() ? SETTLING_TTL_SECONDS : Math.max(300, refreshMinutes * 60);
  cacheSet(CACHE_KEY, { at: now() }, ttl);
  return { checked, settling: ttl === SETTLING_TTL_SECONDS };
}

/** True while a parcel added recently has yet to hear anything back. */
function stillSettling() {
  const limit = Date.now() - SETTLING_WINDOW_MS;
  return listParcelRows().some((row) => {
    if (!row.registered || !row.tracking_no) return false;
    const known = row.status && row.status !== 'NotFound';
    return !known && new Date(row.created_at).getTime() >= limit;
  });
}

/**
 * Everything the tile and the detail view need.
 * Never throws: a provider outage shows the last known statuses instead of
 * breaking the dashboard.
 */
export async function getParcels({ refreshMinutes = 180, hideDeliveredAfterDays = 3 } = {}) {
  let error = null;
  if (isConfigured()) {
    try {
      await refresh({ refreshMinutes });
    } catch (failure) {
      error = failure.message;
    }
  }

  const cutoff = Date.now() - Math.max(0, hideDeliveredAfterDays) * 86_400_000;
  const all = listParcelRows().map(present);
  // A parcel delivered a while ago is done with: it leaves the list on its own,
  // which is what keeps the tile readable without any housekeeping.
  const parcels = all.filter((parcel) => {
    if (parcel.state !== 'delivered') return true;
    const at = parcel.lastEvent?.at ?? (parcel.checkedAt ? new Date(parcel.checkedAt).getTime() : 0);
    return at >= cutoff;
  });

  const counts = { total: parcels.length, active: 0, delivered: 0, problem: 0 };
  for (const parcel of parcels) {
    if (parcel.state === 'delivered') counts.delivered += 1;
    else if (parcel.state === 'problem') counts.problem += 1;
    else counts.active += 1;
  }

  return {
    ok: true,
    configured: isConfigured() || all.some((parcel) => parcel.provider === 'manual'),
    hasKey: isConfigured(),
    parcels,
    hidden: all.length - parcels.length,
    counts,
    error,
    fetchedAt: now(),
  };
}

/* --------------------------- import from 17TRACK -------------------------- */

/**
 * Take over the numbers already registered on the account — the ones added by
 * hand on 17track.net, which come back with `data_origin: "Manual"`, as well as
 * any this dashboard registered itself.
 *
 * This spends nothing. The quota is charged when a number is declared, and
 * these already are: importing only ever reads, so /register is never called
 * here. That is the whole point of the operation, and the reason it may be run
 * as often as wanted.
 */
export async function importFromProvider({ refreshMinutes = 180 } = {}) {
  const items = [];
  let pageSize = null;
  for (let page = 1; page <= MAX_IMPORT_PAGES; page += 1) {
    const payload = await call('/gettracklist', { page_no: page });
    const accepted = payload?.data?.accepted ?? [];
    items.push(...accepted);
    if (accepted.length === 0) break;
    // The page size belongs to the provider: the first page sets it, and a
    // shorter page after that is the last one.
    if (pageSize === null) pageSize = accepted.length;
    if (accepted.length < pageSize) break;
  }

  let imported = 0;
  let known = 0;
  for (const item of items) {
    const number = String(item?.number || '').trim();
    if (!number || !TRACKING_NUMBER.test(number)) continue;
    if (findParcelByNumber(number)) {
      known += 1;
      continue;
    }
    const registeredAt = item.register_time ? new Date(item.register_time) : null;
    insertParcelRow({
      id: shortId(),
      // Whatever the account was told about the parcel, in order of usefulness;
      // the tile falls back to the number itself when there is nothing.
      label: String(item.remark || item.order_no || item.tag || '').trim().slice(0, 80),
      tracking_no: number,
      carrier: Number(item.carrier) || null,
      provider: '17track',
      url: '',
      status: '',
      info: null,
      registered: 1,
      created_at: registeredAt && !Number.isNaN(registeredAt.getTime()) ? registeredAt.toISOString() : now(),
      updated_at: now(),
    });
    imported += 1;
  }

  cacheDeletePrefix('parcels:');
  if (imported > 0) {
    // Free as well, and it is what turns the new rows into something to look at.
    try {
      await refresh({ force: true, refreshMinutes });
    } catch { /* the statuses will come on the next read */ }
  }
  return { imported, known, seen: items.length };
}

/** What is left of the provider's allowance, for the settings panel. */
export async function getQuota() {
  const payload = await call('/getquota', []);
  const data = payload?.data ?? {};
  return {
    total: Number(data.quota_total) || 0,
    used: Number(data.quota_used) || 0,
    remaining: Number(data.quota_remain) || 0,
    usedToday: Number(data.today_used) || 0,
  };
}

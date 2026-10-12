// Proxmox VE integration: the health of a node and the guests running on it.
//
// Endpoints used, from the Proxmox VE API (https://pve.proxmox.com/pve-docs/api-viewer/):
//   GET /api2/json/version            -> { version, release, repoid }
//   GET /api2/json/cluster/resources  -> every node, guest and storage in one answer
//
// One call for the whole picture rather than one per node and one per guest:
// `/cluster/resources` is what the Proxmox web interface's own summary reads,
// it answers on a standalone host as well as a cluster, and it means the number
// of requests does not grow with the number of containers.
//
// Authentication is an **API token**, never a password: it is sent as one
// header, it carries whatever role you gave it and nothing more, and Proxmox
// can revoke it on its own without touching an account. Glassboard asks for a
// read-only one (PVEAuditor) and never calls anything but GET.
//
// This is the one integration that does not go through global fetch. A Proxmox
// host serves its API over HTTPS with, almost always, a certificate it signed
// itself — so the request needs to be able to say, deliberately and per
// account, that this particular certificate is acceptable. node:https takes an
// agent for that; fetch does not.
import https from 'node:https';
import http from 'node:http';
import { cacheGet, cacheGetStale, cacheSet, cacheDeletePrefix, getSecret, setSecret } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';

/* How old a snapshot may be and still answer a reader who is watching.
 *
 * Ten seconds because that is `pvestatd`'s own beat: Proxmox recomputes these
 * figures about that often, so asking faster returns the same numbers twice.
 * It is a *freshness requirement on the read*, not a shorter cache: the entry
 * is still stored for the account's refresh interval, so the background job
 * keeps its own slow rhythm for a dashboard nobody is looking at. */
const LIVE_MAX_AGE_MS = 10_000;

const SECRET_TOKEN_ID = 'pve.tokenId';
const SECRET_TOKEN_SECRET = 'pve.tokenSecret';

/* Per account, like the credentials they come from: two people on one
   instance may well watch two different hypervisors. */
const cachePrefix = (userId) => `pve:${Number(userId)}:`;
const snapshotKey = (userId) => `${cachePrefix(userId)}snapshot`;

/** A Proxmox token id looks like `user@realm!tokenname`. Rejecting anything
 *  else here is what keeps a half-pasted value from becoming a header. */
const TOKEN_ID = /^[^\s:!@]+@[^\s:!@]+![A-Za-z0-9._-]+$/;
/** A hostname or an IP address. No scheme, no path, no port: those are separate
 *  settings, and accepting them here would let a URL smuggle in a path. */
const HOST = /^[A-Za-z0-9._-]+$|^\[?[0-9A-Fa-f:.]+\]?$/;

export const isValidTokenId = (value) => TOKEN_ID.test(String(value ?? ''));
export const isValidHost = (value) => HOST.test(String(value ?? ''));

/* ------------------------------ credentials ------------------------------ */

export const isConfigured = (userId) =>
  Boolean(getSecret(userId, SECRET_TOKEN_ID) && getSecret(userId, SECRET_TOKEN_SECRET));

export function credentialStatus(userId) {
  return {
    configured: isConfigured(userId),
    // The id is not the secret — it is the half you would read off the
    // Proxmox screen — so it comes back, and the secret never does.
    tokenId: decrypt(getSecret(userId, SECRET_TOKEN_ID)) || '',
  };
}

export function saveToken(userId, tokenId, tokenSecret) {
  const id = String(tokenId ?? '').trim();
  const secret = String(tokenSecret ?? '').trim();
  if (!TOKEN_ID.test(id)) {
    throw new Error('A Proxmox token id looks like "user@realm!tokenname".');
  }
  if (!secret) throw new Error('The token secret is required.');
  setSecret(userId, SECRET_TOKEN_ID, encrypt(id));
  setSecret(userId, SECRET_TOKEN_SECRET, encrypt(secret));
  cacheDeletePrefix(cachePrefix(userId));
}

export function forgetToken(userId) {
  setSecret(userId, SECRET_TOKEN_ID, null);
  setSecret(userId, SECRET_TOKEN_SECRET, null);
  cacheDeletePrefix(cachePrefix(userId));
}

/* -------------------------------- requests ------------------------------- */

/**
 * One GET against the Proxmox API.
 *
 * node:https rather than fetch, for the certificate (see the file header).
 * The body is read into memory whole, which is safe here because every
 * endpoint this module calls answers with a summary — the largest, a cluster
 * with a hundred guests, is a few tens of kilobytes. The cap is a guard
 * against something else answering on that port, not against Proxmox.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function request(path, { host, port, allowSelfSigned, tokenId, tokenSecret, timeoutMs = 10_000 }) {
  const transport = port === 80 ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        host,
        port,
        path,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Glassboard/1.0',
          Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}`,
        },
        // Deliberate, per account, and off unless the reader asked for it.
        rejectUnauthorized: !allowSelfSigned,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy();
            reject(new Error('The Proxmox host answered with far more than an API answer.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode === 401) {
            return reject(new Error('Proxmox refused the token. Check the id, the secret and the token\'s permissions.'));
          }
          if (response.statusCode !== 200) {
            return reject(new Error(`Proxmox answered ${response.statusCode}.`));
          }
          try {
            resolve(JSON.parse(text)?.data ?? null);
          } catch {
            reject(new Error('Proxmox answered something that is not JSON. Is this really the API port?'));
          }
        });
      }
    );

    req.on('timeout', () => { req.destroy(new Error(`${host} did not answer in time.`)); });
    req.on('error', (error) => reject(friendly(error, host, port)));
    req.end();
  });
}

/** The node errors a reader can actually act on, said in words they can act on. */
function friendly(error, host, port) {
  const code = error?.code;
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    const named = new Error('The Proxmox host presents a certificate it signed itself. Tick "accept a self-signed certificate" if this host is yours.');
    named.code = 'self_signed';
    return named;
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return new Error('The certificate does not name this host. Reach it by the name on the certificate, or accept a self-signed certificate.');
  }
  if (code === 'ECONNREFUSED') return new Error(`Nothing is listening on ${host}:${port}.`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Error(`${host} could not be resolved.`);
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return new Error(`${host} did not answer.`);
  return error instanceof Error ? error : new Error(String(error));
}

/** The connection details for an account: its settings plus its stored token. */
function connection(userId, settings) {
  const tokenId = decrypt(getSecret(userId, SECRET_TOKEN_ID));
  const tokenSecret = decrypt(getSecret(userId, SECRET_TOKEN_SECRET));
  if (!tokenId || !tokenSecret) {
    const error = new Error('No Proxmox token yet.');
    error.code = 'not_configured';
    throw error;
  }
  const host = String(settings?.host ?? '').trim();
  if (!HOST.test(host)) {
    const error = new Error('No Proxmox host yet.');
    error.code = 'not_configured';
    throw error;
  }
  return {
    host,
    port: Number(settings.port) || 8006,
    allowSelfSigned: settings.allowSelfSigned === true,
    tokenId,
    tokenSecret,
  };
}

/* -------------------------------- shaping -------------------------------- */

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
/** A ratio of two numbers, or null when the denominator says nothing. */
const ratio = (used, total) => (num(total) > 0 ? num(used) / num(total) : null);

/** A node, as the card and the panel read it. */
const shapeNode = (raw) => ({
  name: String(raw.node ?? ''),
  online: raw.status === 'online',
  cpu: num(raw.cpu),                 // already a fraction of the whole node
  cores: num(raw.maxcpu),
  memory: { used: num(raw.mem), total: num(raw.maxmem), share: ratio(raw.mem, raw.maxmem) },
  disk: { used: num(raw.disk), total: num(raw.maxdisk), share: ratio(raw.disk, raw.maxdisk) },
  uptime: num(raw.uptime),
});

/** A virtual machine or a container. */
const shapeGuest = (raw) => ({
  id: String(raw.id ?? `${raw.type}/${raw.vmid}`),
  vmid: num(raw.vmid),
  name: String(raw.name ?? `#${num(raw.vmid)}`),
  kind: raw.type === 'lxc' ? 'lxc' : 'qemu',
  node: String(raw.node ?? ''),
  running: raw.status === 'running',
  status: String(raw.status ?? 'unknown'),
  cpu: num(raw.cpu),
  cores: num(raw.maxcpu),
  memory: { used: num(raw.mem), total: num(raw.maxmem), share: ratio(raw.mem, raw.maxmem) },
  disk: { used: num(raw.disk), total: num(raw.maxdisk), share: ratio(raw.disk, raw.maxdisk) },
  uptime: num(raw.uptime),
});

/** A storage, kept for the panel's footer line. */
const shapeStorage = (raw) => ({
  name: String(raw.storage ?? ''),
  node: String(raw.node ?? ''),
  online: raw.status === 'available',
  used: num(raw.disk),
  total: num(raw.maxdisk),
  share: ratio(raw.disk, raw.maxdisk),
});

/**
 * Everything the tile and the panel need, from one answer.
 *
 * `/cluster/resources` returns nodes, guests, storages and pools in one list,
 * told apart by `type`. A template is a guest that cannot run, so it is left
 * out rather than counted among the stopped ones. Storage entries are
 * deduplicated by name: a shared storage appears once per node, and three
 * lines for one disk is three times the same bar.
 *
 * Exported for the tests, which is the only place the shape of a Proxmox
 * answer is written down — this module has no fixture of a live call.
 */
export function shapeSnapshot(resources, version) {
  const list = Array.isArray(resources) ? resources : [];
  const nodes = list.filter((row) => row.type === 'node').map(shapeNode);
  const guests = list
    .filter((row) => (row.type === 'qemu' || row.type === 'lxc') && num(row.template) !== 1)
    .map(shapeGuest);
  const seen = new Set();
  const storages = list
    .filter((row) => row.type === 'storage')
    .map(shapeStorage)
    .filter((storage) => {
      if (!storage.name || seen.has(storage.name)) return false;
      seen.add(storage.name);
      return true;
    });

  nodes.sort((a, b) => a.name.localeCompare(b.name));
  // Running first, then by id: the ones doing something are the ones read.
  guests.sort((a, b) => Number(b.running) - Number(a.running) || a.vmid - b.vmid);
  storages.sort((a, b) => a.name.localeCompare(b.name));

  return {
    nodes,
    guests,
    storages,
    version: version ? `${version.version ?? ''}${version.release ? `-${version.release}` : ''}` : '',
    fetchedAt: new Date().toISOString(),
  };
}

/* ------------------------------- the reads ------------------------------- */

/**
 * The snapshot for an account, from the cache when it is fresh.
 *
 * The job below keeps it warm, so a dashboard that has been open all day reads
 * memory. A miss still goes to Proxmox: it is the reader's own machine on
 * their own network, it answers in a few milliseconds, and the alternative is
 * an empty card for up to a minute after the token is saved.
 *
 * A host that has gone down does not blank the card: the last good snapshot is
 * served with `stale` set, and the card says when it was taken.
 *
 * `live` is a reader with the dashboard in front of them: they get a snapshot
 * no older than LIVE_MAX_AGE_MS, which is what caps the upstream rate however
 * fast the browser asks, and however many browsers are open. Nobody watching
 * means nothing fetched beyond the background job's own beat.
 */
export async function getSnapshot(userId, settings, { force = false, live = false } = {}) {
  const key = snapshotKey(userId);
  if (!force) {
    const fresh = cacheGet(key);
    if (fresh && !(live && olderThan(fresh.fetchedAt, LIVE_MAX_AGE_MS))) return { ...fresh, cached: true };
  }

  const where = connection(userId, settings);
  const ttl = Math.max(30, (Number(settings.refreshMinutes) || 2) * 60);
  try {
    const [resources, version] = await Promise.all([
      request('/api2/json/cluster/resources', where),
      // A failure here must not cost the whole snapshot: the version is a
      // line in the panel's footer, not the reason anybody opened it.
      request('/api2/json/version', where).catch(() => null),
    ]);
    const snapshot = shapeSnapshot(resources, version);
    cacheSet(key, snapshot, ttl);
    return { ...snapshot, cached: false };
  } catch (error) {
    const stale = cacheGetStale(key);
    if (stale) return { ...stale.value, cached: true, stale: true, error: error.message };
    throw error;
  }
}

/** Age of a snapshot, from the timestamp it carries. A missing or unreadable
 *  one counts as old: better one call too many than a figure frozen for good. */
function olderThan(fetchedAt, maxAgeMs) {
  const taken = new Date(fetchedAt ?? 0).getTime();
  return !Number.isFinite(taken) || Date.now() - taken > maxAgeMs;
}

/** Is the cached snapshot old enough that the job should fetch another? */
export function isSnapshotDue(userId) {
  return !cacheGet(snapshotKey(userId));
}

/**
 * A live check for the settings pane: does this host, port and token work?
 * Returns the node names, which is what the pane's node picker is filled with.
 */
export async function testConnection(userId, settings) {
  const where = connection(userId, settings);
  const resources = await request('/api2/json/cluster/resources', where);
  const snapshot = shapeSnapshot(resources, null);
  cacheDeletePrefix(cachePrefix(userId));
  return {
    nodes: snapshot.nodes.map((node) => node.name),
    guests: snapshot.guests.length,
  };
}

/* The Proxmox integration.
 *
 * The shaping is tested against a hand-written `/cluster/resources` answer
 * because that is the only place in the repository where the shape of a
 * Proxmox answer is written down. If Proxmox ever changes a field name, this
 * fixture is what has to be corrected — and the failure will say which field.
 *
 * Nothing here opens a socket: the shaping is a pure function, and the
 * credential handling touches the database only. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('pve');
const pve = await import('../server/integrations/pve.js');
const { db, now } = await import('../server/db.js');

/* A secret belongs to an account, and the table says so with a foreign key. */
const USER = db
  .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id')
  .get('tester', 'x', now()).id;

/** A standalone host with two containers, a virtual machine, a template and
 *  a storage that two nodes both report — the shapes that actually turn up. */
const RESOURCES = [
  {
    type: 'node', node: 'pve', status: 'online',
    cpu: 0.0731, maxcpu: 8,
    mem: 20_401_094_656, maxmem: 67_373_658_112,
    disk: 42_949_672_960, maxdisk: 100_861_726_720,
    uptime: 936_000,
  },
  {
    type: 'lxc', id: 'lxc/108', vmid: 108, name: 'dashboard', node: 'pve', status: 'running',
    cpu: 0.0042, maxcpu: 2, mem: 48_234_496, maxmem: 536_870_912,
    disk: 1_610_612_736, maxdisk: 8_589_934_592, uptime: 86_400,
  },
  {
    type: 'lxc', id: 'lxc/114', vmid: 114, name: 'media', node: 'pve', status: 'stopped',
    cpu: 0, maxcpu: 4, mem: 0, maxmem: 4_294_967_296,
    disk: 0, maxdisk: 53_687_091_200, uptime: 0,
  },
  {
    type: 'qemu', id: 'qemu/200', vmid: 200, name: 'desktop', node: 'pve', status: 'running',
    cpu: 0.21, maxcpu: 4, mem: 6_442_450_944, maxmem: 8_589_934_592,
    disk: 0, maxdisk: 137_438_953_472, uptime: 3_600,
  },
  // A template cannot run, so it is not a stopped guest.
  {
    type: 'qemu', id: 'qemu/9000', vmid: 9000, name: 'debian-template', node: 'pve',
    status: 'stopped', template: 1, maxcpu: 2, maxmem: 2_147_483_648,
  },
  { type: 'storage', storage: 'local', node: 'pve', status: 'available', disk: 10_737_418_240, maxdisk: 107_374_182_400 },
  { type: 'storage', storage: 'nas', node: 'pve', status: 'available', disk: 5_497_558_138_880, maxdisk: 10_995_116_277_760 },
  // The same shared storage, reported a second time by another node.
  { type: 'storage', storage: 'nas', node: 'pve2', status: 'available', disk: 5_497_558_138_880, maxdisk: 10_995_116_277_760 },
  // Pools and SDN zones come back in the same list and are none of our business.
  { type: 'pool', pool: 'production' },
];

describe('shaping a Proxmox answer', () => {
  const snapshot = pve.shapeSnapshot(RESOURCES, { version: '8.2.4', release: '8.2' });

  it('reads the node', () => {
    assert.equal(snapshot.nodes.length, 1);
    const [node] = snapshot.nodes;
    assert.equal(node.name, 'pve');
    assert.equal(node.online, true);
    assert.equal(node.cores, 8);
    // Proxmox already gives cpu as a fraction of the whole node, so it is
    // carried through rather than divided by maxcpu a second time.
    assert.equal(node.cpu, 0.0731);
  });

  it('turns used and total into a share, and never divides by zero', () => {
    const [node] = snapshot.nodes;
    assert.ok(Math.abs(node.memory.share - 0.3028) < 0.001);
    const noTotal = pve.shapeSnapshot([{ type: 'node', node: 'x', mem: 5, maxmem: 0 }], null);
    assert.equal(noTotal.nodes[0].memory.share, null, 'no total means no share, not Infinity');
  });

  it('keeps the guests that can run and drops the templates', () => {
    assert.deepEqual(snapshot.guests.map((guest) => guest.vmid), [108, 200, 114]);
  });

  it('puts what is running first', () => {
    assert.deepEqual(snapshot.guests.map((guest) => guest.running), [true, true, false]);
  });

  it('tells a container from a virtual machine', () => {
    const byId = Object.fromEntries(snapshot.guests.map((guest) => [guest.vmid, guest]));
    assert.equal(byId[108].kind, 'lxc');
    assert.equal(byId[200].kind, 'qemu');
  });

  it('counts a shared storage once', () => {
    assert.deepEqual(snapshot.storages.map((storage) => storage.name), ['local', 'nas']);
  });

  it('ignores the rows that are neither node, guest nor storage', () => {
    const kinds = [...snapshot.nodes, ...snapshot.guests, ...snapshot.storages];
    assert.ok(kinds.every((row) => row.name !== 'production'));
  });

  it('carries the version for the panel to show', () => {
    assert.equal(snapshot.version, '8.2.4-8.2');
  });

  it('survives an answer that is not a list', () => {
    for (const nonsense of [null, undefined, {}, 'nope']) {
      const empty = pve.shapeSnapshot(nonsense, null);
      assert.deepEqual([empty.nodes, empty.guests, empty.storages], [[], [], []]);
    }
  });

  it('names a guest that has none', () => {
    const [guest] = pve.shapeSnapshot([{ type: 'lxc', vmid: 42, node: 'pve', status: 'running' }], null).guests;
    assert.equal(guest.name, '#42');
  });
});

describe('the Proxmox token', () => {
  it('accepts the shape Proxmox hands out', () => {
    assert.ok(pve.isValidTokenId('glassboard@pve!dashboard'));
    assert.ok(pve.isValidTokenId('root@pam!read-only_1'));
  });

  it('refuses anything else, so a half-pasted value never becomes a header', () => {
    for (const bad of ['', 'glassboard@pve', 'glassboard!dashboard', 'a@b!c d', 'a@b!c\nX-Evil: 1', 'a@b!c=secret']) {
      assert.equal(pve.isValidTokenId(bad), false, bad);
    }
  });

  it('refuses a host that is really a URL', () => {
    assert.ok(pve.isValidHost('192.168.1.10'));
    assert.ok(pve.isValidHost('pve.example.org'));
    for (const bad of ['https://pve.example.org', 'pve.example.org/api2', 'pve:8006', 'a host']) {
      assert.equal(pve.isValidHost(bad), false, bad);
    }
  });

  it('says so rather than storing half a credential', () => {
    assert.throws(() => pve.saveToken(USER, 'not-a-token-id', 'secret'), /token id/);
    assert.throws(() => pve.saveToken(USER, 'glassboard@pve!dashboard', '  '), /secret/);
  });

  it('stores one, reports it without the secret, and forgets it', () => {
    pve.saveToken(USER, 'glassboard@pve!dashboard', 'd4f1e0a2-0000-4000-8000-000000000000');
    const status = pve.credentialStatus(USER);
    assert.equal(status.configured, true);
    assert.equal(status.tokenId, 'glassboard@pve!dashboard');
    assert.equal(status.tokenSecret, undefined, 'the secret never comes back');
    pve.forgetToken(USER);
    assert.equal(pve.credentialStatus(USER).configured, false);
  });
});

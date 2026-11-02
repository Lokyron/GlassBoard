/* The authentication flow, exercised against a throwaway database: password,
   TOTP enrolment, the five-minute challenge, recovery codes, lockout, and the
   rules that keep an instance from losing its last administrator. */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, removeDir } from './helpers.js';

const dir = isolate('auth');
process.env.LOGIN_MAX_ATTEMPTS = '3';
process.env.LOGIN_LOCKOUT_MINUTES = '15';

const auth = await import('../server/auth.js');
const { generate: totpGenerate } = await import('otplib');
const { decrypt } = await import('../server/crypto.js');

after(() => removeDir(dir));

/** A valid code for a user's enrolled secret, as the phone would show it. */
const codeFor = (user) => totpGenerate({ secret: decrypt(auth.findUserById(user.id).totp_secret) });
// otplib 13 is promise-based throughout, so this resolves rather than returns.

describe('accounts', () => {
  it('an instance with no user asks for setup', () => {
    assert.equal(auth.needsSetup(), true);
  });

  it('the first account created is the administrator', async () => {
    const user = await auth.createUser('alice', 'correct horse battery');
    assert.equal(user.role, 'admin');
    assert.equal(auth.needsSetup(), false);
  });

  it('the second account is not', async () => {
    const user = await auth.createUser('bob', 'correct horse battery');
    assert.equal(user.role, 'user');
  });

  it('refuses a duplicate username', async () => {
    await assert.rejects(() => auth.createUser('alice', 'correct horse battery'));
  });

  it('refuses a password under twelve characters', () => {
    assert.throws(() => auth.assertPasswordStrength('short'));
    assert.throws(() => auth.assertPasswordStrength('x'.repeat(201)));
    assert.doesNotThrow(() => auth.assertPasswordStrength('x'.repeat(12)));
  });

  it('will not demote the last administrator', () => {
    const alice = auth.findUserByName('alice');
    assert.equal(auth.adminCount(), 1);
    assert.throws(() => auth.setRole(alice.id, 'user'));
  });

  it('will not delete the last administrator', () => {
    const alice = auth.findUserByName('alice');
    assert.throws(() => auth.deleteUser(alice.id));
  });
});

describe('password', () => {
  it('accepts the right one and refuses the wrong one', async () => {
    const alice = auth.findUserByName('alice');
    assert.equal(await auth.checkPassword(alice, 'correct horse battery'), true);
    assert.equal(await auth.checkPassword(alice, 'correct horse batterz'), false);
    assert.equal(await auth.checkPassword(alice, ''), false);
    assert.equal(await auth.checkPassword(null, 'correct horse battery'), false);
  });

  it('is stored hashed, never in clear', () => {
    const alice = auth.findUserByName('alice');
    assert.ok(alice.password_hash.startsWith('$argon2'));
    assert.ok(!alice.password_hash.includes('correct horse battery'));
  });
});

describe('TOTP', () => {
  it('enrols, refuses a wrong code, accepts the right one', async () => {
    const alice = auth.findUserByName('alice');
    const { secret } = await auth.startTotpEnrolment(alice);
    assert.ok(secret);
    assert.equal(auth.findUserById(alice.id).totp_enabled, 0);

    await assert.rejects(() => auth.confirmTotpEnrolment(alice, '000000'));

    const codes = await auth.confirmTotpEnrolment(alice, await codeFor(alice));
    assert.equal(auth.findUserById(alice.id).totp_enabled, 1);
    assert.equal(codes.length, 10);
  });

  it('keeps the secret encrypted at rest', () => {
    const alice = auth.findUserByName('alice');
    const stored = auth.findUserById(alice.id).totp_secret;
    assert.ok(stored.length > 0);
    assert.notEqual(stored, decrypt(stored), 'the column is not the secret itself');
  });

  it('refuses anything that is not six digits', async () => {
    const alice = auth.findUserById(auth.findUserByName('alice').id);
    for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined]) {
      assert.equal(await auth.checkUserTotp(alice, bad), false);
    }
  });

  it('tolerates the spaces an authenticator app shows', async () => {
    const alice = auth.findUserById(auth.findUserByName('alice').id);
    const code = await codeFor(alice);
    assert.equal(await auth.checkUserTotp(alice, `${code.slice(0, 3)} ${code.slice(3)}`), true);
  });
});

describe('recovery codes', () => {
  it('each one works once', () => {
    const alice = auth.findUserByName('alice');
    const codes = auth.generateRecoveryCodes(alice.id, 4);
    assert.equal(auth.countUnusedRecoveryCodes(alice.id), 4);
    assert.equal(auth.useRecoveryCode(alice.id, codes[0]), true);
    assert.equal(auth.useRecoveryCode(alice.id, codes[0]), false, 'not a second time');
    assert.equal(auth.countUnusedRecoveryCodes(alice.id), 3);
    assert.equal(auth.useRecoveryCode(alice.id, 'not-a-code'), false);
  });

  it('a fresh batch replaces the previous one', () => {
    const alice = auth.findUserByName('alice');
    const old = auth.generateRecoveryCodes(alice.id, 4);
    auth.generateRecoveryCodes(alice.id, 4);
    assert.equal(auth.useRecoveryCode(alice.id, old[1]), false);
  });
});

describe('the five-minute challenge', () => {
  it('resolves to its user, and only once destroyed stops', () => {
    const alice = auth.findUserByName('alice');
    const { id } = auth.createChallenge(alice.id);
    const signed = auth.signSessionId(id);
    const resolved = auth.resolveChallenge(signed);
    assert.equal(resolved.user.id, alice.id);
    auth.destroyChallenge(id);
    assert.equal(auth.resolveChallenge(signed), null);
  });

  it('refuses a value that was not signed by this instance', () => {
    assert.equal(auth.resolveChallenge('made-up-value'), null);
    assert.equal(auth.resolveChallenge(''), null);
  });
});

describe('sessions', () => {
  it('a signed cookie resolves, a tampered one does not', () => {
    const bob = auth.findUserByName('bob');
    const session = auth.createSession(bob.id, 'node-test');
    const cookie = auth.signSessionId(session.id);
    assert.equal(auth.resolveSession(cookie).user.id, bob.id);
    assert.equal(auth.resolveSession(`${cookie}x`), null);
    auth.destroySession(session.id);
    assert.equal(auth.resolveSession(cookie), null);
  });

  it('signing out everywhere drops every session of that account', () => {
    const bob = auth.findUserByName('bob');
    auth.createSession(bob.id, 'a');
    auth.createSession(bob.id, 'b');
    assert.ok(auth.listSessions(bob.id).length >= 2);
    auth.destroyAllSessions(bob.id);
    assert.equal(auth.listSessions(bob.id).length, 0);
  });
});

describe('lockout', () => {
  it('locks after the configured number of failures, and a success resets it', () => {
    const bucket = `test:${Date.now()}`;
    for (let i = 0; i < 2; i += 1) auth.recordAttempt(bucket, false);
    assert.equal(auth.checkThrottle(bucket).locked, false);
    auth.recordAttempt(bucket, false);
    const locked = auth.checkThrottle(bucket);
    assert.equal(locked.locked, true);
    assert.ok(locked.retryInSeconds > 0);

    auth.clearAttempts(bucket);
    assert.equal(auth.checkThrottle(bucket).locked, false);
  });

  it('counts each bucket on its own', () => {
    const mine = `mine:${Date.now()}`;
    const theirs = `theirs:${Date.now()}`;
    for (let i = 0; i < 5; i += 1) auth.recordAttempt(mine, false);
    assert.equal(auth.checkThrottle(mine).locked, true);
    assert.equal(auth.checkThrottle(theirs).locked, false);
  });
});

describe('invitations', () => {
  it('a token is good once and then gone', async () => {
    const alice = auth.findUserByName('alice');
    const invite = auth.createInvitation({ username: 'carol', role: 'user', invitedBy: alice.id });
    assert.ok(auth.resolveInvitation(invite.token));
    const carol = await auth.acceptInvitation(invite.token, 'carol', 'correct horse battery');
    assert.equal(carol.username, 'carol');
    assert.equal(auth.resolveInvitation(invite.token), null);
  });

  it('refuses a token nobody issued', async () => {
    assert.equal(auth.resolveInvitation('nonsense'), null);
    await assert.rejects(() => auth.acceptInvitation('nonsense', 'dave', 'correct horse battery'));
  });
});

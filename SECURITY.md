# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue.

Use GitHub's private reporting: **Security → Report a vulnerability** on
<https://github.com/Lokyron/GlassBoard/security/advisories>. Include what you
found, how to reproduce it, and what an attacker could do with it. You will get
an answer as soon as possible; this is a spare-time project, so please allow a
few days before chasing.

Please do not test against someone else's instance, only your own.

## Supported versions

The latest commit on `main` is the supported version. There is no long-term
support branch.

## What is already in place

- Passwords hashed with **argon2id**; TOTP secrets and integration credentials
  encrypted with **AES-256-GCM** from `APP_SECRET`.
- Sign-in in two steps: a correct password opens no session, it issues a
  single-use challenge valid five minutes. Both steps share one lockout counter.
- Session cookies are signed, `HttpOnly`, `SameSite=Lax`, and `Secure` over
  HTTPS.
- Every page and every API route requires a session, except the sign-in and
  first-run screens.
- A strict Content-Security-Policy, no inline scripts, no third-party script or
  font.
- Shortcut URLs restricted to `http:` and `https:`, on both sides, so an
  imported file cannot smuggle in a `javascript:` link.
- Uploaded wallpapers are identified by their magic bytes, not by the name or
  the declared type, and capped at 4 MB.

## Your side of the deal

- Set a long random `APP_SECRET` and keep it out of git.
- Put Glassboard behind **HTTPS** if it is reachable from outside your network,
  and set `TRUST_PROXY=1` so the lockout counts real client addresses.
- Keep `HOST=127.0.0.1` when a reverse proxy sits in front.
- An export made with `--include-secrets` holds your integration credentials in
  clear text. Treat that file like a password.

## Out of scope

Reports about a missing security header on a page that needs no session, rate
limits on endpoints that do nothing, or automated scanner output with no working
proof are unlikely to lead anywhere.

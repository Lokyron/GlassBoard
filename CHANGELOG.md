# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- The GeoRide tile opens a detail view: the rides of the period on an
  interactive map, each with its own track, a list to pick one from, and
  figures that follow the selection. Periods of 24 hours, 7 days and 30 days.

## 1.0.0 — 2026-09-25

First public release.

### The dashboard

- Grid of shortcuts with folders, weather tiles and a GeoRide tile, all edited
  in place: add, configure, resize, rearrange, delete.
- Cards rearrange like a phone home screen: the card lifts and follows the
  pointer while the others slide out of the way. Works with a mouse and with a
  finger; a shortcut dropped on the middle of a folder is filed in it.
- Configuration lives on the server as one versioned JSON document, 20 revisions
  kept, exportable and importable from the interface or the command line.

### Account and security

- First run creates the only account: no default user, no default password.
- Two-step sign-in, password then TOTP, with QR enrolment, ten single-use
  recovery codes, argon2id hashing and a lockout after repeated failures.
- Encrypted integration credentials, signed `HttpOnly` session cookies, strict
  Content-Security-Policy.

### Looks and devices

- Six colour presets in light and dark, a shuffle button that cross-fades the
  whole page, and an uploadable wallpaper with dimming and blur.
- A phone layout: reordered for a thumb, four-column shortcut grid, bottom dock,
  bottom sheets, and support for notches, Dynamic Islands and home indicators.
- Installable as a Progressive Web App, with an offline page.
- Seven interface languages: English, French, Spanish, German, Italian,
  Portuguese and Dutch.

### Operations

- Runs on Node 24 with no native module, or in Docker.
- Hourly housekeeping: expired cache rows, expired sessions and sign-in
  challenges, map tile cache capped at 128 MB, SQLite write-ahead log folded
  back in.

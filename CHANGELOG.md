# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased — on the beta channel

### Added

- **Sign in by QR code.** The sign-in screen can show a code instead of asking
  for a password; a phone that already holds a session scans it with its own
  camera and approves. The waiting screen is handed a request id, which grants
  nothing but the right to wait: the power to approve travels only inside the QR
  code, so watching the network buys nothing. Both screens show the same
  four-character code to compare, and the approving device is told which
  browser, which address and how long ago, before anything is granted. A request
  lasts two minutes and can be spent once.
- **Open sessions**, under Settings → Account: which devices hold a session, how
  each one was opened and when it was last used, with a button to sign any of
  them out. A sign-in that can be granted with a camera is one worth being able
  to look at afterwards.

### Changed

- The dashboard uses the width it is given instead of stopping at 1520px and
  sitting in the middle of the screen. The gutter matches the top bar's own
  inset, so the sidebar lines up under the brand rather than drifting away from
  it. Growth stops at 2200px, because past that a tile is wider than it is
  readable.
- Between 820 and 1180 pixels the sidebar cards are laid across the row instead
  of stacked in a column that left most of the width empty, and the tiles wrap
  by their own readable width, two or three to a row.

### Fixed

- Below 1180px the tiles kept their desktop column widths and were crushed
  together: the breakpoint was written without `!important` and lost to the
  inline widths the resize handles write. The resize grip is now hidden wherever
  those widths no longer apply, instead of being a control that does nothing.

## 1.7.0 — 2026-09-30

Parcels can now be found in your mail.

### Added

- **Mailbox scan**: Glassboard reads an IMAP mailbox and proposes the tracking
  numbers it finds. Each one waits above the parcel list with a **Follow** and
  an **Ignore** button, because accepting is what spends a tracking credit. An
  ignored number is not offered again.
- Mails move the parcels they are about: an Amazon `TBA` shipment, which no
  third party can query, is followed by hand and its state advances from the
  subject lines Amazon sends. A parcel the tracking provider reports on is never
  moved this way, since a carrier feed beats a sentence in a subject.
- A read-only IMAP client written against RFC 3501, with no dependency: the
  mailbox is opened with `EXAMINE` and read with `BODY.PEEK`, so the server
  refuses any write. Quoted-printable and base64 parts are decoded, and links
  are lifted out of HTML before the tags are dropped, which is where a tracking
  number usually hides.
- **Settings → Parcels** gained the mailbox section, with a connection test that
  signs in and reports what failed without saving anything first.
- The scan also runs on the housekeeping timer, at most every `scanHours`.

### Fixed

- A suggestion whose parcel the provider refused stayed marked as accepted and
  was never offered again. It is now consumed only once the parcel exists.

## 1.6.0 — 2026-09-30

A parcels tile, and a beta channel for updates.

### Added

- **Parcels tile**, with a detail view listing every step each parcel has been
  through. A parcel with a tracking number is followed through
  [17TRACK](https://api.17track.net/en/doc), which detects the carrier itself; a
  parcel with no usable number is followed by hand, with a link to the order.
  That second way is the only one that works for an Amazon Logistics shipment
  (a `TBA` number), which no third party can query.
- The provider charges a credit when a number is registered and nothing when a
  status is read, so a number is declared once, on the explicit action of the
  user, and statuses are read in one batched request for the whole list. The
  settings panel shows the remaining allowance.
- Parcels delivered more than `hideDeliveredAfterDays` ago leave the list on
  their own.
- **A beta update channel**, next to the stable one in **Settings → About**.
  Stable follows `UPDATE_BRANCH`, beta follows the new `UPDATE_BETA_BRANCH`;
  switching installs that branch, in either direction. The request file the
  application writes names a channel and never a branch, so the unprivileged
  side cannot point the root updater at a ref of its choosing.
- `data-tp` translates a field's placeholder, the way `data-t` translates text.

### Changed

- The update check is cached per channel, and the About panel says which branch
  a version comes from.
- A failing update request answers `503` rather than `409`, which the browser
  reads as "this instance needs setting up" and acts on by leaving the page.

## 1.5.0 — 2026-09-26

The dashboard can now update itself, and the GeoRide tile opens on a map of
your rides.

### Changed

- The GeoRide detail view fetches the last 30 days once, in the background, and
  keeps the map between selections: picking another ride or another period no
  longer waits on the network or rebuilds the map.
- JSON responses are gzipped, without adding a dependency.

### Added

- **Settings → About**, with the installed version, the version the repository
  has, and an **Update now** button. The application only writes a request
  file; a systemd unit runs the updater as root, which installs the new version,
  restarts the service and rolls back if it does not start. Off by default; see
  `deploy/`.
- The GeoRide tile opens a detail view: the rides of the period on an
  interactive map, each with its own track, a list to pick one from, and
  figures that follow the selection. Periods of 24 hours, 7 days and 30 days.

### Housekeeping

- The repository was prepared for its readers: a README ordered the way a
  newcomer reads it, CONTRIBUTING, SECURITY, issue and pull request templates,
  and the French architecture notes moved to `docs/architecture.fr.md`.

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

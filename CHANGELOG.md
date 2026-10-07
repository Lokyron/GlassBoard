# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 2.0.1 — 2026-10-07

### Changed

- **The ride tracks are drawn on a canvas instead of one SVG path each.** A
  month is eighty polylines; with the default renderer each is an element in
  the document whose geometry is rewritten on every frame of every pan and
  every flight. On a desktop this changes nothing — measured at sixty frames
  a second either way — and it is the phone this is meant to help.
- **Selecting a ride stopped restyling the other seventy-nine**, and the map
  now takes its framing from the tracks' own bounding boxes rather than
  rebuilding an array of twelve thousand coordinates on every click. Flying to
  a ride is skipped entirely for a reader who asked for less motion.
- **The tile proxy fetches at most six tiles from OpenStreetMap at once, and
  never the same tile twice over.** Opening a map asks for a hundred-odd in
  the same instant and they all used to leave together, which is what their
  usage policy asks you not to do and what gets a burst throttled — a map
  that fills in slowly and out of order. Cached tiles are unaffected; the
  limit is only on going upstream. Measured: a hundred and twenty requests
  for sixty cold tiles now take less time than sixty did unlimited.

### Fixed

- **One bad answer could no longer throw you out of your own dashboard.** A
  401 or a 409 from any route sent the page to the sign-in or setup screen,
  which bounced a reader who was in fact signed in straight back to the
  dashboard — which asked again, and left again. A reload loop with nothing
  on screen to explain it. The session is now confirmed before the page goes
  anywhere, and a route that answers 401 on a live session gets an ordinary
  error, named in the console, instead of taking the page with it.
- **The motorcycle sat in the corner of its own pin.** Loading Leaflet on
  demand put its stylesheet after the dashboard's instead of before it, and
  the two style the same classes with the same specificity — so Leaflet's
  `display: block` quietly beat the rule that centres the icon. The map's
  background had lost its theme the same way.
- **A GeoRide sync that failed was retried every minute, for as long as it
  kept failing.** The marker that spaces attempts out was only written after a
  success, so an unreachable tracker meant sixty calls an hour to that
  account. A failed attempt now backs off too, more briefly than a successful
  one so that a tracker coming back is picked up quickly.

## 2.0.0 — 2026-10-07

### Added

- **Every feature is a module.** One folder under `modules/`, listed once in
  the registry: its tiles, the shape of its settings, its routes, its
  background work and its browser code all come from there. The core no
  longer knows that a weather tile or a motorcycle exists, and adding a
  feature no longer means editing five files that have nothing to do with it.
- **A switch per module, per account, in Settings → Modules.** It used to
  take two things to decide whether a feature was on — a flag in its settings
  and whether one of its tiles happened to be on the dashboard — and they
  could disagree. There is one answer now. Off means no tile, no route, no
  background work, and the browser does not even fetch the module's code. The
  tiles stay in the configuration, so switching it back on gives the
  dashboard back exactly as it was.
- **Tests, at last: 82 of them**, on `node:test` with no new dependency.
  `npm test` covers the configuration validator, the whole authentication
  flow, the module registry, the worker pool and an end-to-end run against a
  real server — setup, enrolment, the two-step sign-in, saving. It also links
  the entire browser module graph, which catches an import that no longer
  resolves or a binding nobody exports.

- **Several accounts on one instance.** The first account ever created is the
  instance's administrator; the role can be handed to anyone else afterwards,
  and taken back, as long as one administrator is always left standing.
  **Settings → Accounts** lists every account with how it was last used, and
  creates, promotes, signs out and deletes them.
- **Each account has its own everything.** Its own dashboard, shortcuts, tiles,
  wallpaper, revision history, parcels and mailbox suggestions, and its own
  GeoRide session, 17TRACK key and IMAP password. Two people on one instance
  follow two GeoRide accounts and two 17TRACK allowances, and neither can read
  the other's, by accident or otherwise. The only thing still shared is the
  cache of third-party answers, which is keyed by coordinates and holds nothing
  personal.
- **Two ways in for a new account.** An administrator either creates one
  outright, choosing a first password and passing it on; or sends a single-use
  invitation link, good for 48 hours, where the person chooses their own
  password so none ever passes through the administrator. Either way the second
  factor is enrolled by the person themselves, on first sign-in. The link is
  always shown to the administrator, so an instance with no mail server works
  exactly as well — it is carried over by hand.
- **A mail server, in Settings → Mail server**, used to send invitations and
  nothing else. SMTP with STARTTLS, direct TLS or neither, written against
  RFC 5321 with no new dependency, like the IMAP reader next door. The password
  is encrypted with `APP_SECRET`. A test button checks the settings on screen
  rather than the saved ones, and can send a message to an address of your
  choice.
- **Panels open out of what opened them.** A folder, a weather card, the rides
  and the parcels grow from the card you clicked and shrink back into it when
  you close them, instead of appearing in the middle and vanishing. The links
  inside a folder arrive one after another, left to right. Cards, buttons and
  menu entries answer a press before the panel has drawn anything. On a phone
  the bottom sheets keep rising from the bottom, which is their own idiom, and
  they now go back down rather than disappearing. All of it is off under
  `prefers-reduced-motion`, in the stylesheet and in the script both.
- **What changed, after an update.** The first time an account opens the
  dashboard on a build it has not seen, a dialog says what came with it, read
  straight out of this changelog so there is never a second list to keep in
  step. It is acknowledged per account and server-side, so a cleared browser
  does not bring it back, and it is reachable on purpose from **Settings →
  About** once dismissed. The notes themselves are in English, like this file
  and the README: the dialog around them is translated and says so.
- **Sunrise and sunset.** Both times sit on every weather tile, under the wind
  and the rain, and again in the heading of the detailed forecast. Above the
  polar circle, where Open-Meteo reports neither, nothing is shown rather than
  a pair of dashes that would read as a failure.
- **One interactive drawing of the day**, in place of the three static charts
  the forecast window used to hold. It carries the sun's course over a horizon,
  the moon and stars through the night, the temperature as a line with the past
  hours dimmed and the day's extremes marked, and the chance of rain as bars.
  Moving the pointer across it turns the heading into a reading of that hour:
  time, sky, temperature, what it feels like, rain and wind. A finger reads it
  by touch, and a keyboard by tabbing to it and using the arrow keys.

### Changed

- **The heavy work left the main thread, and this is the point of the
  release.** A GeoRide sync is a multi-megabyte parse of a month of positions
  followed by a filter per ride over the whole array; a mailbox scan is a
  hundred and fifty messages decoded and searched. Node serves every request
  on one thread, so while either ran, *nothing else on the instance was
  answered* — not another account's dashboard, not a configuration save, not
  the clock on the page. Both now run on a worker thread of their own.
- **A tile no longer waits for the work it needs.** The rides and the mailbox
  are brought up to date by scheduled jobs, so the routes read what is
  already on disk. Where a sync is still wanted and rides are already stored,
  it is started and not awaited: the motorcycle card used to sit empty for as
  long as the GeoRide API took to answer, up to fifteen seconds.
- **The browser code is a kernel and a set of modules.** `app.js` was 2268
  lines in which the renderer, the forecast, the map and the parcel list
  shared one scope; it is gone. A module's own state lives under its own
  name and cannot be reached by another.
- **Modules are fetched only when they are used.** A dashboard with no
  motorcycle on it never downloads the motorcycle code, and Leaflet — 148 kB
  that every single page load used to parse, map or no map — now arrives the
  first time a map is actually going to be drawn. The tile's map is built
  when the card comes into view rather than at render time.
- **Integration routes moved to `/api/m/<id>`.** `/api/integrations/*` is
  gone. Nothing to do: the dashboard was updated with them.
- The JSON body limit is a megabyte everywhere except the one route that
  genuinely needs more — importing a configuration with its wallpaper inlined.
  It was sixteen megabytes for every route on the instance.

- **The last month of GeoRide rides is kept on the server, not cached.** A
  month of riding is tens of thousands of GPS positions, a dozen megabytes of
  them, and the card used to fetch the whole month again every time a
  five-minute cache expired — which is what made opening it feel like loading a
  page, especially just after a page load. The rides are now written to the
  database as they are read, already thinned, and a sync asks GeoRide only for
  what has happened since the newest one on record. A page load that finds the
  month already there calls GeoRide not at all; one that finds it hours old
  fetches those hours. Only the first ever, on a new instance, fetches a month.
  The tile's figures come off the same rides, so it has stopped pulling a week
  of positions of its own just to work out a top speed.
- A sync leaves alone the positions of a ride that ended more than a quarter of
  an hour ago, since it will not gain another metre, and asks only for what came
  after it. A parked motorcycle costs well under a kilobyte to stay up to date.
- Rides that fall out of the retention window are dropped by the sync, and by
  the hourly housekeeping on an instance where GeoRide has since been switched
  off. The table stays the size of a month, about 8 kB a ride, whatever the
  mileage.
- **Refresh every (minutes)** under GeoRide has stopped meaning how long an
  answer may be served from a cache and now means how often GeoRide is asked.
  The answer itself is always on disk, so the card opens at the same speed
  whatever the setting — and whatever GeoRide is doing: when it cannot be
  reached at all, the stored month is served anyway and the card says it is
  behind, instead of the whole thing failing.
- `npm run config:export` and `npm run config:import` take `--user <name|id>`.
  It is optional while the instance has one account and **required** once it
  has several: picking the first one silently would mean exporting, or worse
  overwriting, the wrong person's dashboard.
- Automatic snapshots in `$DATA_DIR/backups/` carry the account in their name,
  since several of them now write into one directory.
- The hourly mailbox scan runs once per account that has one configured, one
  after another rather than at once: several IMAP connections leaving one
  address at the same moment is what a provider reads as abuse.
- An existing instance migrates itself on the first start: its single account
  becomes the administrator and keeps everything it already had. The tables
  that needed their key widened are rebuilt, in one transaction, and the
  rebuild is checked for dangling references before anything else happens.
- The forecast request now also asks Open-Meteo for the hourly apparent
  temperature, wind speed, weather code and day/night flag, and for the daily
  sunrise and sunset; it no longer asks for the hourly wind gusts, which only
  the chart that was removed ever read. Cached forecasts from the previous
  version are ignored rather than served without the new fields.
- The drawing is SVG rather than canvas, so the six presets and the light/dark
  switch drive its colours with no redraw. Rain keeps a blue of its own in
  every preset, as the sun keeps its amber: under Ember, an accent-coloured
  rain read as orange.

### Fixed

- **The GeoRide map panel said the module was switched off** while the tile
  beside it showed the motorcycle's position quite happily. The trips route
  was still testing a field the module switch replaced, so it read as
  undefined and the route answered "disabled" whatever the switch said.
- **The figures on the GeoRide tile could sit on top of each other.** They
  were four fixed columns with nothing to stop a long one overflowing, and a
  tile's width is set by its resize grip. Four across while the card is wide
  enough, two by two when it is not — never three, and never overlapping.
- **Removing the 17TRACK key from the settings did nothing.** `DELETE
  /parcels/:id` was declared before `DELETE /parcels/key`, matched first, and
  answered "Unknown parcel" while the key stayed where it was.
- The start-up line printed the port that was asked for rather than the one
  the socket actually got, which made binding to port 0 unusable.

- Dropping a shortcut on a folder to file it away never worked, although the
  hint under the editing bar had always said it would. A folder is aimed at by
  its middle, but its edges are crossed on the way in, and crossing an edge
  made the folder step aside at once — it was out from under the pointer before
  the middle was ever reached, so the gesture could only ever reorder. A folder
  now holds its ground for a moment, long enough to reach its middle, and only
  steps aside if you linger on its edge.
- The pencil on a shortcut opened the shortcut in a new tab as well as its
  settings. The shortcut is a link, and in editing mode it cancels its own
  navigation; the buttons on top of it stopped the click from travelling that
  far, so nothing cancelled anything. The link now cancels on the way down,
  before the buttons are reached.
- The mail server panel said nothing about Gmail needing an application
  password, while the mailbox panel next door had always said so — the same
  provider, the same requirement, and only one of the two warning about it.
  It now carries the warning, and a refusal that names that cause is answered
  with what to do about it rather than with the provider's status code.
- Clicking the motorcycle card while the dashboard was still fetching the month
  in the background started a second request for the same thirty days, next to
  the one already in the air. Whoever asks in the meantime now waits on that
  one.
- The forecast window picked out "today" by a UTC date, so east of Greenwich it
  highlighted and labelled the wrong day during the last hours of the evening.
- A clear sky at three in the morning was drawn with a sun.

## 1.8.0 — 2026-10-03

Sign in by scanning a code, and parcels that actually report.

### Added

- **Import from the 17TRACK account.** A button in the parcel window takes over
  every number the account already follows, including those added by hand on
  17track.net. It spends nothing: the quota is charged when a number is
  declared, and these already are, so the import only ever reads and can be run
  as often as wanted. Numbers already on the dashboard are left alone, and the
  provider's own remark or order number becomes the parcel's name.
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

- **The sign-in screens were redrawn.** A single column of fields became a card
  in two halves: the left one greets you by the hour, says the date and the
  time; the right one carries the step at hand, introduced by a small badge.
  They now also follow the colour preset chosen in the settings — until now
  they were always the default blue, whatever the dashboard behind them looked
  like, because nothing told them. Every colour comes from a theme token, so
  nothing had to be restated to make a preset carry through.
- The dashboard uses the width it is given instead of stopping at 1520px and
  sitting in the middle of the screen. The gutter matches the top bar's own
  inset, so the sidebar lines up under the brand rather than drifting away from
  it. Growth stops at 2200px, because past that a tile is wider than it is
  readable.
- Between 820 and 1180 pixels the sidebar cards are laid across the row instead
  of stacked in a column that left most of the width empty, and the tiles wrap
  by their own readable width, two or three to a row.

### Fixed

- **A parcel's history and its carrier name never arrived.** The carriers sit at
  `track_info.tracking.providers`, one level deeper than they were being read
  from. Nothing about this failed loudly: the status kept coming, because it is
  read elsewhere in the answer, so what showed was a parcel with a state, no
  carrier and no events at all. Confirmed against a live answer, which is the
  only thing that settled it — a real parcel that reads as empty turns out to
  carry fourteen events.
- **A parcel added by hand stayed blank for hours.** The provider answers
  "within seconds after the tracking number is registered, sometime over five
  minutes", so the status read taken immediately after registering almost always
  found nothing — and that silence was then cached for the full refresh window.
  While a parcel added in the last half hour is still waiting for its first
  answer, the list is re-read a minute later instead of three hours later; past
  that window, silence is the answer and the normal rhythm resumes. A first read
  that fails no longer makes the whole call look like a failure either: the
  parcel exists, and the credit is spent, whatever the provider says next.
- Adding a parcel ignored the configured refresh interval and used the default.
- **The mailbox proposed tracking numbers that were not tracking numbers.** Any
  token sitting in the query string of a link to a carrier's domain was taken
  for a parcel, so a marketing link to amazon.fr carrying `code=A1BCD2EFG` was
  offered as a shipment. A value now has to carry at least six digits in eight
  characters to count, the rule the path branch already applied — which keeps
  the shortest real formats, Mondial Relay's eight digits among them.
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

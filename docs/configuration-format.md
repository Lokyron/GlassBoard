# Configuration and export format

Glassboard stores its whole configuration as a single JSON document. Exports
wrap that document with a little metadata. Both are versioned independently:

- `formatVersion` — the envelope of an export file. Currently `1`.
- `version` (inside `config`) — the configuration document itself. Currently `1`.

An instance refuses a file whose `formatVersion` is higher than it understands,
and migrates older documents forward on import.

## Export envelope

```json
{
  "app": "glassboard",
  "formatVersion": 1,
  "configVersion": 1,
  "exportedAt": "2026-01-31T09:12:44.081Z",
  "containsSecrets": false,
  "config": { "...": "the document below" },
  "secrets": null
}
```

`app` and `formatVersion` are mandatory — a file without them is rejected.

When exported with secrets, `containsSecrets` is `true`, `secrets` holds the
credentials **in plain text**, and a `WARNING` field spells out what is inside:

```json
{
  "containsSecrets": true,
  "secrets": {
    "georide.email": "…",
    "georide.password": "…",
    "georide.token": "…"
  },
  "WARNING": "This file contains PLAINTEXT credentials (…)."
}
```

An import only restores secrets when it is explicitly asked to.

## Configuration document

```json
{
  "version": 1,
  "site": {
    "title": "Dashboard",
    "subtitle": "Home",
    "greeting": "",
    "sectionTitle": "Applications & folders",
    "locale": "en",
    "clockTimezone": "UTC",
    "clockLabel": "UTC"
  },
  "search": {
    "enabled": true,
    "action": "https://duckduckgo.com/",
    "param": "q",
    "placeholder": "Quick search…",
    "newTab": true
  },
  "appearance": {
    "preset": "default",
    "orbs": true,
    "wallpaper": { "enabled": false, "dim": 0.4, "blur": 0 }
  },
  "tiles": [
    { "id": "tile-local", "type": "weather-local", "span": 1.1, "settings": { "label": "" } }
  ],
  "links": [
    { "id": "lnk-1", "title": "Router", "url": "http://192.168.1.1/", "color": "#0a84ff", "icon": "wifi-high" },
    { "id": "fld-1", "title": "Media", "color": "#ea580c", "icon": "folder",
      "items": [
        { "id": "sub-1", "title": "Library", "url": "https://example.org/", "color": "#ea580c", "icon": "film-strip" }
      ] }
  ],
  "integrations": {
    "weather": {
      "enabled": true,
      "useBrowserGeolocation": true,
      "fallback": { "latitude": 48.8566, "longitude": 2.3522 },
      "reverseGeocoding": true,
      "refreshMinutes": 30
    },
    "georide": {
      "enabled": false,
      "trackerId": null,
      "trackerName": "",
      "periodDays": 7,
      "refreshMinutes": 5,
      "showMap": true
    }
  }
}
```

### Appearance

`preset` is one of `default`, `ember`, `forest`, `violet`, `rose`, `slate`. An
unknown value is refused rather than silently reset, so a typo in a hand-edited
file is reported. `orbs` toggles the animated background shapes. Under
`wallpaper`, `dim` is between `0` and `0.9` and `blur` between `0` and `24`
pixels; both only apply when `enabled` is true and an image has been uploaded.

The image itself is not part of the configuration document — it lives as a file
in the data directory. Exports carry it separately, in the `wallpaper` field of
the envelope:

```json
{ "wallpaper": { "mime": "image/jpeg", "updatedAt": "…", "data": "<base64>" } }
```

An image above 4 MB is omitted, and the envelope says so through
`wallpaperOmitted`.

### Tiles

`span` is the column weight inside the CSS grid: a tile with `span: 2` is twice
as wide as one with `span: 1`. Accepted range: `0.4` to `4`.

| `type` | Singleton | `settings` |
|---|---|---|
| `weather-local` | yes | `label` |
| `weather-secondary` | yes | `name`, `latitude`, `longitude`, `timezone` |
| `georide` | yes | — (configured under `integrations.georide`) |
| `note` | no | `heading`, `body` |

`site.locale` selects the interface language and the date/time formatting:
`en`, `fr`, `es`, `de`, `it`, `pt` or `nl`. An unknown value falls back to `en`.

`site.sectionTitle` and `search.placeholder` are labels you can override. Left
empty, they follow the chosen language instead of being frozen in one.

`search.newTab` sends the query to a new browser tab, which keeps the dashboard
open behind it. It defaults to `true`, including for a configuration saved
before the option existed.

### Links

An entry is either a **shortcut** (it has `url`) or a **folder** (it has
`items`), never both. Folders are one level deep. `icon` is a
[Phosphor](https://phosphoricons.com) name as bundled in
`public/assets/icons.js` and `icons-extra.js`; an unknown name falls back to a
generic link icon. `color` must be `#rrggbb`.

`url` must be absolute and use `http:` or `https:`. Anything else is refused.

## Validation

Imports and saves go through the same validator
(`server/config-schema.js`). It:

- rejects a document that is not an object, or whose `links`/`tiles` are not arrays;
- drops unknown fields rather than storing them;
- clamps numbers to their allowed range and reports it;
- replaces a malformed optional value with a safe default and reports it;
- fails the whole operation when a required value is unusable — for example a
  shortcut with a `javascript:` URL.

Errors are returned as a list of `path: problem` strings, so a hand-edited file
tells you exactly which entry to fix.

## Revisions

Every save appends a revision in the database; the last 20 are kept. They are
listed at `GET /api/config/revisions` and restored with
`POST /api/config/revisions/:id/restore` — a safety net for an edit you regret,
independent of the export files.

# Contributing to Glassboard

Thanks for taking a look. Issues and pull requests are both welcome, including
small ones: a typo, a wrong translation, a phone that lays the page out badly.

## Running it locally

```bash
git clone https://github.com/Lokyron/GlassBoard.git
cd GlassBoard
npm install
cp .env.example .env          # then set APP_SECRET
npm run dev                   # restarts on change
```

Then open <http://localhost:3000>, which sends you to `/setup` on a fresh
install. Your data goes to `./data`, which is git-ignored; delete that directory
to start over from nothing.

There is no build step and no test suite yet. Check your change by hand, in a
browser, in both light and dark mode, and at a phone width.

## House rules

- **Code and comments in English**, including commit messages. The interface
  itself is translated; the source is not.
- **No new dependency without a reason.** The whole point of this project is a
  small surface: four runtime dependencies, no front-end framework, no bundler,
  no CDN. If a dependency is genuinely the right answer, say why in the pull
  request.
- **Never commit personal data.** No real URLs, host names, IP addresses,
  coordinates, tokens or screenshots of your own instance. The example
  configuration in `server/default-config.js` is deliberately neutral, and the
  screenshots in `docs/images/` are blurred.
- **Keep the existing look.** Colours, spacing and layout come from
  `public/assets/base.css` and are shared with the themes; a change of palette is
  a theme, not an edit to the base.
- Comments explain *why*, not *what*. Match the style of the file you are in.

## Where things live

| Path | What it holds |
|---|---|
| `server/` | Express routes, SQLite storage, auth, integrations |
| `server/config-schema.js` | the validator: every field of the configuration document |
| `public/assets/app.js` | dashboard rendering |
| `public/assets/edit.js` | edit mode, dialogs, drag and drop |
| `public/assets/i18n.js` | all translations |
| `public/assets/*.css` | `base` (original look), `app-extra`, `themes`, `mobile` |
| `scripts/` | the export and import command line |
| `docs/` | configuration format, architecture notes (French) |

## Common changes

**Add a language.** In `public/assets/i18n.js`, add an entry to `LOCALE_NAMES`
and copy the `en` table. Missing keys fall back to English one at a time, so a
partial translation is already useful. Keep the keys in the same order.

**Add a theme.** One block of CSS variables in `public/assets/themes.css` plus
one entry in `THEME_PRESETS` (`server/config-schema.js`). Test it in light and
dark mode, with and without a wallpaper.

**Add a tile type.** One entry in `TILE_TYPES` (`server/config-schema.js`), one
renderer in `public/assets/app.js`, and, if it talks to an API, one module in
`server/integrations/` called from the server, never from the browser. The
configuration document carries its settings.

**Touch an integration.** Read the provider's own documentation and use the
endpoints it documents. Do not invent routes or fields, and never send
credentials to the browser.

## Pull requests

- One subject per pull request.
- Say what you changed and how you checked it. Screenshots help for anything
  visual.
- If it changes the configuration document, update
  [docs/configuration-format.md](docs/configuration-format.md) and bump the
  version there.
- If it changes behaviour a user can see, update the README.

## Reporting a security problem

Do not open a public issue: see [SECURITY.md](SECURITY.md).

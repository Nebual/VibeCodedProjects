# Fittown

A self-hosted nutrition, water and training diary for one household. Nuxt 4,
Tailwind v4, DaisyUI 5, SQLite, Google sign-in.

Built mobile-first — the daily diary is designed for a phone and works on a
desktop; it installs to a home screen as a PWA.

## What it does

- **Food diary** — breakfast / lunch / dinner / snacks, with calories, macros
  and ~35 micronutrients per entry
- **Local food database** — ~204,000 US and Canadian products imported from
  Open Food Facts, searchable offline with barcode lookup
- **Custom foods** — for anything the database doesn't have
- **Water** — quick-add in millilitres or fluid ounces
- **Fitness** — cardio and strength logging, with calorie estimates from MET
  values and your body weight
- **Trends** — intake, training and weight over 7/14/30 days

## Requirements

- **Node 24+** — the app uses the built-in `node:sqlite` module, so there is no
  native database dependency to compile
- **pnpm**

## Setup

```bash
nvm use 24            # or otherwise ensure node >= 24
pnpm install
cp .env.example .env  # then fill it in — see below
pnpm dev              # http://localhost:3000
```

### Environment

Everything lives in `.env`:

| Variable | Required | Purpose |
| --- | --- | --- |
| `NUXT_SESSION_PASSWORD` | yes | Encrypts the session cookie. Must be ≥ 32 chars. Generate with `openssl rand -base64 32`. |
| `NUXT_OAUTH_GOOGLE_CLIENT_ID` | yes | Google OAuth client ID |
| `NUXT_OAUTH_GOOGLE_CLIENT_SECRET` | yes | Google OAuth client secret |
| `FITTOWN_ALLOWED_EMAILS` | no | Comma-separated allow-list. Without it **any** Google account can sign in — set it if the app is reachable from the internet. |
| `FITTOWN_DB_PATH` | no | Database location. Defaults to `./data/fittown.db`. |
| `FITTOWN_DEV_LOGIN` | no | Set to `1` to enable a password-less dev login. Ignored entirely in production builds. |

### Google OAuth

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client ID** of type *Web application*.
2. Add an authorised redirect URI of `<your-origin>/auth/google`, for example:
   - `http://localhost:3000/auth/google` for local development
   - `https://fittown.example.com/auth/google` in production
   - add the LAN address too (`http://192.168.1.x:3000/auth/google`) if family
     members will reach it directly by IP
3. Copy the client ID and secret into `.env`.

Only verified Google email addresses are accepted. The first person to sign in
gets an account automatically; set `FITTOWN_ALLOWED_EMAILS` to restrict that.

## The food database

`data/fittown.db` ships pre-imported with ~204k US and Canadian products. To
rebuild or refresh it:

```bash
node scripts/import-off.mjs                    # US + Canada (default)
node scripts/import-off.mjs --countries=uk,au  # other regions
node scripts/import-off.mjs --countries=all    # everything (~4M products)
```

The importer streams Open Food Facts' 1.3 GB gzipped CSV straight from their
servers, filtering as it goes — the ~10 GB uncompressed file is never written
to disk. A US+Canada import takes about two minutes and produces a 79 MB
database.

Rows are upserted on `(source, barcode)`, so food IDs stay stable across
re-imports and existing diary entries never re-point at a different product.
Re-run it every few months to pick up new products.

Other maintenance scripts:

```bash
node scripts/fix-liquid-flags.mjs        # recompute ml-vs-g classification
node scripts/reset-user-data.mjs         # wipe personal data, keep the foods
node scripts/screenshots.mjs /tmp/shots  # visual check (needs playwright)
```

### Data quality

Open Food Facts is crowd-sourced and contains unit-entry mistakes, so the
importer defends against them:

- every nutrient is clamped to a physiologically possible ceiling — without
  this, one mistyped vitamin D value becomes 9,375,000 µg in a day's total
- stated calories are cross-checked against the Atwater estimate from the
  macros, and the macros win when the two disagree by more than 2× (a common
  error is kJ typed into the kcal field)
- nutrients the database doesn't record stay **null**, and the UI shows them as
  "not recorded" rather than 0 — you should be able to tell "no vitamin D" from
  "we don't know"

Roughly a third of OFF products carry usable nutrition data; the rest are
skipped at import.

## Deployment

```bash
pnpm build
node .output/server/index.mjs
```

Set the same environment variables in production, and point `FITTOWN_DB_PATH`
somewhere outside the app directory (e.g. `/var/lib/fittown/fittown.db`) so
upgrades never touch your data.

The database is a single SQLite file in WAL mode — back it up with:

```bash
sqlite3 /var/lib/fittown/fittown.db ".backup /backups/fittown-$(date +%F).db"
```

## Notes on design

**Dates are the user's, not the server's.** The browser's IANA timezone is
stored in a `fittown_tz` cookie and the server computes "today" in that zone.
A host in UTC serving a phone in Toronto would otherwise roll over to
tomorrow's diary at 8pm local time.

**All nutrition is stored per 100 g/ml.** Portion maths is then a single
multiply, and any serving size can be expressed against the same base.

**Exercise calories are opt-in.** Whether training widens the day's calorie
budget is a per-user setting — burn estimates are rough, and eating them back
automatically is how trackers mislead people.

**Barcode scanning uses the browser's native `BarcodeDetector`**, so there's no
scanning library in the bundle. It works in Chrome on Android and desktop;
Safari doesn't support it, so manual barcode entry is always offered alongside.

## Project layout

```
app/
  components/      diary UI, nutrient tables, barcode scanner
  composables/     useDiary (day data + mutations), useToday (timezone)
  pages/           diary, add, food/[id], food/new, fitness, trends, settings
  plugins/         timezone.client.ts
server/
  api/             REST endpoints
  db/              schema + exercise seed data
  routes/auth/     Google OAuth, dev login, logout
  utils/           db connection, auth guards, validation, search ranking
shared/            nutrient catalogue used by both sides
scripts/           OFF importer and maintenance tools
```

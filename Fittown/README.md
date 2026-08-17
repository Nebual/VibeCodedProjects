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
- **Recipes** — a mixture of foods logged as one thing. Name it, put what you
  like in it in whatever units you like, say how many servings it makes, and
  it's in the diary as "1 serving" or "whole recipe". Weigh the finished dish
  if you want to log it by weight too — see [Recipes](#recipes)
- **Any unit you like** — log a portion in grams, ounces, pounds, kilos or the
  packet's own serving, and see what it works out to before you save it
- **Water** — quick-add in millilitres or fluid ounces
- **Fitness** — your ten most recent activities are one tap away; the rest
  browse by category (cardio, gym, strength, mobility, sports, outdoors,
  household, work) or by search. Pick an effort level and get a calorie
  estimate from published MET values and your body weight
- **Body measurements** — weight plus anything else you track (bicep, waist,
  resting heart rate), logged from the diary on any day and charted on Trends
- **Calorie target calculator** — age, gender, height, weight and activity
  level give you a maintenance figure, then pick a rate of loss or gain
- **Macro split** — set protein/carbs/fat as percentages or grams; they stay
  in sync
- **Trends** — intake, training, weight and every custom measurement over
  7/14/30 days or a year
- **Friends** — add someone by email or by sending them a link, then see the
  trends, recipes and daily diary they choose to share, and copy their recipes
  into your own. You decide category by category what they see of yours — see
  [Friends and sharing](#friends-and-sharing)
- **Recipe links** — publish a recipe as a link anyone can open, with or
  without a Fittown account

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
| `NUXT_OAUTH_GOOGLE_CLIENT_SECRET` | yes | Google OAuth client secret. Server-side only — never reaches the browser. |
| `NUXT_OAUTH_GOOGLE_REDIRECT_URL` | no | Pins the OAuth callback URL. Only needed behind a reverse proxy that doesn't send `X-Forwarded-Proto` — see [Deployment](#behind-a-reverse-proxy-nginx-caddy-traefik). |
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

## Recipes

A recipe is a mixture of foods you log as one thing — chili, porridge, a
smoothie. Build one under **Recipes**: add ingredients through the same search
and barcode scanner you log with, in whatever units suit each one, and the
nutrition adds up as you go.

Two numbers decide how it appears in the diary:

- **Servings** — how many the recipe makes. This sets the serving size, so
  logging it is "1 serving" by default. "Whole recipe" is always there as well.
- **Final weight** — optional, and only worth filling in if you weighed the
  finished dish. Cooking changes what food weighs, and the ingredients can't
  tell you by how much, so **without it the recipe is logged in servings only**
  — no grams or ounces are offered, because the app would be guessing. Add it
  and the usual units come back.

A serving is always right either way: a quarter of the pot is a quarter of the
pot however much it weighs.

Two things worth knowing. Editing a recipe changes meals you have already
logged — nutrition is looked up live, not frozen at the time — and a recipe
you have logged can't be deleted until those diary entries are gone. And if
most of what's in the mixture doesn't record, say, iron, the recipe reports
iron as *not recorded* rather than summing the few ingredients that do; a
number built from a third of the food is worse than no number.

Re-importing the food database automatically re-totals every recipe, since the
foods underneath them have changed. After any other bulk edit, run
`node scripts/recompute-recipes.mjs` yourself.

## Friends and sharing

Two ways to add someone, because they answer different situations:

- **By email** — the address they sign in with. They get a prompt the next time
  they open Fittown, and nothing is shared until they accept it.
- **By link** — *Friends → New link*. Send it however you like; whoever opens
  it and signs in becomes your friend. Each link works **once**, expires after
  30 days, and can be cancelled before it's used. Useful for someone who
  doesn't have an account yet, since the page tells them who invited them
  before asking them to sign in.

A friend's page has up to three tabs — **Trends**, **Recipes** and **Diary** —
and their recipes also turn up under your own when you search for a food, with
their name against them.

Everything of theirs is **read-only**. Opening one of their recipes gives you
**Add recipe** and **Log food**, and both take a *copy* into your own recipes
first: yours to edit, and unaffected by anything they change later. Ingredients
that are their own custom foods are copied too, so the recipe still works if
they later delete theirs.

### Choosing what you share

**Settings → Sharing** has five switches, all on to begin with:

| Switch | What friends can see |
| --- | --- |
| Recipes | Your recipes, in their list and in their food search, and copyable |
| Food diary | What you ate on a given day, meal by meal |
| Weight | Your weight trend and any body measurements you track |
| Calories | Your daily calorie intake chart |
| Exercise | The calories and time you log from training |

They save the moment you flip them and apply to friends you already have. Turn
one off and that section stops being served, not merely hidden — the API
refuses it. Removing a friend cuts off everything immediately; recipes either
of you copied are your own rows and stay put.

### Sharing one recipe with anyone

A recipe's own page has **Share this recipe → Create link**. That link is
readable **without signing in** — the point is sending a recipe to someone who
doesn't use Fittown — and it is independent of the Friends list and of the
switches above. Anyone signed in can copy it into their own recipes.

**Stop sharing** kills the link (visitors get "no longer shared"). Copies people
already took are theirs and are unaffected.

Both link types are unguessable tokens, and they are bearer credentials: anyone
you forward one to can use it.

## Tests

```bash
pnpm test          # unit tests (Vitest) — pure logic and the schema migration
pnpm test:watch    # same, on file change
```

The end-to-end script drives the real app in a browser and needs a dev server
plus `FITTOWN_DEV_LOGIN=1`:

```bash
node scripts/e2e.mjs
```

Other maintenance scripts:

```bash
node scripts/fix-liquid-flags.mjs        # recompute ml-vs-g classification
node scripts/recompute-recipes.mjs       # re-total recipes after a bulk food edit
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

### Behind a reverse proxy (nginx, Caddy, Traefik)

If TLS is terminated at the proxy, the app is spoken to over plain HTTP and
**cannot tell that your visitors are on HTTPS** unless the proxy says so. Tell
it, or Google sign-in will fail with `redirect_uri_mismatch` — the app builds a
callback URL of `http://your.domain/auth/google`, which won't match the
`https://` URI registered in the Google console.

```nginx
server {
    server_name fittown.example.com;
    # … listen 443, ssl_certificate, etc.

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;   # ← the one that matters
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

        # WebSocket upgrade, harmless if unused.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

`X-Forwarded-Proto: https` is what flips the derived callback URL to `https://`.
`Host` matters too — without it the app sees `localhost:3000` and builds a
callback URL pointing at itself.

If you can't change the proxy, or would rather the flow didn't depend on a
header, pin the callback URL explicitly instead:

```
NUXT_OAUTH_GOOGLE_REDIRECT_URL=https://fittown.example.com/auth/google
```

That overrides the derivation entirely and wins regardless of what headers
arrive. It must exactly match an authorised redirect URI in the Google console.

## Notes on design

**Dates are the user's, not the server's.** The browser's IANA timezone is
stored in a `fittown_tz` cookie and the server computes "today" in that zone.
A host in UTC serving a phone in Toronto would otherwise roll over to
tomorrow's diary at 8pm local time.

**All nutrition is stored per 100 g/ml.** Portion maths is then a single
multiply, and any serving size can be expressed against the same base.

**Units are a display choice, never a storage one.** Weights are stored in kg,
heights in cm, volumes in ml, portions in grams — whatever you typed. Food and
body measurements have separate preferences, because plenty of households weigh
their food in grams and themselves in pounds, and the preference only decides
which unit a picker opens on. Every entry point still offers the others.

**The calorie target is an estimate, and says so.** Mifflin-St Jeor for resting
burn, the standard activity multipliers for the rest, 7,700 kcal per kilogram
of body weight. Predictive equations land within about 10% for most people, so
the app frames the result as a starting point to adjust once real weight data
comes in — and warns rather than blocks when a target goes below 1,200/1,500
kcal or a rate exceeds 1 kg a week.

**Effort levels come from measured data, not a multiplier.** Where the
[2024 Adult Compendium of Physical Activities](https://pacompendium.com/)
publishes separate light / moderate / vigorous rows for an activity, Fittown
carries all three and lets you choose. Scrubbing a bathroom floor is 2.0 METs
if you're dawdling and 6.5 if you're not — a factor of three that a single
average would throw away. Activities with only one measured value don't ask.
Effort is described by *breathing*, since that's the one cue people can apply
honestly across walking, mopping and squash alike.

**Activity level and logged exercise can double-count.** The multipliers
already include a typical week's training, so choosing anything above sedentary
shows a note explaining that only *beyond-normal* activity should be logged as
exercise — pointedly so when "add exercise calories" is also switched on.

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
  composables/     useDiary (day data + mutations), useToday (timezone),
                   usePortionOptions (the portion picker's logic)
  pages/           diary, add, food/[id], food/new, recipes, recipes/[id],
                   fitness, trends, settings, friends, friends/[id],
                   invite/[token] and r/[token] (both work signed out)
  plugins/         timezone.client.ts
server/
  api/             REST endpoints; friends/** is the only place one person
                   reads another's data, shared/recipes/[token] the only one
                   that answers without a session
  db/              schema + exercise seed data
  routes/auth/     Google OAuth, dev login, logout
  utils/           db connection, auth guards, validation, search ranking,
                   recipe roll-up and copying, the trends rollup, and the
                   friendship access gate
shared/            nutrient catalogue, portion units, body/energy maths,
                   recipe rules, sharing switches, invite/link rules
scripts/           OFF importer and maintenance tools
```

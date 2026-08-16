# Notes for agents working on Fittown

Fittown is a self-hosted nutrition / water / training diary for one family.
Read `README.md` first for what it does and how a human sets it up. This file
covers the things that will waste your time or silently break data if you
don't know them.

`InitialPrompts.md` holds the user's original brief, if you need the intent
behind a decision.

---

## 1. You cannot `pnpm install` in this directory

The project lives on a **virtiofs mount of the user's Windows drive**. Symlinks
fail outright (`EPERM`) and `rename`/`copyfile` fail intermittently
(`EACCES`/`ENOENT`), so pnpm dies partway through. `node-linker=hoisted` does
not help. A `mount --bind` of native storage over `node_modules` works for a
while and then the sandbox silently drops it, leaving dangling symlinks that
produce baffling "module not found" errors.

**Keep source here (it's the deliverable); run from a native-storage copy.**

```bash
SRC="/c/Users/ben11/Documents/Claude Experiments/Fittown"
RUN=/home/agent/fittown-run

rsync -a --delete \
  --exclude node_modules --exclude .nuxt --exclude .output \
  --exclude data --exclude .pnpm-store \
  "$SRC"/ "$RUN"/

cp "$SRC/data/fittown.db" "$RUN/data/fittown.db"   # first time only
cd "$RUN" && pnpm install && pnpm dev
```

**Re-run the rsync after every edit** — you edit in `$SRC`, the server runs in
`$RUN`. Forgetting this is the single easiest way to debug a bug you already
fixed.

Never commit a `.npmrc` with a sandbox `store-dir`; it isn't portable to the
user's Linux box.

### Guard `data/` while you do this

`$SRC/data/fittown.db` is the **deliverable** and is supposed to contain the
food library and nothing personal. The working copy's database fills up with
test users and junk entries, and it is very easy to clobber one with the other
— it happened during the first build, after the deliverable had already been
verified clean. Two rules:

- Keep `--exclude data` on **every** rsync, in both directions.
- Before handing over, regenerate and re-verify rather than trusting an earlier
  check:

  ```bash
  node scripts/reset-user-data.mjs "$RUN/data/fittown.db" --out /tmp/clean.db
  cp /tmp/clean.db "$SRC/data/fittown.db"
  rm -f "$SRC"/data/fittown.db-wal "$SRC"/data/fittown.db-shm
  ```

  Then confirm `users`, `diary_entries` and custom foods are all 0.

**Never copy a live SQLite file with `cp`.** It is in WAL mode, so the main
file alone can be many commits behind — copying `$RUN`'s database mid-session
produced a file showing 2 diary entries when the database really had 26. Either
`PRAGMA wal_checkpoint(TRUNCATE)` first, or use `VACUUM INTO` (which is what
`reset-user-data.mjs --out` does).

### Shell traps

- `pkill -f "nuxt dev"` **matches the Bash tool's own command line and kills
  your shell** (exit 144). Use a self-avoiding pattern: `pkill -f "nux[t].mjs dev"`,
  or `ps aux | grep '[n]uxt' | awk '{print $2}' | xargs -r kill -9`.
- Paths contain a space. Quote them, always.
- Start long-lived servers detached: `(setsid nohup pnpm dev > /tmp/run.log 2>&1 < /dev/null &)`.

---

## 2. Verify your work

There is no unit-test suite. The safety net is an end-to-end script that drives
the real app:

```bash
cd $RUN && node scripts/e2e.mjs          # 11 steps, fails on any console error
node scripts/screenshots.mjs /tmp/shots  # mobile, dark, desktop — then Read them
pnpm build                               # catches things dev mode hides
```

`scripts/e2e.mjs` needs `FITTOWN_DEV_LOGIN=1` in `.env` and a running dev
server. **Actually look at the screenshots** — several real bugs here (oats
measured in millilitres, a blank diary, "0.0 µg 0%" for unknown nutrients) were
invisible in HTTP status codes and obvious in a picture.

Route-level smoke tests are not enough: `POST /api/foods` returned 200 on every
page load I checked and was still completely broken (`no such column: f.id`),
because nothing exercised it until the e2e run.

---

## 3. Invariants — break these and data goes quietly wrong

**Nutrition is stored per 100 g/ml.** Everything else is a multiply. If you add
a nutrient column, add it to `shared/nutrients.ts` (key must match the DB
column) and to the importer's `NUTRIENTS` map with its unit scale and cap.

**Null ≠ zero.** Open Food Facts records maybe a third of micronutrients. A
missing value stays `null` all the way to the UI, which renders "not recorded".
Never `?? 0` a nutrient for display — it tells someone they got no vitamin D
when the truth is we don't know. `scaleNutrients()` omits absent keys
deliberately; keep it that way.

**Food IDs must stay stable across re-imports.** The importer upserts on
`(source, barcode)`. If you change that key, every existing diary entry
re-points at a different product. There is no nutrient snapshot on
`diary_entries` — stability *is* the integrity mechanism.

**"Today" belongs to the user, not the server.** The browser's IANA timezone
goes in a `fittown_tz` cookie; the server computes the date in that zone.
Never call `toLocalDate()` server-side to decide what day it is — a UTC host
serving a phone in Toronto is a different day for five hours every evening.
`useToday()` returns `null` until the zone is known; callers must treat that as
"don't fetch yet" so SSR and the first client render agree.

**The timezone cookie is written in `plugins/timezone.client.ts` under
`onNuxtReady`** — deliberately after hydration finishes. Moving it to setup or
`onMounted` reintroduces hydration mismatches (both were tried).

**`foodCols()` emits table-qualified columns** (`f.id, f.name, …`). Any query
using it needs `FROM foods f`. Both `foods` and `diary_entries` have `id` and
`created_at`, so unqualified lists are ambiguous or silently overwrite.

**`foods_fts` is an external-content FTS5 table.** The importer bulk-rebuilds
it; custom foods insert their own row in `server/api/foods/index.post.ts`. If
you add another path that creates a food, index it there too or it won't be
searchable. The e2e script asserts this.

**The dev login is double-gated** (`import.meta.dev` *and* `FITTOWN_DEV_LOGIN=1`)
and 404s in a production build even with the env var set. Verified — don't
loosen it.

**Every API route calls `requireUser(event)` and scopes queries by `user_id`.**
Deletes/updates use `WHERE id = ? AND user_id = ?` so a guessed ID is a no-op.
Keep that pattern.

---

## 4. Open Food Facts is crowd-sourced and dirty

`scripts/import-off.mjs` streams a 1.3 GB gzipped CSV and filters as it goes;
the ~10 GB uncompressed file is never written to disk. Don't "simplify" it into
downloading the file first — disk here is tight.

Real hazards already handled, with the reasoning in comments:

- **Unit-entry errors.** A blanket "≤100 g per 100 g" check passes a value that
  becomes 9,375,000 µg of vitamin D. Every nutrient has a per-nutrient
  physiological ceiling *in its output unit*. Pure salt legitimately is ~38,800
  mg sodium/100 g, so the caps are generous but finite.
- **kJ typed into the kcal field.** Stated calories are cross-checked against
  the Atwater estimate; macros win if they disagree by more than 2×.
- **Category umbrellas.** `"Plant-based foods and beverages"` sits on oats and
  olive oil and contains the word "beverages" — it mis-flagged 29,228 foods as
  liquids. `scripts/lib/liquid.mjs` strips `foods and beverages` umbrellas
  before matching, and only accepts a liquid word in final position in a name.
  62% of products have no categories at all.
- **Duplicates.** Many near-identical rows per product. Search de-duplicates by
  name+brand **in SQL, before the limit** — dedup after a small over-fetch
  collapsed "cheerios" to a single result.

If you change classification rules, `scripts/fix-liquid-flags.mjs` recomputes
in place (~10 s) instead of a two-minute re-import.

---

## 5. Layout

```
app/
  components/    CalorieSummary, MealSection, WaterTracker, FitnessSection,
                 NutrientBreakdown, FoodResultList, BarcodeScanner, DateNav,
                 AppIcon (inline SVG set — no icon dependency)
  composables/   useDiary (day data + all mutations), useToday (timezone)
  pages/         index (diary), add, food/[id], food/new, fitness, trends,
                 settings, login
  plugins/       timezone.client.ts
  middleware/    auth.global.ts — every route is private except /login
server/
  api/           REST endpoints; diary/index.get.ts assembles a whole day
  db/            schema.ts (single source of truth), seed-exercises.ts
  routes/auth/   google.get.ts, dev.post.ts, logout.post.ts
  utils/         db, auth, validate, foods (search ranking lives here)
shared/          nutrients.ts — catalogue used by both sides
scripts/         import-off, fix-liquid-flags, reset-user-data, e2e, screenshots
```

`server/db/schema.ts` is a TS template literal rather than a `.sql` file so
bundling is deterministic in production. Applied idempotently on every boot.

Stack: Nuxt 4, Tailwind v4 (`@tailwindcss/vite`, no config file), DaisyUI 5
(configured in `app/assets/css/main.css` via `@plugin`), `nuxt-auth-utils`,
`node:sqlite` (built into Node 24 — **no native module**, don't add
`better-sqlite3`).

---

## 6. What is and isn't proven

Verified working: the full logging journey (e2e script), search (22–104 ms over
203,695 foods), barcode lookup incl. UPC-A/EAN-13 zero-padding and 404s,
custom foods, goals, trends, dark mode, production build, and the production
security posture (dev login 404, API 401, `/` redirects).

**Not tested:**

- **Google OAuth.** `accounts.google.com` was firewall-blocked and there are no
  credentials, so only the error path ran (it redirects to `/login?error=oauth`
  rather than 500ing). To try it, the user runs on their host:
  `sbx policy allow network accounts.google.com,oauth2.googleapis.com,www.googleapis.com`
- **Camera barcode scanning.** Uses the native `BarcodeDetector` API (no
  scanning library). Unavailable in Safari, hence manual entry alongside. The
  lookup API behind it is tested; the camera path is not.
- **Real iOS/Android devices.** Only a 390×844 headless Chromium viewport.

---

## 7. Known gaps, if you're looking for work

- No service worker — the manifest makes it installable, not offline-capable.
- 34% of foods have no `serving_grams`; the portion picker falls back to 100 g.
- Water "undo" subtracts a preset amount rather than removing the last entry.
- Weight can only be logged from Settings.
- Trends is intentionally simple (bars + a weight list); no macro trends.
- No recipes, meal copying, or "log yesterday again".
- `data/` is gitignored — the 79 MB database does not travel via git. A fresh
  clone must run `node scripts/import-off.mjs` (~2 min).
- `scripts/reset-user-data.mjs` strips personal data while keeping the food
  library, for handing over a clean database.

# Dev environment & verifying your work

## The docker-terminal dev environment

This codebase is developed from a Hermes **Docker terminal backend**, the
source is at `/workspace` on native container storage.

- **Set Node v24** You must re-arm it in *every* new shell — the shell does not remember it
  across calls:
  ```bash
  source "$HOME/.nvm/nvm.sh" && nvm use 24
  ```
- **Run tests without pnpm.** `node_modules/.bin/vitest run` works directly;
  `pnpm` runs a version check on startup that aborts in the sandbox
  (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`).
- **The repo is not a git repo on the docker mount** — `git status` says "not a
  git repository". Leave git actions to the user.
- **The dev login is at `/auth/dev`, NOT `/api/auth/dev`.** The route lives
  under `server/routes/auth/` so it maps to the former; hitting the latter
  with a curl cookie jar 404s and every authenticated call then 401s. This is
  the standard trap when hand-rolling an HTTP smoke test.
- Start long-lived servers detached: `(setsid nohup pnpm dev > /tmp/run.log 2>&1 < /dev/null &)`.
- **Killing the dev server is not `nuxi`-shaped.** The running process's
  command line is `node …/nuxt/bin/nuxt.mjs dev`, so the self-avoiding
  `pkill -f "nux[t].mjs dev"` never matches it (that's correct — killing it
  would take the shell with it). Match `nu[x]t.mjs` instead or kill by PID. A
  fresh `nuxi dev` on the same port also refuses to start with "Another Nuxt
  dev server is already running (PID n)" — `NUXT_IGNORE_LOCK=1` bypasses, but
  better to kill the old one first.
- **Smoke-test against a throwaway DB.** Run the dev server pointed at a temp
  file so you never touch the real `data/fittown.db`:
  ```bash
  FITTOWN_DB_PATH=/tmp/fittown-test.db NUXT_PORT=3100 node_modules/.bin/nuxi dev
  ```
  Then exercise auth + the feature with curl and per-user cookie jars
  (`-c/ck-a` for three dev users). This is how the friends, reporting, copy and
  search changes were verified end-to-end.

## Guard `data/`

Don't point the throwaway server at `data/fittown.db`.

**Never copy a live SQLite file with `cp`.** It is in WAL mode, so the main file
alone can be many commits behind — copying `$RUN`'s database mid-session
produced a file showing 2 diary entries when the database really had 26. Either
`PRAGMA wal_checkpoint(TRUNCATE)` first, or use `VACUUM INTO` (which is what
`reset-user-data.mjs --out` does).

## Verify your work

Two layers, and they cover different things:

```bash
cd $RUN && pnpm test                     # >= 358 unit tests, ~0.8s, no server needed
cd $RUN && node scripts/e2e.mjs          # >= 38 steps, fails on any console error
node scripts/screenshots.mjs /tmp/shots  # mobile, dark, desktop — then Read them
pnpm build                               # catches things dev mode hides, run after large changes
```

**Unit tests** (`test/*.test.ts`, plain Vitest — see `vitest.config.ts`) cover
the pure logic: the nutrient catalogue and its null-vs-zero invariant, portion
units, body/energy maths, the activity library's internal consistency, the
request validators, the recipe roll-up (yields, the coverage rule, when gram
portions may be offered), the invite-expiry and copy-naming rules, the
ingredient parser, the recipe scraper (against a saved copy of a real Love and
Lemons page), the URL guard's private-address ranges, how an ingredient row
reads on screen when it has no food, and — against a real temp SQLite file —
the boot-time schema migration, the `recipe_ingredients` rebuild, the
exercise-library sync, `recomputeRecipe()`, ingredient matching, recipe
import, the friendship access gate and the deep recipe copy.
They run in half a second, so run them constantly. They deliberately do **not**
boot Nuxt; anything needing a running app belongs in the e2e script instead.

The unit suite was mutation-checked when written: a wrong Mifflin-St Jeor
constant, a `?? 0` slipped into `scaleNutrients`, and a forgotten
`ADDED_COLUMNS` entry each failed the tests you'd expect and nothing else. The
friends tests were checked the same way — disabling the per-section permission
check, making the recipe copy shallow, ordering the friendship pair index, and
dropping the timestamp normalisation each failed exactly their own tests. If you
add tests, break the thing on purpose once and confirm they notice.

`scripts/e2e.mjs` needs `FITTOWN_DEV_LOGIN=1` in `.env` and a running dev
server. **Actually look at the screenshots** — several real bugs here (oats
measured in millilitres, a blank diary, "0.0 µg 0%" for unknown nutrients) were
invisible in HTTP status codes and obvious in a picture.

Route-level smoke tests are not enough: `POST /api/foods` returned 200 on every
page load I checked and was still completely broken (`no such column: f.id`),
because nothing exercised it until the e2e run.

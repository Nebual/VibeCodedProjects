---
name: fittown-development
description: "Use when developing/verifying the Fittown Nuxt diary app."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, docker]
metadata:
  hermes:
    tags: [fittown, nuxt, nitro, node, sqlite, dev-backend, verification]
---

# Fittown Development

Fittown is a self-hosted Nuxt 4 / Nitro food + water + training diary (one family).
**Read `README.md` then `AGENTS.md` in the repo root first.** `AGENTS.md` is the
**lean brief**: the every-session commands and a one-line version of each
non-negotiable invariant (per-100g nutrition, null≠0, the single friendship gate,
the two-edit schema rule, `node:sqlite` requires Node 24+). The full reasoning and
war-stories for each invariant now live in **`docs/*.md`** (see `docs/README.md`
for the index); open the doc that governs the area you're touching before you
change it. This skill covers what AGENTS.md does _not_: how to actually get a
working dev loop going inside an isolated docker terminal sandbox (the `docker`
Hermes terminal backend).

## When to use

- A user asks you to build/change/test something in this repo.
- You need to run the test suite, a production build, or a live-server feature check.

## Environment bootstrap

**Docker sandbox (this skill):** `/workspace` is a normal container filesystem. The
dependencies (`node_modules/`, the pnpm `.pnpm` store) arrive on the mount as working
dirs. **`pnpm install`/`pnpm dev` are still the wrong tool** — but not because of the
filesystem. Prefer running the underlying binaries directly (below).

Node version matters: the app's `node:sqlite` built-in **only exists in Node 24+**.
On any Node < 24, the DB-backed tests fail en masse with
`No such built-in module: node:sqlite`, and `corepack pnpm` also aborts.

```bash
# If `node -v` < 24, install 24 via nvm (NOT a manual tarball — nvm handles version/dir):
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" || curl -so- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 24 && nvm use 24   # nvm is a shell function; call it inside a shell, not via `timeout`
```

The shell does not remember `$NVM_DIR` across calls — re-source `$NVM_DIR/nvm.sh`
and `nvm use 24` in every later shell that needs it.

## Run the suite / build WITHOUT pnpm

`pnpm` (via corepack) runs a version/network check on startup; in a constrained
sandbox it aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` or a registry
reach failure. You do NOT need pnpm at all:

```bash
nvm use 24
node_modules/.bin/vitest run                     # full suite (~470 tests, <6s)
node_modules/.bin/nuxi build                     # production build -> .output/
```

Both resolve the already-built `.pnpm` dependency store that shipped on the mount.
`node_modules/.bin/*` are real shims (nuxi, vitest, nuxt) — not stubs.

## Live-server HTTP smoke test

AGENTS.md's `scripts/e2e.mjs` needs Playwright + a real browser. For fast, offline,
endpoint-level verification use the curl method in `references/http-test.md`. The
essentials:

- Boot the dev server on a **throwaway DB**: `FITTOWN_DB_PATH=/tmp/x.db NUXT_PORT=3100 node_modules/.bin/nuxi dev` (background).
- Log in via **`POST /auth/dev`** (it lives under `server/routes/`, so the path is
  `/auth/dev`, **NOT** `/api/auth/dev` — the `/api/` form 404s). Sessions ride in a
  curl cookie jar.
- Establish friendships over HTTP via invite token (`POST /api/friends/invites` →
  `POST /api/friends/invites/<token>/accept`) rather than hand-inserting rows.
- For any friend-visibility feature, assert the **deny paths** as hard as the allow
  path: a stranger (third signed-in user) must get 404; a friend who turned the
  toggle off must get 403 on browse and the row must vanish from search.
- Parse JSON with `python3 -c "import sys,json;..."`, never string grep — server
  responses are pretty-printed, so `"\"id\":1"`-style greps silently false-negative.
- Kill the wrapper, then kill any lingering nuxi by pid (`ps aux | grep '[n]uxi'`) —
  Nuxt's dev-lock **reuses the old server on the same port** until it's really dead.

## Letter of the architecture (how Fittown features fit)

- **One friendship gate.** Any route that lets one user read another's rows calls
  `requireSharedSection()` / `friendSharesCustomFoods()` from `server/utils/friends.ts`
  first. A missed check leaks a health diary; a leak is a feature's biggest risk.
  Never write a bespoke join for a friend-scoped endpoint.
- **Schema changes are two edits.** Add a column to `SCHEMA_SQL` _and_ to
  `ADDED_COLUMNS` in `server/utils/db.ts` (fresh DBs use one, existing DBs the other).
  Sharing toggles: the UI catalogue and the save route both iterate
  `SHARE_KEYS`/`SHARE_TOGGLES` in `shared/sharing.ts`, so a new toggle is one catalogue
  entry + one migration column + one server gate.

## Pitfalls

- Running vitest under the wrong Node silently passes only pure-logic tests (the 300+
  DB ones fail) — misleading. Confirm `node -v` ≥ 24 first.
- After building, grep the build log for your new routes to confirm they were emitted
  into `.output/…/chunks/routes/`; a route not in the bundle never ships.
- The repo is **not a git repo on the docker sandbox mount** — `git status` says
  "not a git repository". Commit on the host, not in `/workspace`.
- Relative import depth in Nitro routes is literal — a new route's `../` count must
  match its actual directory depth. A build `RollupError: Could not resolve` means
  that count is wrong.

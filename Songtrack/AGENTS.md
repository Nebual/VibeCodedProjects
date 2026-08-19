# Agent notes for resuming this session

This file covers what isn't already in `README.md` or `plans/INITIAL_PLAN.md`, and isn't obvious
from reading the code: current status, places the build deviated from the plan, bugs already found
and fixed (so they don't get reintroduced), and environment gotchas specific to how this was built.

## Current status

Phases 0–3 from `plans/INITIAL_PLAN.md` are built and working: foundation, auth/admin, recorder,
ingest, library/albums/sharing/export, and the waveform editor with auto-trim. **Phases 4–6 (noise
reduction, PWA polish, Demucs) have not been started** — there is no `NoisePanel.vue`, no ambience
lead-in in the recorder, and `@vite-pwa/nuxt` mentioned in the plan's stack section is not installed.

Typecheck, production build, `pnpm test` (24 unit tests), and `pnpm test:e2e` (6 e2e tests) are all
green as of the end of this session. `INITIAL_PLAN.md` is the plan as originally written and hasn't
been edited to reflect build decisions made along the way — where this file disagrees with it
(notably impersonation and the auto-trim algorithm below), trust this file and the code.

## Renamed files — check current names before assuming

The user renamed things after they were created; the plan and old messages refer to the old names:
- `PLAN.md` → `plans/INITIAL_PLAN.md`
- `INITIAL_PROMPTS.md` → `InitialPrompts.md`

`InitialPrompts.md` is a verbatim log of the user's own messages, periodically condensed by the user
themselves — append new messages to it in their style (short, no headers) rather than reverting their
edits. It's also where the two files in `samples/` (real phone recordings) have their expected
auto-trim amounts documented — useful ground truth if you touch `autoTrim.ts` again.

## Where the plan and the build disagree

- **Impersonation is full read/write, not read-only.** The plan's phase list says "read-only
  impersonation" but the user explicitly asked for full edit rights during planning, and that's what's
  built (`server/utils/auth.ts`'s `requireActor`, audited via `recordAuditIfImpersonating`). The "Auth,
  roles & admin" section of the plan has the correct, updated description; only the phase-list line is
  stale.
- **Auto-trim is not the two-pass `silencedetect` design from the plan.** The actual algorithm
  (`server/utils/autoTrim.ts`) is a single-pass RMS envelope analysis, tuned against the two real
  recordings in `samples/` rather than synthetic audio, because the first two implementations both
  produced bad real-world results (see "Auto-trim: what actually shipped" below). If you revisit noise
  reduction (Phase 4) or improve auto-trim, re-validate against those two files — synthetic sine-wave
  tests alone did not catch the bugs that mattered.
- **Admin approval/revoke/reject** ended up as three distinct states (`pending`/`approved`/`rejected`)
  with separate endpoints, not just an approve toggle — see `server/api/admin/users/[userId]/`.

## Auto-trim: what actually shipped, and why

Three real bugs surfaced only when testing against actual phone recordings (`samples/*.m4a`), each with
a specific fix, all still present in `server/utils/autoTrim.ts`:

1. **A single global noise floor (whole-track percentile) is wrong.** Quiet musical passages elsewhere
   in the piece pollute it. Fixed by measuring the floor separately from the first/last ~15 seconds only
   (`FLOOR_REGION_S`), not the whole file.
2. **The floor estimate needs a low percentile (5%), not a typical-quiet percentile (20%).** The actual
   silent lead-in/tail is often a small fraction of that 15-second search window (loud music can fill
   most of it), so the percentile must be low enough to still land inside the quiet fraction.
3. **A brief post-recording blip (a handling click when the phone was picked up) gets mistaken for "still
   playing."** Fixed by requiring a *sustained* run above threshold (`MIN_SUSTAIN_WINDOWS`, currently 1s)
   before counting as loud — see `firstSustainedAbove`/`lastSustainedAbove`. A single loud 100ms window
   no longer moves the cut point.

Current known limitation: on a recording with a **gradual** fade rather than a clean cliff to silence
(the "Wondering..." sample), the algorithm still undershoots — proposes cutting less than a human would.
This is the safer failure direction (leaving extra silence beats clipping into music) and is why the UI
never auto-applies a proposal without preview.

## Bugs already found and fixed this session — don't reintroduce these

- **Vue reactivity trap in `useRecorder.ts`:** pushing a plain object into a reactive `ref([])` array and
  then continuing to mutate the *original* object reference does not trigger reactivity — Vue only wraps
  the array's own storage, not the variable you already held. `beginTake()` now re-reads the pushed take
  back out of `takes.value` before mutating it (RMS samples, duration, blob). If a computed reading
  recorder state ever seems "stuck," check for this pattern first.
- **`location.origin` in a `computed()` crashes SSR** (`location` doesn't exist server-side). Use
  `useRequestURL().origin` instead — see `songs/[id]/index.vue` and `albums/[id].vue`.
- **Nuxt route collision: `pages/x/[id].vue` + `pages/x/[id]/edit.vue` is not two independent routes.**
  Nuxt/vue-router treats `[id].vue` as an implicit parent for everything under `[id]/`, and since it has
  no `<NuxtPage/>`, the child route silently renders the parent's content instead of a 404 or an error.
  The fix, already applied, is `pages/x/[id]/index.vue` instead of a sibling `[id].vue` file — never
  recreate the sibling-file version of this pattern anywhere else in the app.
- **wavesurfer.js Regions plugin: every region sets `pointer-events: all` on its own element**, even
  non-draggable ones. `RegionsPlugin.enableDragSelection()` listens for `pointerdown` on the waveform
  wrapper, so a drag that starts on top of *any* existing region never reaches it — which is fatal here
  since the editor always starts with one region covering the whole waveform. Fixed with a custom
  capture-phase `pointerdown` listener on `ws.getWrapper()` in `songs/[id]/edit.vue`
  (`setupCustomDragSelection`) that intercepts before regions can claim the event, explicitly excepting
  clicks on `[part*="region-handle"]` so native resize still works.
- **Component auto-import naming:** a component at `app/components/foo/Bar.vue` registers as
  `<FooBar>`, not `<Bar>`. `WaveformCanvas.vue` was moved out of a `recorder/` subfolder for this reason
  — keep components that need a bare-name reference directly under `app/components/`.

## Testing infrastructure

- `pnpm test` — Vitest, pure functions only (`shared/utils/timeline.ts`, `server/utils/autoTrim.ts`).
  No Nuxt runtime needed; these files intentionally have no Nuxt-specific auto-imports.
- `pnpm test:e2e` — Playwright, full app. Config (`playwright.config.ts`) starts its own dev server on
  port 8194 with `DATA_DIR=.data-e2e` (isolated SQLite DB, gitignored) and `ALLOW_TEST_LOGIN=true`.
- **`server/api/_test-login.get.ts`** is a 404 unless `ALLOW_TEST_LOGIN=true` — this is how e2e specs
  authenticate without driving real Google OAuth. Never set that env var anywhere outside
  `playwright.config.ts`'s `webServer.env`.
- **`tests/e2e/global-setup.ts`** creates the test user and imports `tests/e2e/fixtures/test-tone.wav`
  as a starter song, since `globalSetup` isn't guaranteed to run after `webServer` is ready
  ([playwright#19571](https://github.com/microsoft/playwright/issues/19571)) — it polls the server itself
  before doing anything.
- **The recorder e2e spec needs `page.goto(url, { waitUntil: 'networkidle' })` before clicking Record.**
  Without it, the click can race Vue hydration and silently no-op (button never leaves idle state, no
  error, no crash) — this was the actual fix after a long detour through red herrings (see below). If a
  future recorder/editor e2e test is flaky in a similar "nothing happened, no error" way, check this
  first before assuming it's an environment problem.
- Fake microphone input for the recorder spec: `--use-fake-device-for-media-stream` +
  `--use-file-for-fake-audio-capture=<wav>`, configured project-wide in `playwright.config.ts` (not
  per-spec `test.use()` — both work, project-level is what's there now). The fixture WAV needs genuine
  amplitude *variation* (not a constant tone) or a real bug (flat waveform) and a healthy correct
  rendering look identical — a constant-volume fake mic produces a solid rectangle either way.

## Sandbox environment notes

These were specific to the sandbox this was built in, not the production machine

- **Chromium's `headless-shell` binary can hang indefinitely on `getUserMedia`/`permissions.query` in a
  container with zero audio hardware** (no `/dev/snd`, no PulseAudio). If e2e mic tests hang at exactly
  30s with no console output, this is why. A `channel: 'chromium'` override to force the full binary was
  tried and made things *worse* (do not re-add it) — the actual fixes were (a) not adding that override,
  and (b) the `networkidle` fix above. Installing a dummy PulseAudio null-source was tried and did not
  turn out to be the deciding factor, so it's not required.
- **The project directory lived on a virtiofs mount with a space in the path
  (`Claude Experiments/Songtrack`) that doesn't support symlinks**, which breaks `npm`/`pnpm` installs of
  packages with native builds or `.bin` symlinks, and node-gyp's Makefiles break on spaces in paths
  regardless of filesystem. The workaround used throughout this session: do all `pnpm install`/dev
  server/test work in a mirror at a space-free path, then `rsync` changes back to the real project
  directory (excluding `node_modules`, `.nuxt`, `.output`, `.data*`, `.env`, `samples/`). If you're
  running directly on the user's own machine instead of this sandbox, you almost certainly don't need
  this — check for spaces in your actual working directory path first.
- **pnpm's `allowBuilds` policy** (`pnpm-workspace.yaml`) must list any new native/build-script package
  explicitly (`better-sqlite3`, `esbuild`, `@playwright/test` are already there) or installs fail with
  `ERR_PNPM_IGNORED_BUILDS`.
- **Stray `nuxt dev` processes are a recurring hazard.** Nuxt's dev-server lock is per-project-directory,
  not per-port, so a leftover process from an earlier port blocks a new one on a different port too.
  `pkill -f "nuxt dev"` was unreliable in this environment (silently left processes alive more than
  once) — find the exact PID via `ps aux | grep nuxt` and `kill -9` it directly. Also: never invoke
  `nuxt dev -- --port N` (the `--` gets misparsed and can create a literal directory named `--port`
  containing a whole nested `.nuxt`/`node_modules` — this happened once and had to be deleted). Use the
  `PORT`/`NITRO_PORT` env vars instead.

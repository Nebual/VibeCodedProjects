# Agent notes for resuming this session

This file covers what isn't already in `README.md` or `plans/INITIAL_PLAN.md`, and isn't obvious
from reading the code: current status, places the build deviated from the plan, bugs already found
and fixed (so they don't get reintroduced), and environment gotchas specific to how this was built.

## Current status

Phases 0–5 from `plans/INITIAL_PLAN.md` are built and working: foundation, auth/admin, recorder
(including the ambience lead-in), ingest, library/albums/sharing/export, the waveform editor with
auto-trim, noise reduction (`EditorNoisePanel.vue`, learned-profile `afftdn` via `asendcmd`, FFT
auto-notch, `om=n` audition, agate, loudnorm), and Phase 5 polish (`@vite-pwa/nuxt` installability +
static-asset caching, keyboard shortcuts, bulk tag editing). **Phase 6 (Demucs source separation)
has not been started** — deliberately: it needs a separate sidecar container per the plan, out of
scope for an in-place session.

Typecheck, production build, `pnpm test` (46 unit tests), and `pnpm test:e2e` (13 e2e tests) are all
green as of the end of this session. `INITIAL_PLAN.md` is the plan as originally written and hasn't
been edited to reflect build decisions made along the way — where this file disagrees with it
(notably impersonation and the auto-trim algorithm below), trust this file and the code.

### Phase 5 notes

- **PWA**: `@vite-pwa/nuxt` needs two non-obvious pieces beyond the module install + `pwa` config
  block in `nuxt.config.ts`, or it silently doesn't work: (1) `<NuxtPwaManifest />` (or
  `<VitePwaManifest />`) must be placed somewhere in `app.vue` — the module registers it as a
  component but never renders it for you, so without this there's no `<link rel="manifest">` in the
  page at all despite the manifest file existing on disk; (2) for a fully SSR app with no
  prerendered routes, the module's own default (`workbox.navigateFallback: '/'`) is broken — "/"
  is never precached for an SSR app, so it must be explicitly set to `null` (not `false` — workbox
  validates that field as `null | string`), otherwise the production build throws
  `WorkboxConfigError`. Static JS/CSS under `/_nuxt/` is cached via a `CacheFirst` `runtimeCaching`
  rule instead of precaching, since `generateSW`'s glob-based precaching is gated on
  `nitro.static`/prerendered routes and never runs for a plain SSR app — verify any future PWA
  change against a real `pnpm build` + a real browser (curl only shows pre-hydration HTML and won't
  show either the manifest link or the SW registration).
- **Keyboard shortcuts**: two independent listeners, not one — `usePlayerShortcuts()` (space/arrows
  for the persistent bottom PlayerBar, wired in `layouts/default.vue`) and a page-local handler in
  the editor (`Ctrl/Cmd+Z`/`+Shift+Z` for undo/redo, space for the editor's own wavesurfer playback).
  They don't conflict in practice because the global one no-ops whenever `usePlayer()`'s
  `currentSong` is unset, which it always is on the editor page. Both check
  `isEditableTarget()` (`app/utils/keyboard.ts`) first so typing in any form field is never
  intercepted.
- **Bulk tag editing**: additive/subtractive only (`POST /api/songs/bulk-tags` with
  `mode: 'add' | 'remove'`), never a wholesale replace — replacing would silently wipe each
  selected song's *other* tags, which is exactly wrong for a multi-song operation. Silently skips
  any song id in the request the caller doesn't own rather than 404ing the whole batch.
- e2e specs added in this phase (`bulk-tags.spec.ts`, `player-shortcuts.spec.ts`,
  `editor-keyboard-shortcuts.spec.ts`) all resolve "the fixture song" via `?q=test-tone` rather than
  blindly taking `songs[0]` — `/api/songs` sorts newest-first, and `recorder.spec.ts` creates a new
  song mid-suite that would otherwise silently outrank the fixture and make a concurrently-running
  spec interact with the wrong song. Follow this pattern in any new spec that needs "the" fixture
  song. Also don't forget the `networkidle` hydration-race gotcha (below) applies to `page.goto` on
  *any* page with a client-side click immediately after, not just the recorder.

### Phase 4 notes

- `songs.noise_region` is captured automatically: `record.vue`/`useRecorder.ts` run a 5s "hold
  still — sampling the room" countdown as an *overlay on top of* the still-live rolling waveform
  (not a replacement — the mic-is-hearing-me reassurance matters during the ambience sample too,
  and the recorder e2e spec depends on the waveform `<canvas>` staying mounted throughout). The
  countdown is toggleable per-recording and only ever applies to the very first take of a session,
  never a punch-in.
- The noise-profile region is drawn on the editor's waveform as a distinct, draggable/resizable
  amber region (id `noise-profile`), coexisting with the crop-selection regions. Its coordinate
  space is the post-segment-join, pre-filter timeline (same axis as `editList.segments`) — filters
  never shift time, so this stays valid across denoise-only edits even though `master.ogg` is
  re-rendered with filters baked in.
- `server/utils/ffmpeg.ts`'s `buildFilterGraph`/`buildFiltersOnlyGraph` are pure and unit-tested
  (`tests/unit/ffmpeg.test.ts`) — `renderEditList` just calls `buildFilterGraph` then spawns ffmpeg.
  The `afftdn` learned-profile chain is `asendcmd=c='{start}-{end} [enter] afftdn@fN sn
  start,[leave] afftdn@fN sn stop',afftdn@fN=...` — verified directly against the real `ffmpeg`
  binary before shipping, not just against docs, since `asendcmd`'s escaping rules are easy to get
  subtly wrong.
- `server/utils/autoNotch.ts` is a self-contained radix-2 FFT + Welch-averaged peak detector, no
  new npm dependency.

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

## Node 24.19.0 crashes better-sqlite3 under load — this affects production, not just the sandbox

`node:24-slim` (a floating tag) will eventually pull Node 24.19.0, which shipped a regression in
`ObjectWrap` cleanup-hook handling that crashes NAN-style native addons — `better-sqlite3`'s
`Statement` finalizer among them — with `Assertion failed: (env) != nullptr` in
`RemoveEnvironmentCleanupHook` (`api/hooks.cc:142`), aborting the whole Node process.

This is not environment-specific, and **pinning the Node version reduces but does not eliminate
it**: under 24.19.0 the app's e2e suite (7 parallel workers hammering one long-lived dev-server
process with DB-backed requests) crashed on essentially every run; pinned to 24.18.0 it crashed on
roughly half of several back-to-back runs of the same suite, with no code changes in between —
purely a GC-timing race in how often a `Statement` object gets finalized relative to environment
teardown. **The `Dockerfile` now pins `node:24.18-slim`** on both build and runtime stages as the
right proportionate mitigation (do not float it back to `node:24-slim` until a later Node 24.x patch
is confirmed fixed), but treat that as risk-reduction, not a guarantee. The e2e suite's request
density is a far more concentrated stress pattern than this app's real "family-scale" traffic will
ever produce, so the residual risk in production is low but not zero.

If e2e or dev-server runs in this sandbox ever abort mid-suite with that exact assertion, it is
almost certainly this known issue, not a real bug in the code under test — just re-run (under a
pinned 24.18.x if not already: `nvm install 24.18.0`, prepend its `bin/` to `PATH`) rather than
chasing it as a regression. A durable fix would mean either waiting for an upstream Node/
better-sqlite3 patch, or changing the DB layer to cache/reuse prepared statements instead of
creating a fresh one per query (`db.select()...get()` today, throughout `server/`) — worth
considering later, but a large enough refactor that it was deliberately left out of this session's
scope.

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

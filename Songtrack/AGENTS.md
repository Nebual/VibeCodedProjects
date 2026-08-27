# Agent notes for resuming this session

This file covers what isn't already in `README.md` or `plans/INITIAL_PLAN.md`, and isn't obvious
from reading the code: current status, places the build deviated from the plan, bugs already found
and fixed (so they don't get reintroduced), and environment gotchas specific to how this was built.

# Environment notes:

- **Node v24 every new shell** — the shell doesn't remember it:
  `source "$HOME/.nvm/nvm.sh" && nvm install`. So `node -v` shows v24, required for the sqlite binary.
- Long-lived servers detached: `(setsid nohup pnpm dev > /tmp/run.log 2>&1 < /dev/null &)`.
  Killing the dev server: match `nu[x]t.mjs` or by PID (`nux[t]` won't match the
  real cmdline); `NUXT_IGNORE_LOCK=1` bypasses the "already running" lock.

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

## Audio → MIDI (plans/AUDIO_TO_MIDI_PLAN_V2.md)

Stages 1–6 of the V2 plan are built and **verified against a live muscriptor 0.3.0 sidecar**
(model `medium`), not just against the stub.

### The sidecar image is pinned AND patched — and why

`bin/build-midi-sidecar.sh` clones upstream at a pinned commit, applies everything in `patches/`,
and builds that. It **refuses to build with no patches present**, because an unpatched image loses
`.mscz` and the tempo hint in ways that look like app bugs rather than build ones.

`patches/0001-mscz-export-and-tempo-hint.patch` does two things, both small and additive, and both
worth offering upstream — if they land there, drop the patch and build from the git URL again:

1. **`.mscz`** — `write_sheets` builds `score.mscx` in a temp dir, converts it to MusicXML and PDF,
   and throws it away. The patch also converts it to `score.mscz` and keeps it. Verified: the
   archive gains a real MuseScore container (`score.mscx`, styles, thumbnail inside).
2. **`tempo_hint`** — `detect_beat_grid` fits a tempo, and if the beats deviate too far from a
   constant one it raises `BeatDetectionError`, leaving the fitted BPM reachable **only inside the
   exception's message text**. Under `best-effort` the server swallows it and sends
   `beat_grid: null`, so any recording with rubato in it used to land on a 120 placeholder. The
   patch carries `bpm`/`residual` on the exception and reports them as `tempo_hint` on the final
   frame. Verified live: a deliberately-rubato recording yields
   `tempo_hint {bpm: 108.9, residual_ms: 334}` where it previously yielded nothing, and a steady
   recording still detects a grid with `tempo_hint: null` (no regression).

`server.py` has no module logger of its own — the patch adds `import logging` rather than
referencing a `logger` name that doesn't exist. A compile check won't catch that; it only shows up
when tempo detection actually fails, which is the one path the patch exists for.

### The tempo a grid comes from is tracked, not assumed

`BeatGrid.source` is `detected` | `estimated` | `user`. The transcribe route picks the best
available, in descending order of trust: the sidecar's detected grid, then its rejected-but-fitted
`tempo_hint`, then `server/utils/tempo.ts` — our own autocorrelation over the saved onsets, which
is what an unpatched sidecar falls back to. A bare 120 is now only ever the last resort, and the
page says plainly when the number is a guess.

`estimateTempo` uses autocorrelation rather than "pick the grid with the smallest onset error",
because a finer grid always fits better and error alone has no minimum worth finding. Two traps
already paid for: normalising the correlation by overlap length (`sum / (bins - lag)`) over-rewards
long lags and returned 80 BPM for a textbook 120, and a peak-to-mean confidence saturates at 1 for
periodic and random input alike — it scores grid agreement instead.

### The image is pinned to a commit, not a release — and why

`/sheets` (Stage 6.4's engraving) landed on main **after v0.3.0**, and no tag carries it: on
v0.3.0 the routes are only `/health`, `/instruments`, `/soundfonts/MuseScore_General.sf3`,
`/transcribe`, `/transcribe/midi` and `/auralize`. So `bin/build-midi-sidecar.sh` and
`docker-compose.yml` pin **`e34b397` ("Quantize before exporting sheet music", 2026-08-20)**, not a
branch — a moving `main` would silently change the SSE payload shape this app treats as a contract.

The v0.3.0→e34b397 diff to `server.py` was read before pinning and is purely additive: `/sheets`
itself, plus a `quantized_midi` field on `transcription_complete` that we don't rely on. **Every
event shape verified below against v0.3.0 still holds.** Do the same reading before moving the pin.

- **A missing `/sheets` answers 405, not 404**, because unknown paths fall through to the bundled
  SPA, which serves GET only. `postSheets` treats both as "this build can't engrave" and raises a
  501 pointing at the Score MIDI, so an old image degrades readably instead of looking like a
  network fault.
- **`x-client-id` is a header** (`Annotated[str | None, Header()]` on both v0.3.0 and main), as the
  plan says. A query parameter of that name is silently ignored — and note that FastAPI's
  `/openapi.json` lists header params under `parameters` too, so read each entry's `in` field
  rather than assuming they're query params.
- **`beat_grid.beats_per_bar` is `null` even when a tempo is detected** — observed
  `{bpm: 120.000…, beats_per_bar: null, first_downbeat: 0.0, onset_delay: 0.0}`. `beatGridFromWire`
  defaults it to 4. Left as null it reaches the score writer as a `[null, 4]` time signature and
  the piano roll as a NaN bar width.
- **`quantized_midi` may be absent, null, or a string.** v0.3.0 omits the key entirely; the pinned
  main commit sends it, but null whenever the detected grid has no `beat_subdivision`. The type is
  optional-and-nullable for that reason. Nothing depends on it — we re-quantize from `events.json`,
  which is also what lets the user re-bar at a corrected tempo without re-running the model.
- **`progress` counts audio chunks, not notes.** A 4-second file yields exactly
  `{completed:0,total:1}` then `{completed:1,total:1}`; longer files yield many.
- **`HF_HOME=/hf-cache` hides the soundfonts.** The image prewarms them into its *own* default HF
  cache, so pointing HF_HOME at a volume holding only the weights makes `/auralize` and
  `/soundfonts/…` fail — the former with a JSON "cannot find the requested files in the local
  cache", the latter with a bare `Internal Server Error` and no diagnostic body at all.
  `bin/fetch-midi-model.sh` now also fetches `MuScriptor/assets` (public, ungated, MIT) into the
  same cache, which fixes both. `assertSoundfontsPresent` in `midiWorker.ts` turns either failure
  into a 503 that names the cause.

### What the live run actually produced

Verified end to end against the pinned build, model `medium`, on a synthetic 4-second C-major
scale (MIDI 60,62,64,65,67,69,71,72 as quarter notes at 120 bpm):

- **Transcription**: 7 notes, pitches 62–72 at 0.46/0.95/1.46/1.95/2.46/2.97/3.46 s — every pitch
  correct, only the first note of the scale missed, on pure sine tones the model never saw in
  training. Quantizing snapped those onsets to exactly 0.50/1.00/1.50/2.00/2.50/3.00/3.50.
- **Engraving**: `sheets.zip` (ZIP_STORED) with `score.mid`, `score.musicxml`, `full_score.pdf` and
  `01_acoustic_piano.pdf`. The MusicXML reads `4/4 | quarter rest, D4 E4 F4 | G4 A4 B4 C5`, all
  quarter notes — no tied 128ths, no spurious triplets. That is Stage 6 doing its job.
- **The wrong-tempo failure mode, on demand**: re-engraving the same events at 60 bpm turns every
  quarter note into an eighth and collapses the piece into a single bar, exactly as the plan
  predicts for a half-time estimate. The tempo editor's ×2 button is what fixes it.
- **Caching**: a repeat transcription returns 2 frames; a repeat engrave is served from
  `sheets-<gridHash>.zip` in ~20 ms, and two different grids produce two different zips.
- **Preview + synth**: `/auralize` gives a stereo check mix and a mono synth-only render (cached in
  `previewPath`); the 39.9 MB soundfont proxies with a working 304 revalidation and the in-browser
  `spessasynth_lib` synth boots against it.

Two things that only real data exposed, both fixed:

- **The detector reports 120.00000000000003 for a clean 120 bpm.** `beatGridFromWire` rounds to 3
  decimals — otherwise the BPM field reads "120.000000…", the score MIDI carries a 120.00024 tempo
  event, and two identical-looking grids hash differently.
- **Onset error cannot be scored against the subdivision step.** Real onsets sit tens of ms off
  however right the tempo is (41 ms here, while engraving flawlessly), so a step-relative score
  damns a good grid as soon as you pick a finer subdivision. It's scored against the *beat* now,
  and labelled descriptively — it genuinely cannot distinguish a half-time grid from a correct one,
  because halving the bpm yields a subset of the same grid points. The barline overlay and the
  notation are what catch that.

- **`@tonejs/midi` is CommonJS under *both* its `main` and its (mislabelled) `module` entry**, so
  Nitro's dev ESM loader rejects `import { Midi }` from it. It's listed in
  `nitro.externals.inline` in `nuxt.config.ts` so rollup bundles it and resolves the interop. Don't
  remove that line; the failure is a 500 on *every* API route, not just the MIDI ones, because the
  import graph is shared.
- **`events.json` is derived from the final MIDI, not from the streamed `start`/`end` frames.** The
  streamed times run ~25 ms late and the MIDI already has that removed, so parsing the file keeps
  the lag correction in exactly one place (upstream's). `notesFromEvents` in `transcriptions.ts` is
  the fallback for an unparseable file, and subtracts `onset_delay` itself.
- **The page reads its finished note list from `GET /transcription/events`, not by decoding MIDI in
  the browser.** The plan suggested `spessasynth_core` for that; serving the saved events is
  simpler, identical on a fresh run and a cache hit, and removes a client-side MIDI parser.
  `spessasynth_lib` is still used for playback, which takes the raw bytes.
### First downbeat is a whole-beat control, and why that matters

Moving the downbeat by a *fraction of a beat* does not shift the barlines along with the music — it
slides them *between* the notes, so every note becomes syncopated and the engraving fills with ties
and rests. Measured against a real MuseScore: a clean C major scale engraved perfectly at
firstDownbeat 0 / 0.5 / 1.0 / 1.5 s (whole beats) and came back with **notes reordered and up to
nine stray rests** at 0.125 / 0.25 / 0.31 s. That is what "changing the downbeat changed the pitches"
was — MuseScore splitting syncopated notes across voices, so document order stopped matching time
order. No notes were actually lost.

Two changes, both needed:

1. `snapDownbeat()` moves the downbeat to the nearest **beat**, preserving the grid's phase, and the
   roll's click-to-set-downbeat uses it. A whole-beat move leaves every note exactly where it was
   relative to the beat, which is the real use (a downbeat detected on beat 3 instead of beat 1).
2. `scoreLayout()` replaced the old fractional-pickup encoding. The old code wrote the anacrusis as
   `N/16` (so a 3-beat pickup became `12/16`); MuseScore **discards** a pickup meter whose beat unit
   differs from the main one while keeping the tick positions computed against it. Pickups are now
   always whole beats in the main meter's unit (`3/4`, not `12/16`), and the sub-beat remainder is
   absorbed by shifting the notes — a score has no absolute time, only positions relative to bars.

Verified after the fix: all eight notes survive at every downbeat value tested, and the only
remaining artefact is ties, which are the correct rendering of a genuinely off-beat grid.

- **The player is driven by notes, not by a MIDI file.** It used to take the base64 MIDI from the
  `transcription_complete` frame, which meant it worked on the run that streamed and was **silent
  on every revisit** — the bytes never arrived again. Notes come from `/transcription/events`,
  which is identical on a fresh run and a cache hit, and they also make the play-while-transcribing
  preview and per-instrument muting possible at all.
- **`useMidiSynth` schedules notes on the audio-context clock** (`noteOn(..., { time })`), not with
  `setTimeout`, and reads its position from the recording's `<audio>` element on every tick — so
  the transcription tracks the recording instead of drifting away from it. Muting a part is a
  channel-volume change (CC 7), not "skip the note": events already queued on the audio clock
  cannot be un-queued, so skipping would leave up to a lookahead of sound behind.
- **`assignChannels`/`gmProgramFor` exist because every part was otherwise written as piano** — a
  bass line and a sax both came back as programme 0, which made the audio check worthless.
- **A canvas inside a flex column needs `min-h-0`.** A flex item defaults to `min-height: auto`, and
  a canvas has an intrinsic size from its width/height attributes (which `draw()` sets in device
  pixels), so it refuses to shrink, overflows its container, and squashes anything below it to zero
  height. This cost a debugging round when the roll's scrollbar was present but invisible.
- **Every input `draw()` reads must be in the piano roll's watch list.** `window`, `muted` and
  `scroll` were missing once, so the zoom buttons looked completely inert whenever nothing was
  playing — the playhead was the only thing still triggering a redraw. The e2e spec now compares
  canvas pixels across zoom levels rather than trusting that a class changed.
- **The BPM field is free text, clamped only on blur, with no `min` attribute.** Clamping per
  keystroke made it unusable: typing "81" clamped the intermediate "8" up to the minimum and left
  you editing "201".
- **`InstrumentPicker.vue` replaced 35 chips**, modelled on `TagPicker.vue` but with one deliberate
  difference: tags are free text, instruments are not — the sidecar validates names against the MT3
  taxonomy and answers 422 for anything else, so the picker only ever emits values from `options`.
  It closes its menu after each pick (typing reopens it): left open, the absolutely-positioned menu
  sits on top of the Start button and swallows the click.
- **The "tempo is an estimate" banner keys off `grid.source`, not a snapshot taken at load.** Every
  edit in the tempo editor stamps `source: 'user'`, which hides it. Keyed off a boolean captured
  once, the banner kept quoting whatever number the user had just typed and calling it a guess.
- **daisyUI's `.alert` is a grid**, so loose text nodes and an inline `<strong>` become separate
  grid items and the sentence breaks apart. Alert bodies are wrapped in a single `<span>`.
- **`POST /transcribe` takes `force`**, and the page always sends it. Without it, "Transcribe again"
  with an unchanged instrument selection is an instant cache hit that looks like a dead button —
  and it also made the live-preview e2e assertions race a 50 ms no-op.
- **The progress bar lives outside the setup block on purpose.** Inside it, it unmounted the instant
  the run completed, so it was never seen to reach 100% (an e2e assertion caught this).
- **A re-render of `master.ogg` invalidates the transcription cache**, because the spec hash
  includes the master's mtime. That's intended — but it means any editor spec that re-renders the
  fixture song mid-suite makes a following "should be cached" assertion do a live run. The midi
  spec asserts on *frame count* (2 for a cache hit vs 26 for the stub's replay) rather than
  wall-clock time for exactly this reason.
- **Sheet music is not a column.** It depends on a grid the user can change, so it's
  content-addressed on disk as `midi/<specHash>/sheets-<gridHash>.zip` and its existence is the
  cache check. `gridHash` rounds before hashing so a dragged BPM slider can't spawn thousands of
  near-identical zips.
- Score MIDI carries **both** a tempo and a time-signature meta event — without the latter
  MuseScore assumes 4/4 whatever the notes imply — and expresses a mid-bar start as a short opening
  bar (in 16ths, so the denominator stays a power of two) followed by a signature change at the
  first downbeat, rather than padding the front with silence.
- `writeScoreMidi` floors note duration at **one tick**, not at some small number of seconds: a
  1e-4 s floor is below one tick at 480 ppq and still rounds to a zero-length note.

### e2e state as of this session

`tests/e2e/midi.spec.ts` (4 tests) passes both in isolation and in a full-suite run. Two
pre-existing problems with the suite surfaced while verifying it, neither introduced here:

1. **The suite cannot bootstrap a fresh database.** `_test-login` 404s unless the user already
   exists and nothing else inserts one (only real Google OAuth does), so `.data-e2e` has to be
   hand-bootstrapped. Deleting it makes `globalSetup` fail outright.
2. **The suite is order- and state-dependent across runs.** The editor specs crop and re-render the
   `test-tone` fixture, and because `.data-e2e` persists, a second run finds a 3-second fixture
   where the first found a 10-second one — which fails `player-shortcuts` ("arrows skip 10s") and
   several editor specs. Resetting is: delete every row in `songs` (plus `song_tags`, `takes`,
   `renders`, `transcriptions`, `album_songs`) keeping `users`, then re-run `scripts/import.ts`
   against `tests/e2e/fixtures`.

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

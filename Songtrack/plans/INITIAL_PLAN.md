# Songtrack — Piano Song Recording, Management & Editing

## Context

You want a personal (and friends/family) library for piano recordings: capture audio from a phone or
laptop, organize it with rich metadata and tags, group it into albums, share it publicly by link, and
non-destructively clean it up — trimming dead air, cutting out middle sections, and reducing background
noise like a running fan or nearby conversation.

Nothing exists yet: the project directory contains only a `.env` with Google OAuth credentials. This
plan covers the whole build from an empty directory.

**Decisions locked in:** self-hosted Linux Docker container behind an existing nginx doing TLS at
`https://songtrack.nebtown.info`; SQLite + local disk; multi-user Google sign-in with each user's library
private to them; `ben1120@gmail.com` as admin with an approval queue; recording on Android Chrome and
desktop browsers (iOS not a target); primarily a phone's built-in mic, so noise reduction is
high-value rather than optional; an existing folder of recordings to bulk-import.

---

## Should this be a web app? — Research findings

**Yes, build the web app.** All the heavy audio work runs server-side in real FFmpeg, so the browser's
audio weaknesses barely touch the editing features. But there are five genuine limitations you should
know about up front, all in the *recording* path:

| # | Limitation | Impact | Mitigation |
|---|---|---|---|
| 1 | **Backgrounded / screen-off recording on Android is unreliable.** Chrome throttles background timers, so `MediaRecorder`'s `dataavailable` events stall, and OEM battery managers (Samsung especially) can kill the tab outright. | High — a lost 6-minute take is painful | Installed PWA + [Screen Wake Lock API](https://developer.chrome.com/docs/capabilities/web-apis/wake-lock) + write every chunk to OPFS immediately so a killed tab is recoverable, not lost. Practically: keep the screen on and the app in front. |
| 2 | **No guarantee of unprocessed audio.** Chrome has [known bugs](https://issues.chromium.org/issues/327472528) honouring `echoCancellation:false` / `noiseSuppression:false`; Android may still route through a voice-processed capture path, which mangles piano. Native Android can request `AudioSource.UNPROCESSED`; the web cannot. | Medium — affects raw quality | Request all three as `{exact:false}` with graceful fallback, verify on-device in Phase 0, and treat desktop as the quality path. |
| 3 | **No true background upload.** Native uses WorkManager; the web can only upload while a tab or service worker lives. Background Sync is Chromium-only and best-effort. | Low | Local-first: audio is safe in OPFS, upload retries on next app open. |
| 4 | **Local storage is evictable.** OPFS/IndexedDB share one quota and can be cleared under pressure unless `navigator.storage.persist()` is granted. | Low | Server is source of truth; request persistence on first run. |
| 5 | **Codec control is coarse.** You get Opus-in-WebM from `MediaRecorder`, not arbitrary formats. | Low | Opus at 192 kbps stereo is perceptually transparent for solo piano; offer lossless WAV capture on desktop. |

Everything else — waveforms, tagging, albums, share links, playback, non-destructive editing — is equal
or better on the web, from one codebase covering phone *and* desktop, with instant deploys and no app
store. **Escape hatch:** if background recording later proves painful, wrap the same web UI in a
Capacitor shell that adds a native foreground-service recorder. Nothing in this plan blocks that.

**Two findings that change the design:**

- **`MediaRecorder`'s WebM output has no duration/cue metadata**, so `<audio>` seeking is broken on it.
  Every upload must be remuxed server-side into a proper `.ogg`/Opus before it becomes the playback and
  editing source.
- **Do not use RNNoise / FFmpeg's `arnndn` on piano.** RNNoise is trained to *preserve speech and remove
  everything else* — exactly backwards here. It would eat the music. Spectral denoising (`afftdn`) is the
  correct tool.

---

## Stack

- **Nuxt 4** (Vue 3), Nitro `node-server` preset, **Node 24**
- **Tailwind CSS v4** via `@tailwindcss/vite` + **DaisyUI 5** registered with `@plugin "daisyui"` in `app/assets/css/main.css` (v4/v5 is CSS-first — no `tailwind.config.js`)
- **nuxt-auth-utils** — Google OAuth via `defineOAuthGoogleEventHandler`, sealed cookie sessions
- **Drizzle ORM + better-sqlite3**
- **wavesurfer.js v7** + Regions plugin — waveform UI, fed **pre-computed peaks** (v7 decodes in-browser otherwise and chokes on long files)
- **FFmpeg** (system binary in the container) — all trimming, denoising, rendering, export
- **@vite-pwa/nuxt** — installability, offline shell

## Deployment shape

- `Dockerfile`: `node:24-slim` → `apt-get install -y ffmpeg` → build Nuxt → run `.output/server/index.mjs`
- Single volume at `/data`: `/data/songtrack.db`, `/data/audio/<userId>/<songId>/`, `/data/renders/`
- Binds `127.0.0.1:3000`; nginx proxies `songtrack.nebtown.info` → that port
- **nginx needs:** `client_max_body_size 512m;` (or larger), `proxy_set_header X-Forwarded-Proto https;`, and a generous `proxy_read_timeout` for render jobs
- **You will need to do two things manually:** add `https://songtrack.nebtown.info/api/auth/google` as an authorized redirect URI in Google Cloud Console, and add a 32+ character `NUXT_SESSION_PASSWORD` to `.env` (it's currently missing, and `nuxt-auth-utils` requires it)
- Note: `.env` holds a live Google client secret in plaintext — add a `.gitignore` covering it before this becomes a git repo

---

## Data model (`server/database/schema.ts`)

```
users(id, google_sub UNIQUE, email, name, avatar_url, created_at,
      role /*'admin'|'user'*/, status /*'pending'|'approved'|'rejected'*/,
      approved_at, approved_by)

app_settings(key, value)          -- single-row-ish KV; holds `signups_enabled`
audit_log(id, actor_user_id, action, target_user_id, detail, created_at)

songs(id, user_id, title, slug, description, music_key, time_signature, rating /*0-10*/,
      external_url, master_path, peaks_path,
      duration_s, sample_rate, channels, noise_region JSON NULL,
      edit_list JSON, share_token UNIQUE NULL, created_at, updated_at)

takes(id, song_id, source_path, timeline_start, duration_s, ordinal, created_at)
                                      -- every recorded blob, kept forever; ordinal = punch-in priority

renders(id, song_id, spec_hash, format, path, created_at)   -- cache; spec_hash = hash(takes + edit_list + format)

tags(id, user_id, name, last_used_at)                        -- last_used_at drives recency ordering
song_tags(song_id, tag_id, created_at)

albums(id, user_id, title, slug, description, share_token UNIQUE NULL, created_at)
album_songs(album_id, song_id, position)
```

Rows in `takes` are written **once and never modified** — they are the anchor that makes everything
non-destructive. Every edit lives in `edit_list`; every playable file is a cacheable derivative.

### The edit list

```jsonc
{
  // keep these, in order; `source` names a take, so punch-ins and cuts share one mechanism
  "segments": [
    { "source": "take-1", "start": 0,     "end": 90.0 },
    { "source": "take-2", "start": 83.0,  "end": 120.0 },   // a punch-in overdub
    { "source": "take-1", "start": 310.5, "end": 372.0 }
  ],
  "filters": [
    { "type": "afftdn",   "nr": 12, "gs": 6, "noiseRegion": { "start": 0.2, "end": 4.8 } },
    { "type": "notch",    "freqs": [50, 100, 150], "q": 30 },
    { "type": "highpass", "freq": 35 },
    { "type": "agate",    "threshold": -50, "ratio": 2 }
  ],
  "gain":  { "mode": "loudnorm", "targetLufs": -16 },
  "fades": { "inMs": 30, "outMs": 1200 }
}
```

Trim-start, trim-end, crop-the-middle **and punch-in overdubs** are all just `segments` — one
mechanism, four features. Segments are joined with a ~20 ms crossfade so cuts and punches don't click.

---

## Auth, roles & admin

Google sign-in via `nuxt-auth-utils`. On first login a user row is created with
`status='pending'` — **except** `ben1120@gmail.com`, which is seeded/promoted to
`role='admin', status='approved'` on sight. Libraries are strictly private: every song, tag, album and
render query is scoped by `user_id`, enforced in a shared `requireUser(event)` helper rather than
per-handler, so there's one place to get it right.

**Pending users are not blocked — they're capped.** A pending account works normally but may hold at
most **10 songs**; the 11th ingest returns a clear "awaiting approval" error. The remaining-allowance
banner stays hidden until they hit **8 songs**, so a new user isn't greeted by a limit they're nowhere
near — it only appears when it's about to matter. The cap is enforced
server-side in the ingest handler (a `COUNT` scoped to the user), not in the UI, so the banner is
purely informational. It lets a new friend try the app immediately without leaving your box
open to unbounded uploads.

**Admin UI at `/admin`:**
- **Users** — table of accounts with status, song count, and total bytes on disk; approve / reject / revoke
- **Signups toggle** — `app_settings.signups_enabled`; when off, an unrecognized Google account is
  rejected at the OAuth callback before any row is created
- **Impersonation** — "View as user" writes `impersonatingUserId` into the admin's sealed session
  alongside their real id. `requireUser()` resolves to the impersonated user, so the whole app renders
  through their eyes with no per-page work. **Full edit rights** — you can fix a broken tag or re-run a
  denoise on their behalf, not just look. A persistent banner with an "Exit" button sits at the top of
  every page so the mode is never ambiguous, and every mutation made while impersonating is written to
  `audit_log` with both your id and theirs, so "who actually changed this" always has an answer.

### 1. Recording (`app/pages/record.vue`, `app/composables/useRecorder.ts`)

**Capture setup:**

```js
getUserMedia({ audio: {
  echoCancellation: { exact: false },   // retry without `exact` if OverconstrainedError
  noiseSuppression: { exact: false },
  autoGainControl:  { exact: false },
  channelCount: { ideal: 2 },
  sampleRate:   { ideal: 48000 },
}})
```

`MediaRecorder` → `audio/webm;codecs=opus` at `audioBitsPerSecond: 192000`, `timeslice: 5000`. Every
chunk is written straight to an OPFS file, so a killed tab loses at most five seconds. Wake Lock is held
for the duration and re-acquired on `visibilitychange`; `navigator.storage.persist()` runs on first use.
On load, an orphaned in-progress OPFS recording is detected and offered for recovery.

#### Recorder screen — deliberately sparse

Everything below is thumb-reachable and there is nothing else on the page.

```
┌──────────────────────────────────┐
│  ✕                               │   small, low-emphasis cancel
│                                  │
│            4:07.3                │   large duration
│                                  │
│    ▁▃▅█▇▄▂▁▂▅▇█▆▃▁▂▄▆           │   rolling waveform, last 10s
│                                  │
│            (  ● )                │   big record / pause / resume
│                                  │
│  ⚠ Recording from 1:23 will      │   only when punched in mid-take
│    replace 0:37 of audio         │
│                                  │
│           [ Save ]               │
└──────────────────────────────────┘
```

- **Big centre button** cycles Idle → *Record*, Recording → *Pause*, Paused → *Resume*.
- **Rolling waveform** of the last 10 seconds, scrolling right-to-left on a canvas at ~30 fps from
  `AnalyserNode` RMS buckets, with a clip indicator. This is the "is it actually hearing me, and is the
  gain sane" confidence signal — and on a phone mic that reassurance matters more than anything else.
- **Save** pauses first, then opens a sheet asking for a **name** (required) and **tags** (optional,
  using the same recency-ordered picker as everywhere else), then finalizes and uploads.
- **Cancel** is small and cornered, and always confirms: *"Discard 4:07 of recording? This can't be undone."*

#### Review while paused

Pausing reveals a review strip: the full-take waveform with a scrubbable playhead, a play/pause for
review playback, and a **"Seek to end"** button that appears as soon as the playhead isn't at the end.

**Resume is disabled while review playback is running** — you stop playback first. That removes the
ambiguous "recording while listening" state entirely rather than trying to define behaviour for it.

#### Punch-in overdubs

Resuming with the playhead mid-take records over that spot. `MediaRecorder` can't insert into the middle
of an existing buffer, so a punch-in simply starts a **new** recorder whose output is stamped with
`timelineStart = playheadPosition`. A session is therefore a *list of takes*, not one buffer.

- **Resolution rule:** later takes win over earlier ones wherever they overlap. Anything not covered by a
  later take survives — so punching in at 1:23 and stopping at 2:00 replaces only 1:23–2:00 and keeps the
  original tail beyond 2:00 intact.
- **Genuinely non-destructive:** every take uploads and stays on disk in the `takes` table. The editor
  gets a "Takes" list where switching a punch-in off brings the underlying original audio straight back.
- **The warning under the Record button** appears whenever the playhead isn't at the end, updating live as
  you scrub: *"Recording from 1:23 will replace 0:37 of existing audio."* Amber and informational — it
  never blocks the button.
- Rendering resolves the take stack into intervals, then `atrim`s each from its source with a ~15 ms
  `acrossfade` at the seams so punches don't click. It reuses the exact same renderer as the edit list —
  a punch-in is just a segment list with more than one `source`.

#### Import fallback

A plain file-import path (`<input type="file" accept="audio/*">`) is cheap insurance that lets you use a
dedicated recorder app whenever the browser disappoints.

Because the mic is usually the phone's built-in one, the Phase 0 unprocessed-audio check and the denoise
work in Phase 4 are the highest-value parts of this plan, not optional polish.

### 1b. Bulk import of your existing folder

Two entry points into the same ingest pipeline:
- **Server-side**: `npm run import -- /path/to/folder --user ben1120@gmail.com` walks a directory, ingests
  every audio file it recognizes, derives a default title from the filename, and preserves the file's
  mtime as `created_at` so your library isn't all stamped with today's date. Idempotent via a content
  hash, so re-running it doesn't duplicate.
- **In-app**: multi-file drag-and-drop onto the library page with a progress list, for smaller batches.

Since these files are already final mixes, imported songs land as a single take with an empty
`edit_list` — that take *is* the master, and editing works on them identically.

### 2. Ingest pipeline (`server/utils/audio.ts`)

A recording session uploads its takes plus the arrangement. Each take goes out in chunks
(`POST /api/recordings/:id/takes/:takeId/chunk?index=n` → append to temp file → `/finalize`) so flaky
mobile connections resume instead of restarting. Then, server-side:

1. Store each upload verbatim as a `takes` row — written once, never touched again
2. `ffprobe` → duration, sample rate, channels
3. **Remux to Ogg** (`-c:a copy` where possible) — fixes the broken-seeking problem inherent to
   `MediaRecorder`'s WebM output
4. Resolve the take stack into the initial `edit_list.segments` and render `master.ogg`
5. Generate peaks: decode to raw PCM via ffmpeg, compute min/max per bucket in Node (~4000 buckets),
   write `peaks.json`. No extra binary needed, and it's what wavesurfer wants.

### 3. Browsing, metadata, tags, albums

- Song list with search, tag filter (AND/OR), sort by date/rating/title; card + compact list views
- Detail page: all metadata fields inline-editable, star/slider rating out of 10, external link field
- Tag input: typeahead over existing tags **ordered by `tags.last_used_at DESC`**, create-on-Enter.
  Every attach bumps `last_used_at`, so your habitual tags float to the top.
- Albums: pick songs from a modal, drag to reorder (`position` reindexed on drop), album playback queue
- **Playback**: a persistent bottom player bar surviving route changes; play/pause, seek, skip, speed,
  loop. Audio served via a Range-request-capable Nitro handler so seeking works.

### 4. Sharing & export

- `POST /api/songs/:id/share` mints a 16-char `nanoid` token. Shared URLs carry a **slug fragment** so a
  bare link is readable at a glance instead of being an opaque token:
  `https://songtrack.nebtown.info/s/V1StGXR8Z5jdHi6B#nocturne-in-e-flat`
  `https://songtrack.nebtown.info/a/kTn3xQpL9wRz2vYc#late-night-takes`
  The fragment is never sent to the server, so it's purely cosmetic and can't leak or break the link —
  edit the title later and old links keep working with a stale-but-harmless fragment. Stored as
  `songs.slug` / `albums.slug`, regenerated on rename.
- `/s/:token` and `/a/:token` are public, unauthenticated, `noindex`, and revocable
- Export: `GET /api/songs/:id/download?format=mp3|ogg` renders the edit list and caches by `spec_hash`
  (mp3 LAME V0, ogg Opus 192k)

### 5. Non-destructive editing (`app/pages/songs/[id]/edit.vue`)

wavesurfer v7 with pre-computed peaks; Regions plugin draws keep-segments as draggable regions and the
noise-profile selection as a distinct region. Every operation edits `edit_list` in local state; **Preview**
renders server-side, **Save** persists. Full undo/redo is just an array of edit-list snapshots — free,
because nothing is ever destroyed.

**Auto-trim proposal** — `silencedetect`, but threshold-relative, not absolute:

1. Run `ffmpeg -af silencedetect=noise=-45dB:d=0.5` to find candidate regions
2. Measure the actual noise floor from the quietest detected region and re-run with
   threshold = `floor + 6 dB`. A fixed dB value fails on quiet recordings.
3. **Tail handling for held final chords** (your specific concern): a piano chord decays gradually and a
   naive gate chops it. Instead, find the last sample above `floor+6dB`, then walk forward while the
   RMS envelope is still *falling* — only cut once the level curve flattens into steady-state noise. Add
   a user-tunable tail pad (default 1.5 s) and a long fade-out (default 1.2 s).
4. **Never auto-apply.** Present the proposal as draggable regions with a one-click "preview 3 s either
   side of this cut" button that renders just that window (`ffmpeg -ss/-t` — near-instant).

**Crop out the middle** — select a region, hit "Remove selection", and it splits `segments` in two.
Your "keep first 90s and last 60s" case is two clicks.

### 6. Noise reduction (`app/components/editor/NoisePanel.vue`)

#### The landscape — what actually works on piano, and what it costs

| Technique | Tool | Good for | Tradeoff |
|---|---|---|---|
| **Spectral subtraction w/ learned profile** | `afftdn` + `sn` runtime commands | Fan, air-con, hiss, room tone | The workhorse. Pushed too hard it makes "musical noise" — chirpy/watery artifacts on sustained notes |
| **Non-local means** | `anlmdn` | Low-level broadband hiss | Gentler and better at preserving detail, but weaker and much slower; useless on tonal hum |
| **Classic noise print** | `sox noisered` | Same class as `afftdn` | Older algorithm, extra binary, needs `sensitivity ≈ 0.2–0.3`. Worth having as a second opinion when `afftdn` artifacts |
| **Narrow notches on detected tones** | `equalizer` / `anequalizer`, high Q | Mains hum 50/60 Hz + harmonics, motor whine | Tonal only; a notch sitting on a played note dulls it slightly |
| **Highpass** | `highpass=f=35` | Rumble, handling noise, HVAC thump | Piano A0 is **27.5 Hz** — the usual "highpass at 80 Hz" advice would gut your bass register |
| **Downward expander** | `agate` | Noise in the gaps between phrases | Clamps long decays; low ratios only |
| **ML speech enhancement** | RNNoise / `arnndn`, DeepFilterNet | **Nothing here — actively harmful** | Trained to keep *speech* and discard everything else. Confirmed: applied to music they treat instrumentation as noise and degrade it. Excluded on purpose |
| **ML source separation** | Demucs `htdemucs` | Removing conversation/vocals from music | The only real answer for voices. Python + PyTorch, ~2 GB image growth, ~1–3× realtime on CPU → **Phase 6** |

The short version: for a piano recording, **classical DSP is the right tool and the fashionable AI
denoisers are the wrong one.** The only place ML helps is separation, not suppression.

#### Your question: does a 3-second ambience lead-in work?

**Yes — and it's the highest-leverage thing in this whole feature. Two caveats, and I'd make it 5 seconds.**

Why it works: the profile is captured through the same mic, same gain, same position, same room, seconds
before the music — so it describes your actual noise rather than a generic model. That's exactly the
input `afftdn`'s `sn start` / `sn stop` commands want. On length, iZotope's own guidance for spectral
de-noise is "the longest section of noise you can find, ideally a few seconds" — 3 s is right at the
usable minimum, and 5 s costs you nothing while giving the FFT more frames to average over. Lower profile
variance means fewer musical-noise artifacts, which is precisely the failure mode you care about.

**Caveat 1 — it depends on auto-gain actually being off.** If AGC is still active (limitation #2), it will
creep the gain up during the silent lead-in and pull it back down when you start playing. The profile
then describes a *louder* noise floor than the one sitting under the music, `afftdn` over-subtracts, and
you get watery artifacts exactly where you least want them. This makes the Phase 0 spike a direct
prerequisite for the ambience workflow, not just a nice-to-have. Fallback if AGC proves undefeatable:
profile from a quiet gap *inside* the performance, and prefer `tn=1` (noise floor tracking) over a fixed profile.

**Caveat 2 — stationary noise only.** Fan, fridge, air-con, computer, traffic drone: yes. Conversation,
a door, a dog: no — a static profile can't represent something that changes. That's what Phase 6 is for.

**So don't rely on you remembering to do it — build it in.** Hitting Record starts a 5-second
**ambience lead-in**: a "Hold still — sampling the room" countdown, then a visual go signal. That region
is stored automatically as `songs.noise_region`, so every recording arrives with its denoiser
pre-armed and zero editing work. Auto-trim then proposes cutting the lead-in from the final render, while
the take keeps it forever — the ambience serves the filter, then disappears from the output. Toggleable
for when you just want to hit record and play.

#### The panel

Every option previews on a 15-second window and A/B-compares against the original before it's committed.

- **`nr` as one slider**, Gentle (6 dB) → Strong (24 dB), defaulting conservative at ~10 dB.
- **`gs` (gain smoothing) defaulted to ~6** rather than FFmpeg's default of 0. It smooths gain across
  adjacent frequency bins and is specifically the parameter that suppresses musical-noise artifacts on
  sustained notes — the single most important non-obvious setting here.
- **"Listen to what's being removed"** — `om=n` makes `afftdn` output *only* the material it is
  subtracting. Play that back and you should hear fan and nothing else; if you hear piano in it, you've
  gone too far. This is the best guard against over-processing that exists, and it's one parameter.
- **Auto-notch**: decode the profiled region, FFT it in Node, find spectral peaks above the local median,
  and emit high-Q `equalizer` notches at those frequencies and their harmonics — presented as toggleable
  chips ("50 Hz", "100 Hz", "150 Hz") rather than applied silently.
- **`agate`** offered last, with its decay warning visible.
- **`loudnorm`** to −16 LUFS as a separate "level" step, so an album of takes sounds coherent.

A representative chain:
```
asendcmd=0.2 afftdn sn start, asendcmd=5.0 afftdn sn stop,
afftdn=nr=10:gs=6, equalizer=f=50:t=q:w=30:g=-24, highpass=f=35
```

### 7. Render pipeline

One function builds an FFmpeg filtergraph from an edit list:
`atrim`/`asetpts` per segment → `acrossfade` joins → filter chain → `afade` → `loudnorm` → encode.
Keyed by `spec_hash` into `renders`, so an unchanged edit list never re-renders. Jobs run in a simple
in-process queue with concurrency 1–2 (this is a family-scale app; a real job queue is unnecessary).

---

## Build phases

- **Phase 0 — Device spike (do this first, ~half a day).** A single throwaway page that records 6 minutes
  on your actual Android phone: screen on, screen off, app backgrounded. Check whether audio survives,
  and listen for gain-pumping that would prove the unprocessed-audio constraints were ignored. This
  de-risks limitations #1 and #2 *before* anything is built on top of them.
- **Phase 1 — Foundation.** Nuxt 4 + Tailwind 4 + DaisyUI 5, Dockerfile, nginx wiring, Google auth with
  admin seeding and the pending/approved states, schema + migrations, recorder, chunked upload, ingest
  pipeline, **the bulk-import script** (so you're testing against your real backlog from here on), song
  list/detail, playback bar.
- **Phase 2 — Organization & admin.** Metadata fields, tags with recency ordering, filtering, albums with
  reordering, share links, mp3/ogg export, and the `/admin` UI — approval queue, signups toggle,
  read-only impersonation.
- **Phase 3 — Editing.** Waveform editor, edit list, punch-in take resolution and the Takes list, auto-trim
  with decay-aware tail detection and cut previews, crop-the-middle, render cache, undo/redo.
- **Phase 4 — Noise reduction.** Ambience lead-in, noise profiling UI, `afftdn` with `gs` and the
  `om=n` "listen to what's removed" audition, FFT-driven notch detection, gate, `loudnorm`, A/B preview.
- **Phase 5 — Polish.** PWA install + offline cache, keyboard shortcuts, bulk tag editing.
- **Phase 6 — Source separation (later, as you flagged).** Demucs `htdemucs` in a sidecar container for
  removing background conversation, slotting into the filter chain as one more step. Kept in a separate
  container so the main image doesn't grow ~2 GB and so a slow CPU job can't block normal renders.

---

## Verification

- **Phase 0 gate:** a 6-minute Android Chrome recording survives screen-off, and the waveform shows no
  auto-gain pumping between loud and quiet passages.
- **Ingest:** upload a recording; confirm `master.ogg` seeks correctly by dragging to 80% and hearing the
  right audio — this is the specific bug the remux exists to fix.
- **Non-destructiveness:** apply a trim, a crop, and a denoise; then clear the edit list and confirm the
  render matches the original. Confirm no file under `takes/` ever changes mtime.
- **Punch-in:** record 3 minutes, pause, seek to 1:00, confirm the amber warning reports the correct
  amount of audio to be replaced, resume and record 20 seconds. Confirm the result is original-to-1:00 +
  new-take + original-from-1:20-onward, with no click at either seam. Then toggle the punch-in off in the
  Takes list and confirm the original 1:00–1:20 comes back intact.
- **Recorder guards:** confirm Resume is disabled during review playback, that "Seek to end" appears only
  when the playhead has moved, and that Cancel confirms before discarding.
- **Tail preservation:** record a take ending in a long held chord, run auto-trim, and confirm the
  proposed cut lands after the decay, not during it. This is the acceptance test for the feature you
  specifically called out.
- **Denoise:** record with a fan running, using the ambience lead-in. A/B the result — the fan should drop
  noticeably with no watery artifacts on sustained notes. Then switch to `om=n` and confirm you hear fan
  and *not* piano in the removed material; that's the real pass/fail for this feature.
- **Ambience lead-in under AGC:** compare the noise floor in the lead-in against a quiet gap mid-piece. If
  they differ significantly, auto-gain is still active and the fixed-profile path should fall back to `tn=1`.
- **Sharing:** open a share link in a private window with no session; confirm playback and seeking work,
  that the `#slug` fragment doesn't affect resolution, and that no other song is reachable. Rename the
  song and confirm the old link still resolves. Revoke and confirm 404.
- **Export:** download mp3 and ogg; verify duration matches the edit list and joins are click-free.
- **Multi-user:** sign in as a second Google account; confirm zero cross-visibility of songs, tags, and
  albums, and that direct API calls with another user's song id return 404 rather than data.
- **Approval flow:** the second account lands as `pending`; confirm it can record, that the 11th upload is
  refused with a clear message, and that approving it in `/admin` immediately lifts the cap. Flip the
  signups toggle off and confirm a third account is rejected at the callback with no row created.
- **Impersonation:** view as the second user, confirm you see their library and that any edit, delete, or
  upload attempt is refused while the banner is showing. Confirm both actions land in `audit_log`.
- **Bulk import:** run the import script against your folder, confirm counts match, `created_at` reflects
  original file mtimes, waveforms render for every song, and a second run adds nothing.
- **Deploy:** `docker compose up`, hit `https://songtrack.nebtown.info`, complete Google login end-to-end,
  and upload a file large enough to exercise the nginx `client_max_body_size` setting.

## Sources

- [MediaStream Recording API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream_Recording_API)
- [MediaTrackConstraints — MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints)
- [Chromium issue 327472528 — mic processing constraints can't be disabled](https://issues.chromium.org/issues/327472528)
- [Screen Wake Lock API — Chrome for Developers](https://developer.chrome.com/docs/capabilities/web-apis/wake-lock)
- [Storage quotas and eviction criteria — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [wavesurfer.js v7](https://github.com/katspaugh/wavesurfer.js/)
- [FFmpeg audio filters (`afftdn`, `silencedetect`, `agate`, `loudnorm`)](https://ffmpeg.org/ffmpeg-filters.html)
- [`afftdn` full parameter reference — `nr`, `nf`, `gs`, `om`, `tn`, `sample_noise` commands](https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Audio/afftdn.html)
- [iZotope RX Spectral De-noise — noise profile length guidance & musical-noise artifacts](https://s3.amazonaws.com/izotopedownloads/docs/rx9/en/spectral-de-noise/index.html)
- [Noise reduction with ffmpeg and sox — `noisered` sensitivity in practice](https://monodes.com/predaelli/2021/12/19/how-to-do-noise-reduction-using-ffmpeg-and-sox-articulating-ideas/2/)
- [DeepFilterNet vs RNNoise — both speech-only; degrade music](https://noisereducerai.com/blogs/deepfilternet-ai-noise-reduction/)
- [Demucs — music source separation (Phase 6)](https://github.com/facebookresearch/demucs)
- [nuxt-auth-utils](https://github.com/atinux/nuxt-auth-utils)
- [DaisyUI 5 + Nuxt 4 + Tailwind 4 setup](https://daisyui.com/docs/install/nuxt/)
- [RNNoise WASM (jitsi) — speech-preserving, therefore wrong for piano](https://github.com/jitsi/rnnoise-wasm)

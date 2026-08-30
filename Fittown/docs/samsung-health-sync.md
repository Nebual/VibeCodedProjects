# Samsung watch sync — the plan

How Samsung Health / Galaxy Watch data (chiefly its estimated calories burned)
gets into Fittown, and why the design is shaped the way it is.

Status: **All five phases built.** Phases 1, 2 and 5 are real-device tested or
live-verified end to end; Phases 3 and 4 (Health Connect itself) are compiled
and inspected in the built APK but have never run against a real Health
Connect database — see §6. Phase 2's testing found one real bug (fixed);
Phase 5's build found another (also fixed — see §7). The manual "Connect a
phone" pairing UI (Settings, login) is deliberately hidden, not missing — not
needed since automatic sign-in pairing works, but everything underneath it is
intact; flip `SHOW_DEVICE_PAIRING_UI` in `app/utils/featureFlags.ts`.

- Phase 1: schema, device pairing, `/api/health/sync` with the calorie
  cascade, `health_sync_log`, the reversible `workout_calorie_source`
  setting. `server/utils/healthSync.ts`, `server/utils/deviceAuth.ts`,
  `test/health-sync-db.test.ts`, `test/device-auth-db.test.ts`.
- Phase 2: a Capacitor Android project (`mobile/`) with the `fittown://pair`
  deep link, a Kotlin plugin storing the device token in
  EncryptedSharedPreferences (`DeviceTokenPlugin.kt`), a `/pair` page, and —
  after a real install on a real phone hit the `disallowed_useragent`/
  cookie-jar problem described in §3 — a Custom Tab-based sign-in that pairs
  the app automatically as the tail end of Google login. See §3 for the full
  account. Also fixed from real-device testing: Android 15's mandatory
  edge-to-edge rendering had content starting under the status bar;
  `MainActivity` now pads the WebView to the actual system-bar insets.
- Phase 3: `HealthConnectSync.kt` — reads `ExerciseSessionRecord`s, aggregates
  `ActiveCaloriesBurnedRecord` over each session's own window for the calorie
  cascade's `device_window` step (confirmed via research, not assumed:
  `ExerciseSessionRecord` carries no calories of its own — every session's
  figure here **is** the device-window step, never the plain "device" one),
  reads today's steps/active-calories for `daily[]`, and POSTs directly to
  `/api/health/sync` with the stored device token — no WebView involved.
  Requesting Health Connect permission needed a mandatory "rationale" activity
  most guides don't mention (`HealthPermissionsRationaleActivity.kt` + the
  manifest entries) — without it the permission prompt doesn't work at all,
  not just a Play Store requirement.
- Phase 4: two changes to Phase 3's read path, plus the actual background
  trigger. First, `HealthConnectSync` now stores a Health Connect **changes
  token** and reads incrementally from it (`getChanges()`, paginated via
  `hasMore`/`nextChangesToken`) instead of re-reading a fixed lookback window
  every sync; a missing or expired token (`changesTokenExpired`) falls back to
  the original full read, which also mints the first token. Second, and only
  possible because of the first: `DeletionChange` entries now populate
  `deleted[]`, which had been hard-coded empty since Phase 1 — nothing before
  this could tell that a session had disappeared, only that it was absent
  from *this particular* read. Third, `HealthSyncWorker.kt`
  (`androidx.work.CoroutineWorker`) runs the same `HealthConnectSync.syncNow()`
  MainActivity's resume handler calls, on a `PeriodicWorkRequest` scheduled
  for ~6 hours with a network constraint — the backstop for whenever the app
  itself isn't open, exactly as planned, though Samsung's One UI is
  independently known to be aggressive about killing scheduled background
  work, so this is best-effort by design, not a guarantee.
- Phase 5: everything in §7, live-verified against a running server rather
  than only compiled — no Android toolchain involved this time, so there was
  no reason to settle for less. Found one real bug the same way Phase 2's
  testing found one: deleting a device-synced workout only removed the row,
  never recording that it should *stay* removed, so the next sync silently
  re-imported it. Confirmed as a real bug and confirmed fixed, by seeding a
  synced workout, deleting it through the real endpoint, and re-running the
  exact sync that used to resurrect it — the fixed version now reports it
  `skipped`.

**None of Phase 3 or 4 has run against a real Health Connect database.**
Compiled and inspected in the built APK exactly like Phases 1–2 were — the
manifest, and every new class and method name confirmed present in the actual
dex bytecode, not just a clean Gradle exit code — but the exercise-type
mapping, the aggregate query, the permission flow, the changes API's
pagination and expiry handling, and whether `PeriodicWorkRequest` actually
fires on a real device at all: none of that is provable without one. This is
the phase the plan itself called "the uncertain one," and building it further
didn't make that less true, only differently true — see §6 for the specifics.

`./gradlew assembleDebug` succeeds; `mobile/README-sandbox-build.md` has the
sandbox setup notes.

---

## 1. Why this can't be a normal OAuth integration

Fittown already talks to one external identity provider over OAuth (Google),
so the obvious shape would be "add Samsung the same way". That shape is not
available:

- **Samsung has no public server-to-server fitness API.** There is no
  `api.samsunghealth.com` a self-hosted Nuxt server can hold a token for. The
  Samsung Health Data SDK is an **Android library** — it runs on the phone, it
  talks to the Samsung Health app installed beside it, and it requires
  per-app registration/approval with Samsung for most data types.
- **Health Connect, the Android-standard alternative, is also on-device.** It
  is an OS-level datastore that apps read and write locally. Samsung Health
  writes into it once the user turns that on. There is still no cloud endpoint.

So every route to this data runs *through something installed on the phone*.
The only question is what that something is.

The answer chosen here: **the phone app is Fittown itself** — a Capacitor
shell around the existing web app, which doubles as the daily driver and as
the sync agent. One artifact to install, one thing to keep working, and the
sync gets a foreground trigger for free (see §6).

## 2. The double-counting trap — read this before anything else

This is the part that makes data quietly wrong, so it comes first.

Fittown's calorie budget is `BMR x activity multiplier`, and with
`exercise_adds_calories` on, logged workouts are **added back on top**. The
activity multiplier (`shared/body.ts`, 1.2 → 1.9) is already a claim about how
much you move in a day.

Health Connect offers three tempting numbers. Two of them are traps:

| Record | What it is | Verdict |
| --- | --- | --- |
| `TotalCaloriesBurnedRecord` | Active **+ BMR** | **Never import into the budget.** Adds ~1,600 kcal/day of resting metabolism the target already contains. |
| `ActiveCaloriesBurnedRecord` (all-day) | Every step, including walking to the shops | **Not into the budget.** This is precisely what the activity multiplier is paid to estimate. Importing it on top of "lightly active" double-counts incidental movement. |
| `ExerciseSessionRecord` + its active calories | One deliberate workout, with a start and an end | **This is the one.** It is the same *kind* of thing a hand-logged workout is, so it lands in `workout_entries` without changing what that table means. |

Two consequences that must reach the UI, not just this document:

1. **A user who syncs sessions should set `activity_level` to `sedentary`.**
   The multiplier's job — guessing training volume — is now being done by real
   data. Leaving it at "moderately active" counts the same training twice.
   The calorie-target dialog should say so when a device is connected.
2. **All-day steps and active calories are still worth having, as display-only
   figures.** They go to `biometric_entries` (§4), which never touches the
   budget. `biometric_types` already exists for exactly this kind of "number I
   want to see on Trends", and its `UNIQUE(user_id, type_id, date)` makes a
   daily upsert idempotent for free.

A third, softer point: Samsung's per-session estimate and Fittown's
`MET x kg x hours` estimate are different models. Mixing them in one Trends
line puts a visible step in the chart on the day sync switched on. That is
acceptable — but the Fitness card should mark device rows so the number is
attributable (§7).

## 2.1 Don't decide the source by hand — decide it per session

The first draft of this plan opened with a spike: take the Samsung phone,
confirm sessions carry per-session calories, *then* write the importer. That
was the wrong shape, for a reason worth writing down.

What the public record says is that Samsung Health **does** write active
calories per workout session to Health Connect — but **not** for daily steps —
and that developers see **incomplete** calorie data, while users see workouts
**stop syncing entirely** after Samsung Health updates. The failure is
intermittent. A one-off spike samples it once and hands back false confidence.

So the code decides, per session, in a three-step cascade:

1. the session's own `active_kcal`, if Health Connect carried one;
2. else the sum of `ActiveCaloriesBurnedRecord` over the session's
   `[start, end]` window, computed on the device;
3. else `MET x kg x hours` from the mapped exercise — the model Fittown has
   always used, with the weight lookup `server/api/workouts/index.post.ts`
   already does.

Which step fired is recorded on the row as `calorie_basis`. That column *is*
the spike, run continuously against real data instead of once by hand: after a
week of ordinary use, `SELECT calorie_basis, COUNT(*) …` says exactly what
Samsung is really sending, and keeps saying it when Samsung's next update
quietly changes the answer.

**Store both numbers, resolve late.** The device's figure is kept raw in
`device_kcal` and never overwritten; `calories` is the resolved figure the
diary and the budget use. That makes the one judgement genuinely a *user's* —
"do I trust Samsung's model or the Compendium's?" — into a setting that can be
flipped and re-flipped over existing history:

- `user_goals.workout_calorie_source` — `'device'` (default) or `'estimate'`.
- Flipping it recomputes `calories` on **`source = 'health_connect'` rows
  only**, from data already stored. No re-sync, and a hand-logged workout is
  never touched.

Note what is *not* a setting: which Health Connect record type to read. That is
a mechanism, the cascade already handles it, and a user has strictly less
information than the code does to choose between them. A setting there would
be handing someone a decision they can't evaluate.

## 3. Authentication: device tokens, and why not Google

**Google refuses OAuth inside an Android WebView** (`disallowed_useragent`).
A Capacitor shell is a WebView. So the existing `/auth/google` flow cannot be
the app's way in, and this is not a detail that can be discovered late — it
determines the whole onboarding design.

The mechanism underneath is a short-lived, single-use **pairing code**
(8 chars, 10-minute TTL, cleared on claim) traded for a device token at
`POST /api/devices/claim { code, name }`. The server mints 32 random bytes,
returns them **once**, and stores only a SHA-256 hash. There are two ways a
code reaches the app — a manual fallback, and the one that actually matters
for a normal login, added after the first draft of this plan turned out to
be wrong (see below).

### The manual fallback

1. The user signs in to Fittown **in their phone's real browser**, where
   Google OAuth works as it does today.
2. Settings → *Connect a phone* → `POST /api/devices/pair-code` shows the code.
3. The app receives it — typed by hand into `/pair`, or pre-filled via a
   `fittown://pair?code=…` deep link if they tap it on the same phone — and
   claims it.

Kept for pairing a second device, or re-pairing without another Google login.
Not the primary path any more: it needs the user to leave the app, do
something in Settings, and come back, which is a lot to ask for the very
first thing a new install does.

### The one that matters: automatic pairing through sign-in itself

**The first draft of this plan proposed Chrome Custom Tabs as an
alternative worth considering "if onboarding ever needs to work without a
browser." Testing showed it isn't optional — it's required, for a more
specific reason than the `disallowed_useragent` block.** A plain
`<a href="/auth/google">` inside the WebView starts the flow there, and
Capacitor's default policy pops the redirect to `accounts.google.com` out
into the *system* browser once it hits a foreign host. That split matters
because nuxt-auth-utils' CSRF `state` cookie was set on the leg the WebView
made — a different cookie jar than the one the system browser uses for the
callback. The result isn't Google's UA rejection; it's a clean 200 all the
way to a completed Google login, followed by `state mismatch` on the
callback, because the two requests never shared cookies. Confirmed in
testing against the real deployment, not predicted from documentation.

The fix is to never let the WebView touch any of it: `app/pages/login.vue`'s
native-only button opens the **entire** flow — first request through
callback — in one Chrome Custom Tab via `@capacitor/browser`'s
`Browser.open({ url: '/auth/google?client=app' })`. One consistent cookie
jar for both legs fixes the state check. `server/routes/auth/google.get.ts`
sets a `fittown_oauth_app` marker cookie on the first leg (alongside, and for
the same reason as, nuxt-auth-utils' own state cookie) and reads it back in
`onSuccess`; if present, instead of opening a session nobody in that
ephemeral tab is there to use, it calls `createPairCode()` — the exact same
function Settings' pairing button calls — and redirects the Custom Tab to
`fittown://pair?code=…`. Android hands that off to the installed app via the
intent-filter already added for the manual flow; the app's
`appUrlOpen` listener (`app/plugins/device-auth.client.ts`) routes it to
`/pair`, which claims it exactly like a typed-in code would.

Net effect: tap **Sign in**, do Google auth once, land back in the app
already authenticated. One user-visible step, not two — and it was only
reachable by first building the thing that broke and reading why.

That one token then serves two consumers:

- **The native sync worker** (Phase 3/4), which runs outside the WebView and
  has no cookies: `Authorization: Bearer <token>` on `POST /api/health/sync`.
- **The WebView's session.** `app/plugins/device-auth.client.ts` asks the
  native layer (`DeviceTokenPlugin.kt`, via EncryptedSharedPreferences) for
  the token on launch and `POST`s it to `/auth/device`, which verifies it and
  calls `setUserSession()` — exactly the shape `server/routes/auth/dev.post.ts`
  already has. The cookie lands in the WebView's jar and everything
  downstream is unchanged. The token never appears in a URL — only the
  short-lived pairing *code* does, in the `fittown://pair` redirect, and it's
  single-use.

**Be honest about what this token is:** because `/auth/device` mints a full
session, the token is session-equivalent. Mitigations are the ordinary ones —
hashed at rest, shown once, listed and revocable in Settings, `last_used_at`
recorded. It is the right trade for a household app; it would want rethinking
if Fittown were multi-tenant.

**Keep `requireUser()` untouched.** The AGENTS.md invariant — every API route
calls `requireUser(event)` and scopes by `user_id` — stays exactly as it is.
Device tokens get a *separate* `requireDevice(event)` helper used only by
`/api/health/sync` and `/auth/device`. A device token cannot reach the rest of
the API directly; it has to go through `/auth/device` and become a session
first. That keeps the blast radius of the new credential visible in two files
rather than spread across every handler.

**Still unverified, and can only be verified on a real device:** does
`fittown://pair` actually hand off from a Custom Tab to the installed app the
way it does from a plain browser link; does `Browser.open()` reliably launch
a Custom Tab (vs. some OEM browser's own tab implementation with different
cookie behavior) on a real Samsung phone. The state-mismatch bug was found
by testing against production from a real phone; this design is the fix for
what that testing found, not itself re-tested the same way yet.

## 4. Schema changes

Per `docs/schema-and-db.md`: **every added column is two edits** —
`SCHEMA_SQL` in `server/db/schema.ts` *and* `ADDED_COLUMNS` in
`server/utils/db.ts` — and **a new index over a new column goes in
`POST_MIGRATION_SQL`**, never `SCHEMA_SQL`.

### `workout_entries` gains three columns

```sql
source        TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'health_connect'
external_id   TEXT,                            -- Health Connect record UID
started_at    TEXT,                            -- session start, ISO8601 with offset
device_kcal   REAL,                            -- what the watch said, raw, never overwritten
calorie_basis TEXT                             -- 'device' | 'device_window' | 'estimated'
```

`device_kcal` and `calorie_basis` are null on every manual row, which costs a
byte each in the record header — the same trade the recipe columns already make
across 200k+ imported foods, and the same reasoning applies.

`user_goals` gains one column: `workout_calorie_source TEXT NOT NULL DEFAULT
'device'` (§2.1). Default `'device'` because a user who connected a watch
presumably wants to hear from it.

`date` stays the user's local calendar day and remains what every existing
query groups by; `started_at` is additional detail, not a replacement.

The index that makes the whole thing safe, in `POST_MIGRATION_SQL`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_workout_external
  ON workout_entries(user_id, external_id) WHERE external_id IS NOT NULL;
```

That partial unique index is the entire idempotency guarantee. Re-syncing the
same window must be a no-op, and an `ON CONFLICT … DO UPDATE` against this
index is what makes it one. Samsung can *revise* a session after the fact, so
upsert — not `INSERT OR IGNORE`.

### Two new tables

```sql
CREATE TABLE IF NOT EXISTS device_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,   -- sha256; the token itself is never stored
  name         TEXT NOT NULL,          -- "Ben's Galaxy S24"
  pair_code    TEXT,                   -- set while unclaimed, cleared on claim
  pair_expires TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  last_sync_at TEXT,
  revoked_at   TEXT
);

-- A device row the user deleted in Fittown. Without this, "delete" is a lie:
-- the next sync re-imports it. Exactly the sort of silently-wrong behaviour
-- AGENTS.md is about.
CREATE TABLE IF NOT EXISTS health_ignored (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, external_id)
);
```

And a third, small one — this is what replaces the spike:

```sql
-- The last N sync payloads, verbatim. Cheap, self-trimming, and the only way
-- to answer "what is the watch actually sending?" without a debugging session
-- on someone's phone. Samsung's sync is reported to break silently after app
-- updates; this is how that gets noticed rather than discovered in a gap on
-- the Trends chart six weeks later.
CREATE TABLE IF NOT EXISTS health_sync_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  received_at   TEXT NOT NULL DEFAULT (datetime('now')),
  payload       TEXT NOT NULL,   -- raw JSON as sent
  session_count INTEGER NOT NULL,
  outcome       TEXT NOT NULL    -- 'ok' | the error
);
```

Trim to the most recent ~20 rows per user on insert. A payload is a few
kilobytes; twenty of them is nothing next to a 79 MB food database.

### One new activity

Health Connect's `ExerciseType` enum has ~80 values; `shared/activities.ts`
has ~90 named activities. A mapping table (`shared/healthConnect.ts`) covers
the overlap — `RUNNING` → "Running", `BIKING` → "Cycling", and so on — and
anything unmapped falls back to a new library entry, e.g.
`{ name: 'Tracked workout', categories: ['cardio'], met: 5 }`.

Note `MetSpec` is `number | Record<EffortKey, number>` — **not nullable** — so
the fallback needs a real MET. That is not wasted: it is what gets used if a
session ever arrives without calories.

Remember the library invariant: exercises upsert **on name**, and a rename
creates a new row. Once "Tracked workout" has entries against it, its name is
load-bearing.

## 5. The sync endpoint

`POST /api/health/sync`, `requireDevice(event)`:

```jsonc
{
  "timezone": "America/Vancouver",       // the device's own zone — authoritative
  "changes_token": "…",                  // Health Connect cursor, echoed back
  "sessions": [{
    "external_id": "hc-uid-abc",
    "type": "RUNNING",
    "start": "2026-08-29T07:12:00-07:00",
    "end":   "2026-08-29T07:48:00-07:00",
    "active_kcal": 412,
    "distance_km": 6.2,
    "avg_heart_rate": 148
  }],
  "deleted": ["hc-uid-xyz"],             // from the HC changes API
  "daily": [{ "date": "2026-08-29", "steps": 8421, "active_kcal": 620 }]
}
```

Server behaviour, per session:

- Map `type` → `exercise_id`, falling back to "Tracked workout".
- Derive `date` from `start` **in the device's timezone**. This is the one
  place where server-side date derivation is correct rather than forbidden:
  the AGENTS.md rule is that "today" belongs to the user rather than the
  server, and the device is the best available witness to where the user
  actually was. It travels in the payload for that reason.
- Skip anything in `health_ignored`.
- Resolve calories through the §2.1 cascade, storing the raw device figure in
  `device_kcal`, the resolved one in `calories`, and which step fired in
  `calorie_basis`. Reuse the existing validation bounds (`calories` 0–20000,
  `duration_min` 0–1440) from `server/utils/validate.ts`.
- Upsert on `(user_id, external_id)`, writing `source = 'health_connect'`.
- `deleted[]` removes matching rows, **but only where `source =
  'health_connect'`** — a device sync must never be able to delete a
  hand-logged workout.
- `daily[]` upserts into `biometric_entries` under auto-created
  `biometric_types` rows ("Steps" / "Active calories"). Display-only, per §2.

The payload is written to `health_sync_log` **before** it is processed, so a
sync that throws still leaves the evidence behind.

Response: `{ imported, updated, deleted, skipped, basis }` — where `basis` is a
tally like `{ device: 3, device_window: 1, estimated: 0 }`, so the app can show
it and you can see the cascade working without opening the database. The server
stamps `last_sync_at`. The app keeps the Health Connect changes token itself;
the server does not need to understand it.

`active_kcal` may legitimately be absent per session — that is the whole reason
for the cascade — so it must be optional in validation, not required.

## 6. The Android app

A Capacitor shell whose WebView points at the deployed Fittown origin
(`server.url` in `capacitor.config.ts`), so the web app is unchanged and
updates the moment the server deploys — no APK rebuild for web changes. Lives
in `mobile/`, keeping Gradle out of the Nuxt project root.
(`pnpm-workspace.yaml` exists but currently declares only `allowBuilds` — it
needs a `packages:` key adding if `mobile/` is to be a real workspace package.
It doesn't have to be one; a plain subdirectory with its own `package.json` is
enough, and is less to explain.)

**The server URL is baked at build time** from an env var. Runtime
configuration would need a native pre-WebView setup screen; for a self-hosted
app whose users already run `gman-deploy`, building your own APK with your own
hostname is the consistent choice. Revisit if it ever ships to strangers.

Native pieces, in order of risk:

1. **Health Connect reader — built.** `HealthConnectSync.kt`, a plain Kotlin
   object rather than a Capacitor plugin, since nothing in it needs the
   WebView — which is also why `MainActivity.onResume()` and the
   `HealthSyncWorker` background job (item 3) can both call its `syncNow()`
   directly. No community plugin was evaluated in the end — the direct
   `androidx.health.connect.client` API (1.1.0-alpha12; the library has never
   left alpha, which is normal for it) turned out to be little enough surface
   to write directly. Reads are **incremental**: a Health Connect changes
   token is stored and resumed from (`getChanges()`, paginated via
   `hasMore`/`nextChangesToken`) on every sync after the first, which is what
   makes `deleted[]` — hard-coded empty since Phase 1 — actually populate now,
   from `DeletionChange` entries; a missing or expired token
   (`changesTokenExpired`) falls back to a plain 7-day `readRecords()`, which
   also mints the token the next sync resumes from. Calories come from
   `client.aggregate(...)` over `ActiveCaloriesBurnedRecord` — not manual
   summing, which would double-count overlapping sources — over each
   session's own window. **Confirmed by research before writing any code, not
   assumed:** `ExerciseSessionRecord` carries no calories field of its own, so
   the cascade's "device" step (a figure the session provides directly) is one
   this integration can structurally never produce — every session synced by
   this app arrives as `device_window` or, when the aggregate itself comes
   back empty (which Samsung Health is independently reported to do), the
   server's own `estimated` fallback. `PERMISSION_READ_HEALTH_DATA_HISTORY`
   (for reading past 30 days) was not requested — the 7-day lookback doesn't
   need it, and asking for more access than is used is worth avoiding on a
   health-data permission screen. The permission grant flow itself needed
   something no guide flagged in advance: Health Connect requires a
   "rationale" activity registered in the manifest
   (`HealthPermissionsRationaleActivity.kt`, plus both a plain intent-filter
   for Android 13- and an `activity-alias` for 14+) or the permission prompt
   does not work at all — confirmed as a hard requirement via research, not a
   Play Store nicety.
2. **Sync on resume — built.** `MainActivity.onResume()` calls
   `HealthConnectSync.syncInBackground()`, requesting permission first if it's
   missing. Debounced internally to skip if the last sync was under 15
   minutes ago, so a resume seconds after the last one is a free no-op rather
   than a wasted request. The primary trigger — item 3 is the backstop for
   when the app isn't open, not the other way round.
3. **Periodic background sync — built.** `HealthSyncWorker.kt`
   (`androidx.work.CoroutineWorker`) calls the exact same
   `HealthConnectSync.syncNow()` item 2 does — that reuse is exactly why item
   1 was written as a plain object instead of tying it to any particular
   trigger. Scheduled from `MainActivity.onResume()` once the app is paired
   (`enqueueUniquePeriodicWork` with `ExistingPeriodicWorkPolicy.KEEP`, so
   re-scheduling on every resume is a no-op once it already exists), network-
   constrained, every 6 hours. Distinguishes "nothing to do" (not paired, no
   permission, Health Connect unavailable — `Result.success()`, since nothing
   about retrying changes any of that without a running Activity to fix it)
   from an actual failed sync attempt (`Result.retry()`, WorkManager's own
   backoff). **Samsung's One UI is independently known to be aggressive about
   killing scheduled background work**, so this is best-effort by design, and
   Phase 5's "onboarding should walk the user through exempting Fittown from
   battery optimisation" is still exactly as necessary as the original plan
   said — building the worker doesn't make Android any less likely to kill it.
4. **Token storage — built.** EncryptedSharedPreferences via
   `DeviceTokenStore.kt`, shared by `DeviceTokenPlugin.kt` (the WebView-facing
   Capacitor plugin, for the `/auth/device` bootstrap) and
   `HealthConnectSync.kt` (which has no WebView to expose a plugin to, and
   reads the token directly to authenticate its own `POST /api/health/sync`).

**None of items 1–3 has run against a real Health Connect database.**
Everything above is confirmed to *compile* and to have landed in the built
APK — checked by inspecting the manifest and the actual dex bytecode, the
same way Phases 1–2 were, not by trusting a clean Gradle exit code. Whether
Samsung Health actually populates `ExerciseSessionRecord`/
`ActiveCaloriesBurnedRecord` the way the research behind this section
describes, whether the permission flow completes cleanly first-try, whether
the changes API's pagination and expiry handling behave as documented,
whether `PeriodicWorkRequest` fires at all against Samsung's own background
restrictions — all of that is exactly what real-device testing exists to
answer next, the same way it already found and fixed two real bugs in
Phase 2.

**System-bar insets — two bugs, not one.** `targetSdk 35` (Android 15) draws
edge-to-edge by default, and apps at that target can no longer opt back out —
found on a real device as content rendering under the status bar.
`MainActivity` pads the WebView to `WindowInsetsCompat`'s system-bar insets
rather than fighting the platform. The first attempt at this (Phase 2) shipped
with a real bug that only surfaced on the device: the padding *listener* was
registered, but nothing ever asked Android to actually dispatch insets to it.
By the point in `onCreate()` where the listener gets attached, Capacitor has
already created and attached the WebView — so the one insets dispatch that
happens as part of that initial attach had, in all likelihood, already passed
with nothing listening, and nothing afterward ever requested a fresh one. The
fix is `ViewCompat.requestApplyInsets()`, called immediately if the view is
already attached (the normal case here) or from an attach-state listener if
not. Worth remembering as a pattern: a correct-looking listener with no
`requestApplyInsets()` nearby is a classic silent no-op, and it compiled fine
both times — this class of bug is invisible to everything except a real
screen.

**Release signing.** Debug builds use Android's auto-generated debug key,
which is fine for one throwaway install but means every debug APK handed out
is really its own untracked identity — Android has no problem discarding one
and installing a fresh one over it. Release builds need a real, *persistent*
keystore, because an update has to be signed with the same key as what's
already on the phone or Android refuses it outright
(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). `mobile/android/app/build.gradle`
reads signing credentials from `mobile/android/app/keystore.properties`
(gitignored, machine-local) if present, and just builds an unsigned-looking
config-less release variant if not — so a fresh checkout without the keystore
still builds, it just can't produce an installable release APK. The keystore
and its password are the one part of this whole project that isn't
reconstructable from the repo: back them up somewhere outside it, because
losing them means every future "update" is actually a new app as far as
Android is concerned, and everyone has to uninstall and reinstall.

**Sideloaded APKs do not auto-update.** `GET /api/app-version` (reading
`mobile/version.json`, the same file `app/build.gradle` reads for
`versionName`/`versionCode`) plus `AppVersionNag.vue` — a native-only banner
comparing the installed version (`@capacitor/app`'s `App.getInfo()`) against
what the live server currently reports — nags when they differ. The banner,
and a plain "Download the app" link in Settings, both point at
`NUXT_PUBLIC_APP_DOWNLOAD_URL` — optional, unset by default (the link and the
nag's clickable version both quietly fall back to text when it's empty), read
by any deployment that hosts the built APK somewhere and wants Settings and
the nag to point at it.

## 7. UI changes — all built, all live-verified

Every item here was checked against a real running server — seeded data,
real HTTP calls, real rendered HTML inspected for the actual expected markup
— not just "compiles." No Android toolchain involved this phase, so there
was no reason to settle for compiling alone the way Phases 3–4 had to.

- **Fitness card** (`app/components/FitnessSection.vue`): a watch glyph on
  `source = 'health_connect'` rows, so a number that came from Samsung is
  never mistaken for a MET estimate. `WorkoutRow` gains `source`, threaded
  through from `server/api/diary/index.get.ts`. Verified: seeded one synced
  and one manual workout on the same day, confirmed the glyph's SVG and its
  "Synced from your watch" title rendered exactly once, on the right row.
- **Deleting a device row writes to `health_ignored` (§4) — and this is
  where Phase 5 found a real bug.** The delete route only ever removed the
  `workout_entries` row; nothing recorded that it should *stay* removed, so
  the next sync silently re-imported it — a household could delete a
  double-logged workout and watch it come back hours later with no obvious
  cause. Fixed in `server/api/workouts/[id].delete.ts`, and confirmed fixed
  the same way Phase 2's bug was: seed a synced workout, delete it through
  the real endpoint, re-run the exact sync payload that used to resurrect it
  — `skipped: 1`, not `imported: 1`.
- **Settings → Watch calorie source:** the two-way choice from §2.1 — "My
  watch's estimate" vs "Estimate from activity & weight" — self-saving like
  Sharing, shown whenever a device is actually connected (independent of the
  hidden pairing panel, since a household that paired through the app's own
  sign-in never sees that panel at all). Verified: flipped it live, confirmed
  the stored value round-trips through `/api/goals`.
- **Settings → "What the watch sent":** collapsed by default, like Diary
  Card Visibility — reads `health_sync_log` (last ~20 rows) and classifies
  each stored payload's sessions with the *exact* function
  (`classifyBasis()`) the sync route itself uses to decide calorie basis, so
  the tally shown can never drift from what actually happened to the data.
  This is the spike from §2.1 made permanent. Verified: ran two real syncs
  (one falling back to `estimated`, one landing as `device_window`) and
  confirmed the panel classified each correctly, most recent first.
- **Calorie target dialog:** warns when a device is connected and
  `activity_level` is above `sedentary` that training may be counted twice.
  The dialog's own content (behind a client-side `<dialog>` open) wasn't
  clicked through in a browser — only confirmed by code review and that the
  page hosting it renders without error. Everything upstream of it
  (`hasConnectedDevice`, fetched unconditionally now rather than only when
  the pairing panel is visible) was verified live.
- `InstallPrompt.vue` needs **no change** — its `variant` computed returns
  `null` unless `beforeinstallprompt` fired (it doesn't in a WebView) or the
  UA is iOS or Firefox-Android, so the "add to home screen" banner already
  stays down inside the app. Still not confirmed on a real device.
- **Version nag** (`AppVersionNag.vue`, `GET /api/app-version`): the app
  compares its own installed version (`@capacitor/app`'s `App.getInfo()`,
  reading the native package info) against what the live server reports from
  `mobile/version.json` — the same file `app/build.gradle` reads to set
  `versionName`/`versionCode` at build time, so bumping one value keeps both
  in sync. Verified the server endpoint returns the file's live content
  (`5.0.0`) and the built APK actually carries `versionCode 5`,
  `versionName 5.0.0` (checked with `aapt dump badging`, not assumed from the
  Gradle config alone). The nag itself — dismiss-and-remember, the actual
  banner appearing on a real out-of-date install — needs a device with an
  older build already on it, which this environment has no way to produce.

## 8. Phasing

The spike is **no longer a gate**. It was one in the first draft; §2.1 explains
why that was wrong. What replaces it is the cascade plus `health_sync_log` —
the same question, answered continuously by real use instead of once by hand.

**Phase 1 — server only. Built.** Schema (including `device_kcal`,
`calorie_basis`, the setting and the log), `requireDevice`, `/api/health/sync`
with the cascade, pairing routes. (Settings UI — the "Connected devices" and
"What the watch sent" panels — is not built; it's frontend work with nothing
to verify against without a running dev server in this environment.) Fully
testable with curl and synthetic payloads against a throwaway DB — including
the case where `active_kcal` is missing,
which is the case a real phone might not have shown you anyway. ~1½ days.

**Phase 2 — the shell.** Capacitor project, WebView at the server URL,
`/auth/device` bootstrap, deep link. Ship the APK and use it as the daily
driver. No health data yet — this proves the shell and the auth independently
of Health Connect. ~1 day.

**Phase 3 — Health Connect read + sync on resume.** The first real data, and
**this is where the question actually gets answered** — from the sync log,
during ordinary use, on the phone the app is already installed on. One to two
days; the uncertain phase, being the first Kotlin plugin and the first Android
toolchain.

**Phase 4 — background sync**, changes-token incremental reads, deletions.
~1 day.

**Phase 5 — polish.** Steps as biometrics, the Fitness card glyph, the
activity-level warning, version nag. ~½ day.

### What deferring costs, honestly

Two things, and neither is fatal:

- **You can't tell whether the numbers are *sane* until real data flows.**
  Deferring moves the discovery point from a spike to Phase 3; it does not
  remove it. The cascade guarantees a number, not a *good* number.
- **If Samsung writes no exercise sessions at all** — and users do report
  exactly that after some Samsung Health updates — there is nothing to import
  and no cascade step saves you. The sync log surfaces that on day one of
  Phase 3, before Phases 4 and 5 are built on top of it, so the exposure is one
  phase rather than the whole plan. That is the bound; there isn't a way to
  make it zero without picking up the phone.

Set against that: the cascade and the log are perhaps half a day of work, they
delete a blocking half-day of phone fiddling, and they keep paying out every
time Samsung changes something. Roughly a wash on effort, clearly better on
sequencing, and strictly better once the thing is in production.

## 9. Tests

Unit (`vitest`, no server — where the invariants live):

- HC type → exercise mapping, including the unmapped fallback.
- **Idempotency: the same payload twice produces one row.** The single most
  valuable test here.
- An updated session (same `external_id`, new calories) updates rather than
  duplicates.
- Timezone: a 23:30 session in `America/Vancouver` lands on the right `date`.
- `deleted[]` cannot remove a `source = 'manual'` row.
- A deleted row in `health_ignored` is not re-imported.
- Token hashing, revocation, an unknown token → 401.
- Daily steps upsert twice → one biometric entry.
- **The cascade, all three steps:** a session with `active_kcal` →
  `basis = 'device'`; one without, but with window samples → `'device_window'`;
  one with neither → `'estimated'`, matching `MET x kg x hours`.
- Flipping `workout_calorie_source` recomputes device rows from `device_kcal`
  and **leaves `source = 'manual'` rows untouched** — then flipping back
  restores the original figures exactly, since `device_kcal` was never
  overwritten.
- A payload that throws still leaves a `health_sync_log` row.

e2e (`scripts/e2e.mjs`): pair → claim → sync → the workout appears on the diary
day → revoke → sync 401s.

Per AGENTS.md: break each of these on purpose once to confirm it notices.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| **Double-counting calories** (§2) | Sessions only; steps to biometrics; warn on activity level |
| Samsung's per-session calories are incomplete or absent | The three-step cascade (§2.1); `calorie_basis` says which step fired |
| Samsung Health silently stops syncing after an update — reported in the wild | `health_sync_log` and the Settings panel surface it; a one-off spike would not have |
| Samsung's estimate turns out to be too generous | `workout_calorie_source` flips to MET math and recomputes history from `device_kcal` |
| Google OAuth blocked in WebView | Device pairing (§3) — designed around it, not into it |
| One UI kills background work | Sync on resume is the primary trigger; battery-optimisation opt-out in onboarding |
| HC hides data older than 30 days | Request the history permission during onboarding |
| Device token is session-equivalent | Hashed, shown once, revocable; can't reach the API without becoming a session |
| Sideloaded APK goes stale | Version-check nag on launch |
| Trends steps when sync starts | Expected; the card glyph makes it attributable |

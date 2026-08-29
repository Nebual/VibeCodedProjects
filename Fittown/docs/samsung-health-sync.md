# Samsung watch sync — the plan

How Samsung Health / Galaxy Watch data (chiefly its estimated calories burned)
gets into Fittown, and why the design is shaped the way it is.

Status: **Phase 1 (server) built and tested.** **Phase 2 (the shell)
scaffolded and compiles** — see `mobile/` — but is unverified beyond that: no
emulator or physical phone was available to actually run it. Phases 3–5
(Health Connect, background sync, UI polish) are still just this plan.

- Phase 1: schema, device pairing, `/api/health/sync` with the calorie
  cascade, `health_sync_log`, the reversible `workout_calorie_source`
  setting. `server/utils/healthSync.ts`, `server/utils/deviceAuth.ts`,
  `test/health-sync-db.test.ts`, `test/device-auth-db.test.ts`.
- Phase 2: a Capacitor Android project (`mobile/`) with the `fittown://pair`
  deep link, a Kotlin plugin storing the device token in
  EncryptedSharedPreferences (`DeviceTokenPlugin.kt`), and a client plugin
  (`app/plugins/device-auth.client.ts`) that trades it for a session at
  `/auth/device` on launch. `./gradlew assembleDebug` succeeds and the
  resulting APK was inspected (`aapt`, `dexdump`) to confirm both actually
  landed in the build — that's the limit of what could be checked without a
  device. See `mobile/README-sandbox-build.md` for what that setup took and
  what's still unverified.

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

The chosen flow avoids Google entirely on the phone:

1. The user signs in to Fittown **in their phone's real browser**, where
   Google OAuth works as it does today.
2. Settings → *Connect a phone* → `POST /api/devices/pair-code` returns a
   short code (8 chars, 10-minute TTL) and a `fittown://pair?code=…` deep link.
3. The app receives the code (typed, or via the deep link if they tap it on
   the same phone) and calls `POST /api/devices/claim { code, name }`.
4. The server mints 32 random bytes, returns them **once**, and stores only a
   SHA-256 hash. The app puts the token in EncryptedSharedPreferences.

That one token then serves two consumers:

- **The native sync worker**, which runs outside the WebView and has no
  cookies: `Authorization: Bearer <token>` on `POST /api/health/sync`.
- **The WebView's session.** On launch, a Capacitor-only Nuxt client plugin
  asks the native layer for the token and `POST`s it to a new `/auth/device`
  route, which verifies it and calls `setUserSession()` — exactly the shape
  `server/routes/auth/dev.post.ts` already has. The cookie lands in the
  WebView's jar and everything downstream is unchanged. The token never
  appears in a URL.

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

*Alternative considered:* RFC 8252 native OAuth — Chrome Custom Tab for the
Google flow, callback into a `fittown://` deep link with a one-time code. More
standard, and it removes the "sign in on the browser first" step. It is also
more moving parts and a second Google OAuth client. Worth doing if onboarding
ever needs to work without a browser; not worth it for three people.

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

1. **Health Connect reader** (Kotlin, `androidx.health.connect.client`).
   Evaluate the community `capacitor-health-connect` plugin first; write a
   minimal custom plugin if it doesn't expose `ExerciseSessionRecord` with
   per-session calories and the changes API. Handle the permission grant flow,
   including `PERMISSION_READ_HEALTH_DATA_HISTORY` if reading further back
   than 30 days.
2. **Sync on resume** — the reliability backstop. `MainActivity.onResume()` (or
   Capacitor's `appStateChange` → active) enqueues a `OneTimeWorkRequest` with
   `ExistingWorkPolicy.KEEP`, debounced to skip if the last sync was under
   ~15 minutes ago. Opening the app once a day is what makes sync dependable,
   because —
3. **Periodic background sync** — `PeriodicWorkRequest`, network-constrained,
   ~4–6 hours (the 15-minute floor is far more often than calories change).
   **Samsung's One UI is aggressive about killing background work**, so this is
   best-effort by nature, and onboarding should walk the user through
   exempting Fittown from battery optimisation. Both triggers call the same
   `syncHealthData()`.
4. **Token storage** — EncryptedSharedPreferences, exposed to the WebView
   through a tiny plugin method for the `/auth/device` bootstrap.

Sideloaded APKs do not auto-update. A `GET /api/app-version` the app checks on
launch, nagging when the server is newer than the installed build, costs
almost nothing and prevents a stale phone silently desyncing.

## 7. UI changes

- **Fitness card** (`app/components/FitnessSection.vue`): a watch glyph on
  `source = 'health_connect'` rows, so a number that came from Samsung is never
  mistaken for a MET estimate. `WorkoutRow` gains `source`.
- **Deleting a device row** writes to `health_ignored` (§4) so it stays gone.
- **Settings → Connected devices:** list, pair, revoke, last-sync time, and a
  **"What the watch sent"** panel reading `health_sync_log` — the last few
  syncs, their session counts, and the `calorie_basis` tally. This is the spike
  made permanent, and it is the first thing to look at when the numbers go odd.
- **Settings → calorie source:** a two-way choice, "Use my watch's estimate" vs
  "Estimate from activity and body weight" (§2.1), with a line saying it
  recalculates past device-logged workouts and leaves hand-logged ones alone.
- **Calorie target dialog:** when a device is connected and `activity_level` is
  above `sedentary`, say plainly that training is being counted twice.
- `InstallPrompt.vue` needs **no change** — worth knowing rather than
  discovering. Its `variant` computed returns `null` unless
  `beforeinstallprompt` fired (it doesn't in a WebView) or the UA is iOS or
  Firefox-Android, so the "add to home screen" banner already stays down
  inside the app. Confirm on the real device rather than trusting this.

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

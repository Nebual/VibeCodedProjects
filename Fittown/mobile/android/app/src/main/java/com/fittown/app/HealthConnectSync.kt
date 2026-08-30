package com.fittown.app

import android.content.Context
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * Reads Health Connect data and syncs it to POST /api/health/sync
 * (docs/samsung-health-sync.md §5). A plain Kotlin object, not a Capacitor
 * plugin: nothing here needs the WebView or a user gesture, which is why
 * both `MainActivity.onResume()` and `HealthSyncWorker` (WorkManager) can
 * call `syncNow()` directly.
 *
 * Reads are incremental after the first one: a Health Connect changes token
 * is stored and resumed from on every sync after the first, so a repeat sync
 * only sees what actually changed — new sessions, edits, and deletions —
 * rather than re-reading the whole lookback window every time. Deletions in
 * particular only exist because of this: without a changes token there is no
 * way to know a session disappeared, only that it's absent from *this* read.
 *

 * `ExerciseSessionRecord` carries no calories of its own — confirmed against
 * Health Connect's own API surface, not assumed. Every session's figure here
 * comes from aggregating `ActiveCaloriesBurnedRecord` over the session's own
 * time window, which is the cascade's "device_window" step
 * (server/utils/healthSync.ts) — the "device" step (a figure the session
 * carries directly) is consequently one this app can never produce; it exists
 * in the wire contract for whichever future Health Connect surface does
 * carry per-session calories directly. When the aggregate itself comes back
 * empty — which Samsung Health is reported to do intermittently — this sends
 * no `active_kcal` at all, and the server's own cascade falls back to its MET
 * estimate. That fallback is not a bug to route around here.
 */
object HealthConnectSync {
    private const val TAG = "FittownHealthSync"
    private const val PROVIDER_PACKAGE = "com.google.android.apps.healthdata"
    private const val LOOKBACK_DAYS = 7L
    private const val MIN_INTERVAL_MINUTES = 15L
    private const val PREFS_FILE = "fittown_sync_state"
    private const val KEY_LAST_SYNC = "last_sync_millis"
    private const val KEY_CHANGES_TOKEN = "changes_token"

    private val ISO_OFFSET = DateTimeFormatter.ISO_OFFSET_DATE_TIME

    val PERMISSIONS: Set<String> = setOf(
        HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
    )

    // Only exercise sessions are tracked for change/deletion purposes —
    // steps and active calories are daily aggregates recomputed fresh every
    // sync, never stored as rows a deletion could target.
    private val TRACKED_RECORD_TYPES = setOf(ExerciseSessionRecord::class)

    fun isAvailable(context: Context): Boolean =
        HealthConnectClient.getSdkStatus(context, PROVIDER_PACKAGE) == HealthConnectClient.SDK_AVAILABLE

    private fun client(context: Context) = HealthConnectClient.getOrCreate(context)

    suspend fun hasPermissions(context: Context): Boolean {
        val granted = client(context).permissionController.getGrantedPermissions()
        return granted.containsAll(PERMISSIONS)
    }

    /**
     * Fire-and-forget entry point for MainActivity.onResume(): debounces
     * internally (so a resume seconds after the last one is a free no-op),
     * swallows and logs every error rather than crashing the caller, and does
     * all of its own I/O off the calling thread.
     */
    fun syncInBackground(context: Context) {
        val appContext = context.applicationContext
        CoroutineScope(Dispatchers.IO).launch {
            try {
                if (!shouldSyncNow(appContext)) return@launch
                if (syncNow(appContext)) markSynced(appContext)
            } catch (e: Exception) {
                // Never let a sync failure surface as a crash — there is no
                // UI here to show it to, and the next resume tries again.
                Log.e(TAG, "sync failed", e)
            }
        }
    }

    /**
     * The suspend entry point HealthSyncWorker (WorkManager) awaits directly,
     * so it can tell a real failure (worth retrying) from "nothing to sync
     * yet" (not). No debounce here — the worker's own ~6-hour schedule is
     * the pacing; a resume seconds later still benefits from
     * syncInBackground()'s debounce on top.
     */
    suspend fun syncNow(context: Context): Boolean {
        if (!isAvailable(context) || !hasPermissions(context)) return false
        val token = DeviceTokenStore.getToken(context) ?: return false
        val serverUrl = readServerUrl(context) ?: return false
        return sync(context, serverUrl, token)
    }

    private fun shouldSyncNow(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        val last = prefs.getLong(KEY_LAST_SYNC, 0L)
        val minGapMillis = MIN_INTERVAL_MINUTES * 60_000L
        return System.currentTimeMillis() - last >= minGapMillis
    }

    private fun markSynced(context: Context) {
        context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
            .edit().putLong(KEY_LAST_SYNC, System.currentTimeMillis()).apply()
    }

    /** capacitor.config.json's server.url, read straight from the built assets. */
    private fun readServerUrl(context: Context): String? = try {
        val text = context.assets.open("capacitor.config.json").bufferedReader().use { it.readText() }
        JSONObject(text).optJSONObject("server")?.optString("url")?.takeIf { it.isNotEmpty() }
    } catch (e: Exception) {
        Log.e(TAG, "could not read capacitor.config.json", e)
        null
    }

    /** What one read (full or incremental) found: sessions to upsert, ids to delete, and the token to store for next time. */
    private class SyncBatch(
        val sessions: List<ExerciseSessionRecord>,
        val deletedIds: List<String>,
        val nextToken: String,
    )

    private suspend fun sync(context: Context, serverUrl: String, token: String): Boolean {
        val hc = client(context)
        val prefs = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        val storedToken = prefs.getString(KEY_CHANGES_TOKEN, null)

        // storedToken != null but readIncremental() returns null: Health
        // Connect's own signal that the token is too old to resume from
        // (changesTokenExpired) — same fallback as having no token at all.
        val batch = storedToken?.let { readIncremental(hc, it) } ?: readFull(hc)

        val sessionsJson = JSONArray()
        for (session in batch.sessions) sessionsJson.put(sessionToJson(hc, session))
        val deletedJson = JSONArray(batch.deletedIds)

        val body = JSONObject()
        body.put("sessions", sessionsJson)
        body.put("deleted", deletedJson)
        body.put("daily", JSONArray().put(dailyToJson(hc, ZoneId.systemDefault())))

        val ok = postSync(serverUrl, token, body)
        // Only advance the token once the server has actually accepted this
        // batch — a failed POST should re-read (and re-send) the same
        // changes next time, not silently drop them.
        if (ok) prefs.edit().putString(KEY_CHANGES_TOKEN, batch.nextToken).apply()
        return ok
    }

    /** First sync, or the stored token expired: read the lookback window directly and mint a fresh token to resume from next time. */
    private suspend fun readFull(hc: HealthConnectClient): SyncBatch {
        val now = Instant.now()
        val since = now.minus(LOOKBACK_DAYS, ChronoUnit.DAYS)
        val sessions = hc.readRecords(
            ReadRecordsRequest(ExerciseSessionRecord::class, TimeRangeFilter.between(since, now)),
        ).records
        val nextToken = hc.getChangesToken(ChangesTokenRequest(TRACKED_RECORD_TYPES))
        return SyncBatch(sessions, emptyList(), nextToken)
    }

    /** Everything that changed since `changesToken`, paginating until Health Connect says there's no more. Null means the token expired — the caller falls back to readFull(). */
    private suspend fun readIncremental(hc: HealthConnectClient, changesToken: String): SyncBatch? {
        val sessions = mutableListOf<ExerciseSessionRecord>()
        val deletedIds = mutableListOf<String>()
        var token = changesToken

        while (true) {
            val response = hc.getChanges(token)
            if (response.changesTokenExpired) return null

            for (change in response.changes) {
                when (change) {
                    is UpsertionChange -> (change.record as? ExerciseSessionRecord)?.let { sessions.add(it) }
                    is DeletionChange -> deletedIds.add(change.recordId)
                }
            }

            token = response.nextChangesToken
            if (!response.hasMore) break
        }

        return SyncBatch(sessions, deletedIds, token)
    }

    private suspend fun sessionToJson(hc: HealthConnectClient, session: ExerciseSessionRecord): JSONObject {
        val json = JSONObject()
        json.put("external_id", session.metadata.id)
        json.put("type", exerciseTypeToWireString(session.exerciseType))
        json.put("start", ISO_OFFSET.format(session.startTime.atZone(session.startZoneOffset ?: ZoneId.systemDefault())))
        json.put("end", ISO_OFFSET.format(session.endTime.atZone(session.endZoneOffset ?: ZoneId.systemDefault())))

        val kcal = activeCaloriesBetween(hc, session.startTime, session.endTime)
        if (kcal != null) {
            json.put("active_kcal", kcal)
            // The only figure this app can ever produce — see the class
            // comment on why "device" (a session's own figure) never appears
            // here.
            json.put("active_kcal_basis", "device_window")
        } else {
            json.put("active_kcal", JSONObject.NULL)
        }
        json.put("distance_km", JSONObject.NULL) // not requested — see AndroidManifest.xml
        json.put("avg_heart_rate", JSONObject.NULL)
        return json
    }

    private suspend fun activeCaloriesBetween(hc: HealthConnectClient, start: Instant, end: Instant): Double? = try {
        val response = hc.aggregate(
            AggregateRequest(setOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL), TimeRangeFilter.between(start, end)),
        )
        response[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories
    } catch (e: Exception) {
        // Confirmed to happen in practice — Samsung Health is reported to
        // return nothing here even with valid data and correct permissions.
        // Not an error worth failing the whole sync over.
        Log.w(TAG, "active-calories aggregate failed", e)
        null
    }

    private suspend fun dailyToJson(hc: HealthConnectClient, zone: ZoneId): JSONObject {
        val startOfDay = LocalDate.now(zone).atStartOfDay(zone).toInstant()
        val now = Instant.now()
        val range = TimeRangeFilter.between(startOfDay, now)

        val steps = try {
            hc.aggregate(AggregateRequest(setOf(StepsRecord.COUNT_TOTAL), range))[StepsRecord.COUNT_TOTAL]
        } catch (e: Exception) {
            Log.w(TAG, "steps aggregate failed", e)
            null
        }
        val kcal = try {
            hc.aggregate(AggregateRequest(setOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL), range))[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories
        } catch (e: Exception) {
            Log.w(TAG, "daily active-calories aggregate failed", e)
            null
        }

        val json = JSONObject()
        json.put("date", DateTimeFormatter.ISO_LOCAL_DATE.format(LocalDate.now(zone)))
        json.put("steps", steps ?: JSONObject.NULL)
        json.put("active_kcal", kcal ?: JSONObject.NULL)
        return json
    }

    private fun postSync(serverUrl: String, token: String, body: JSONObject): Boolean {
        val connection = URL("$serverUrl/api/health/sync").openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.connectTimeout = 15_000
            connection.readTimeout = 15_000
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

            val code = connection.responseCode
            Log.i(TAG, "sync -> HTTP $code")
            code in 200..299
        } catch (e: Exception) {
            Log.e(TAG, "sync request failed", e)
            false
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Health Connect's ExerciseType constants -> the wire strings
     * shared/healthConnect.ts maps onto Fittown's exercise library. Not
     * exhaustive by design (see that file's own comment) — anything not
     * listed here resolves server-side to "Tracked workout" rather than
     * being dropped, so an omission here is a worse activity match, never
     * lost data.
     */
    private fun exerciseTypeToWireString(type: Int): String = when (type) {
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "WALKING"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "HIKING"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING -> "RUNNING"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "RUNNING_TREADMILL"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING -> "BIKING"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "BIKING_STATIONARY"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL -> "SWIMMING_POOL"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> "SWIMMING_OPEN_WATER"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING -> "ROWING"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE -> "ROWING_MACHINE"
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL -> "ELLIPTICAL"
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING -> "STAIR_CLIMBING"
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING_MACHINE -> "STAIR_CLIMBING_MACHINE"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING -> "STRENGTH_TRAINING"
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS -> "CALISTHENICS"
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING -> "HIGH_INTENSITY_INTERVAL_TRAINING"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "YOGA"
        ExerciseSessionRecord.EXERCISE_TYPE_BOXING -> "BOXING"
        ExerciseSessionRecord.EXERCISE_TYPE_MARTIAL_ARTS -> "MARTIAL_ARTS"
        ExerciseSessionRecord.EXERCISE_TYPE_ROCK_CLIMBING -> "ROCK_CLIMBING"
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_SKATING -> "ICE_SKATING"
        ExerciseSessionRecord.EXERCISE_TYPE_BASKETBALL -> "BASKETBALL"
        ExerciseSessionRecord.EXERCISE_TYPE_SOCCER -> "SOCCER"
        ExerciseSessionRecord.EXERCISE_TYPE_TENNIS -> "TENNIS"
        ExerciseSessionRecord.EXERCISE_TYPE_BADMINTON -> "BADMINTON"
        ExerciseSessionRecord.EXERCISE_TYPE_SQUASH -> "SQUASH"
        ExerciseSessionRecord.EXERCISE_TYPE_TABLE_TENNIS -> "TABLE_TENNIS"
        ExerciseSessionRecord.EXERCISE_TYPE_VOLLEYBALL -> "VOLLEYBALL"
        ExerciseSessionRecord.EXERCISE_TYPE_GOLF -> "GOLF"
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_HOCKEY -> "ICE_HOCKEY"
        ExerciseSessionRecord.EXERCISE_TYPE_FOOTBALL_AMERICAN -> "FOOTBALL_AMERICAN"
        ExerciseSessionRecord.EXERCISE_TYPE_RUGBY -> "RUGBY"
        else -> "OTHER" // resolves to Fittown's "Tracked workout" fallback
    }
}

package com.fittown.app

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * The periodic background half of sync (docs/samsung-health-sync.md §6):
 * `MainActivity.onResume()` is the primary trigger and works even if this
 * never fires — WorkManager and Samsung's One UI are known to disagree about
 * whether background work gets to run at all — but between opens, this is
 * what keeps data from going stale for hours.
 *
 * Calls `HealthConnectSync.syncNow()` directly rather than `syncInBackground()`
 * — a `CoroutineWorker` needs an awaited, honest `Result` (retry vs. done) to
 * report back to WorkManager, not a fire-and-forget launch.
 *
 * "Not paired yet" / "permission not granted" / "Health Connect unavailable"
 * are not failures — there's no Activity here to pair the app or request a
 * permission from, so retrying changes nothing until the user opens the app
 * again. Only an actual sync attempt that failed (e.g. the POST itself)
 * is worth WorkManager's retry/backoff.
 */
class HealthSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        if (DeviceTokenStore.getToken(applicationContext) == null) return Result.success()
        if (!HealthConnectSync.isAvailable(applicationContext)) return Result.success()
        if (!HealthConnectSync.hasPermissions(applicationContext)) return Result.success()

        return try {
            if (HealthConnectSync.syncNow(applicationContext)) Result.success() else Result.retry()
        } catch (e: Exception) {
            Log.e("FittownHealthSync", "background sync worker failed", e)
            Result.retry()
        }
    }
}

package com.fittown.app

import android.os.Bundle
import androidx.health.connect.client.PermissionController
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.getcapacitor.BridgeActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

class MainActivity : BridgeActivity() {
    // Tied to the Activity, not the process — HealthConnectSync.syncInBackground()
    // uses its own short-lived scope for the actual sync, so cancelling this
    // on destroy only ever interrupts an in-flight permission/availability
    // check, never a sync already underway.
    private val activityScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    // Must be registered before the activity reaches STARTED — a class-level
    // property, not something created lazily in onResume().
    private val healthConnectPermissionLauncher =
        registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
            if (granted.containsAll(HealthConnectSync.PERMISSIONS)) {
                HealthConnectSync.syncInBackground(this)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Must be registered before super.onCreate() — that's where Capacitor
        // builds the bridge and hands plugins to the WebView. That same call
        // is also where Capacitor applies its own edge-to-edge margins
        // (CapacitorWebView.edgeToEdgeHandler(), enabled via
        // capacitor.config.ts's android.adjustMarginsForEdgeToEdge) — nothing
        // to do here for that any more. A hand-rolled version of this using
        // View.setPadding() lived here through Phase 5; it didn't just fail
        // to clear the nav bar, it broke SPA navigation, rendering a fresh
        // route's content *below* the previous page's rather than replacing
        // it — padding insets a WebView's drawing area without changing its
        // measured size, and Chromium's viewport math doesn't reliably
        // recompute across a client-side route change when only that
        // changes. Margins (real LayoutParams, measured before Chromium ever
        // renders) don't have that problem, which is why this now defers to
        // Capacitor's own handling instead of re-implementing it.
        registerPlugin(DeviceTokenPlugin::class.java)
        super.onCreate(savedInstanceState)
    }

    // The primary sync trigger (docs/samsung-health-sync.md §6): every time
    // the app comes to the foreground, request Health Connect access if it's
    // missing, or sync if it's already granted. HealthConnectSync debounces
    // internally, so a resume seconds after the last one is a cheap no-op,
    // not a wasted request. Also (re-)schedules the periodic background
    // worker — cheap and idempotent, and the natural place to do it: onResume
    // already knows the app is paired by the time it matters.
    override fun onResume() {
        super.onResume()

        val paired = DeviceTokenStore.getToken(this) != null
        if (!paired || !HealthConnectSync.isAvailable(this)) return

        schedulePeriodicSync()

        activityScope.launch {
            if (HealthConnectSync.hasPermissions(this@MainActivity)) {
                HealthConnectSync.syncInBackground(this@MainActivity)
            } else {
                healthConnectPermissionLauncher.launch(HealthConnectSync.PERMISSIONS)
            }
        }
    }

    /**
     * Every ~6 hours while the app has network, on top of onResume() —
     * Samsung's One UI is known to be aggressive about killing background
     * work regardless, so this is a backstop, not the primary path.
     * `ExistingPeriodicWorkPolicy.KEEP` makes re-calling this on every resume
     * a no-op once the schedule already exists, rather than resetting the
     * timer each time.
     */
    private fun schedulePeriodicSync() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val request = PeriodicWorkRequestBuilder<HealthSyncWorker>(6, TimeUnit.HOURS)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "fittown-health-sync",
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    override fun onDestroy() {
        activityScope.cancel()
        super.onDestroy()
    }
}

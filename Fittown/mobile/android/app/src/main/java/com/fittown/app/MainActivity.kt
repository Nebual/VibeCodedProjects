package com.fittown.app

import android.os.Bundle
import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
        // builds the bridge and hands plugins to the WebView.
        registerPlugin(DeviceTokenPlugin::class.java)
        super.onCreate(savedInstanceState)

        // Android 15 (this app's targetSdk) draws edge-to-edge by default, and
        // apps targeting it can no longer opt back out the way older Android
        // let you — so rather than fight the platform, pad the WebView by
        // exactly the system bars' height instead. Without this the page
        // content starts underneath the status bar (and, on gesture-nav
        // devices, the bottom bar too).
        val webView = bridge.webView
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view: View, insets: WindowInsetsCompat ->
            val systemBars: Insets = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }
        // The listener above only fires on the *next* insets dispatch — by
        // this point in onCreate(), Capacitor has already created and
        // attached the WebView, so the one dispatch that happens as part of
        // that initial attach has almost certainly already passed with
        // nothing listening. Nothing then ever asks the system for another
        // one, so the listener sits there and never runs. This is what
        // actually asks for it: immediately if the view is already attached
        // (the common case here), or the moment it becomes attached if not.
        if (webView.isAttachedToWindow) {
            ViewCompat.requestApplyInsets(webView)
        } else {
            webView.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(v: View) {
                    ViewCompat.requestApplyInsets(v)
                    v.removeOnAttachStateChangeListener(this)
                }
                override fun onViewDetachedFromWindow(v: View) {}
            })
        }
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

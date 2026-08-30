package com.fittown.app

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

/**
 * Health Connect requires an activity answering ACTION_SHOW_PERMISSIONS_RATIONALE
 * (Android 13-) and, via the alias in AndroidManifest.xml, VIEW_PERMISSION_USAGE
 * (Android 14+) — without one, the permission request itself doesn't work. This
 * is that screen: a plain explanation, built programmatically rather than with
 * an XML layout since it's the only thing this activity ever shows.
 * docs/samsung-health-sync.md §6.
 */
class HealthPermissionsRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val text = TextView(this).apply {
            text = "Fittown reads your exercise sessions, steps, and active calories " +
                "from Health Connect so they show up in your diary automatically. " +
                "This data stays on your Fittown server — the same one your account " +
                "already signs in to — and is never sent anywhere else."
            textSize = 16f
            setPadding(48, 96, 48, 48)
            setTextColor(Color.BLACK)
        }

        setContentView(ScrollView(this).apply { addView(text) })
    }
}

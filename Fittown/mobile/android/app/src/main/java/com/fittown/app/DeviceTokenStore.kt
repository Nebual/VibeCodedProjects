package com.fittown.app

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * The device token from POST /api/devices/claim (docs/samsung-health-sync.md
 * §3), in EncryptedSharedPreferences rather than plain SharedPreferences —
 * it's session-equivalent once traded in at /auth/device, so it gets the
 * same protection a password would.
 *
 * Two native consumers read it, hence a plain `Context`-based object rather
 * than living inside DeviceTokenPlugin.kt: the WebView bootstrap (via that
 * Capacitor plugin, POSTing to /auth/device to open a session — no Google
 * OAuth inside a WebView) and HealthConnectSync.kt's background sync, which
 * has no WebView, no cookies, and no Capacitor `Plugin` context to inherit
 * this from — it calls POST /api/health/sync with the raw token directly.
 */
object DeviceTokenStore {
    private const val PREFS_FILE = "fittown_device_token"
    private const val KEY_TOKEN = "token"

    private fun prefs(context: Context) = EncryptedSharedPreferences.create(
        context,
        PREFS_FILE,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun getToken(context: Context): String? = prefs(context).getString(KEY_TOKEN, null)

    fun setToken(context: Context, token: String) {
        prefs(context).edit().putString(KEY_TOKEN, token).apply()
    }

    fun clearToken(context: Context) {
        prefs(context).edit().remove(KEY_TOKEN).apply()
    }
}

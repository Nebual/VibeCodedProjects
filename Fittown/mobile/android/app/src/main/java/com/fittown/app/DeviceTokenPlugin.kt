package com.fittown.app

import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Stores the device token from POST /api/devices/claim
 * (docs/samsung-health-sync.md §3) in EncryptedSharedPreferences rather than
 * plain SharedPreferences — it's session-equivalent once traded in at
 * /auth/device, so it gets the same protection a password would.
 *
 * Two native consumers read it: the WebView bootstrap on launch (POSTs it to
 * /auth/device to open a session — no Google OAuth inside a WebView) and the
 * background sync worker (Phase 3/4 — WorkManager has no WebView and no
 * cookies, so it calls POST /api/health/sync with the raw token directly).
 * Nothing about it is exposed through Capacitor's own storage APIs, which
 * are unencrypted.
 */
@CapacitorPlugin(name = "DeviceToken")
class DeviceTokenPlugin : Plugin() {
    companion object {
        private const val PREFS_FILE = "fittown_device_token"
        private const val KEY_TOKEN = "token"
    }

    private fun prefs() = EncryptedSharedPreferences.create(
        context,
        PREFS_FILE,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    @PluginMethod
    fun getToken(call: PluginCall) {
        val result = JSObject()
        result.put("token", prefs().getString(KEY_TOKEN, null))
        call.resolve(result)
    }

    @PluginMethod
    fun setToken(call: PluginCall) {
        val token = call.getString("token")
        if (token.isNullOrEmpty()) {
            call.reject("token is required")
            return
        }
        prefs().edit().putString(KEY_TOKEN, token).apply()
        call.resolve()
    }

    @PluginMethod
    fun clearToken(call: PluginCall) {
        prefs().edit().remove(KEY_TOKEN).apply()
        call.resolve()
    }
}

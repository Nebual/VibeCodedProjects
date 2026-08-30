package com.fittown.app

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The WebView-facing side of DeviceTokenStore.kt, which does the actual
 * EncryptedSharedPreferences work — shared with HealthConnectSync.kt's
 * background sync, which has no WebView to expose a Capacitor plugin to.
 * docs/samsung-health-sync.md §3.
 */
@CapacitorPlugin(name = "DeviceToken")
class DeviceTokenPlugin : Plugin() {
    @PluginMethod
    fun getToken(call: PluginCall) {
        val result = JSObject()
        result.put("token", DeviceTokenStore.getToken(context))
        call.resolve(result)
    }

    @PluginMethod
    fun setToken(call: PluginCall) {
        val token = call.getString("token")
        if (token.isNullOrEmpty()) {
            call.reject("token is required")
            return
        }
        DeviceTokenStore.setToken(context, token)
        call.resolve()
    }

    @PluginMethod
    fun clearToken(call: PluginCall) {
        DeviceTokenStore.clearToken(context)
        call.resolve()
    }
}

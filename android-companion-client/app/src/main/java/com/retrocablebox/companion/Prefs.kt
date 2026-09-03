package com.retrocablebox.companion

import android.content.Context

/**
 * Persists which desktop host to talk to (IP + companion-app port) across
 * launches — set manually on the CONNECT tab (see MainActivity.saveHost).
 * Mirrors android-remote-client's Prefs.kt.
 */
class Prefs(context: Context) {
    private val prefs = context.getSharedPreferences("companion_prefs", Context.MODE_PRIVATE)

    var host: String?
        get() = prefs.getString("host", null)
        set(value) = prefs.edit().putString("host", value).apply()

    var port: Int
        get() = prefs.getInt("port", 8725)
        set(value) = prefs.edit().putInt("port", value).apply()

    var hostName: String?
        get() = prefs.getString("hostName", null)
        set(value) = prefs.edit().putString("hostName", value).apply()

    // Bearer session token from the host's pairing flow (main-lan-security.js).
    // Cleared whenever the host rejects it (401) so the user is re-prompted.
    // The host persists accepted sessions for 90 days, so ordinary desktop
    // restarts do not make a paired phone reconnect from scratch.
    var token: String?
        get() = prefs.getString("token", null)
        set(value) = prefs.edit().putString("token", value).apply()

    fun baseUrl(): String? {
        val h = host ?: return null
        return "http://$h:$port"
    }
}

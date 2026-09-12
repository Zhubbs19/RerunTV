package com.retrocablebox.companion

import android.content.Context

/**
 * Persists which desktop host to talk to (IP + companion-app port) across
 * launches — set from the connect bar, or filled in by LAN discovery.
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

    // No token field here any more. Pairing is a session COOKIE held by the
    // WebView (main-lan-security.js issues it, MainActivity flushes it on
    // pause), not a bearer token this shell manages — the token property and
    // the native ApiClient that read it went away together when the UI moved
    // to the served page.

    fun baseUrl(): String? {
        val h = host ?: return null
        return "http://$h:$port"
    }
}

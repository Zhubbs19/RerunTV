package com.retrocablebox.companion

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Talks to the desktop app's companion-app plugin (plugins/companion-app/
 * main.js, port 8725 by default) — remote control, settings editing, and
 * channel-folder file browsing/download, all one plugin/port (formerly two
 * separate plugins/apps — android-remote-client's own ApiClient.kt, now
 * folded in here so one pairing covers everything). Plain
 * HttpURLConnection, no library.
 *
 * Every request needs an Authorization: Bearer session token now that
 * main-lan-security.js gates the server behind pairing — see pair() below,
 * which exchanges the host-displayed pairing code for that token.
 */
class ApiClient(private val prefs: Prefs) {

    class ApiException(message: String) : Exception(message)
    class NotPairedException : Exception("Not paired with the box yet")

    private fun base(): String = prefs.baseUrl() ?: throw ApiException("No host configured")

    // Exchanges the pairing code shown on the desktop app's PLUGINS tab
    // (Companion App settings) for a session token, per
    // main-lan-security.js's handlePairing(): GET /?pair=CODE with
    // Accept: application/json returns {token, expiresIn} instead of the
    // HTML pairing page it serves to a browser.
    suspend fun pair(code: String) {
        withContext(Dispatchers.IO) {
            val url = URL(base() + "/?pair=" + URLEncoder.encode(code, "UTF-8"))
            val conn = url.openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "GET"
                conn.connectTimeout = 4000
                conn.readTimeout = 4000
                conn.setRequestProperty("Accept", "application/json")
                val responseCode = conn.responseCode
                val stream = if (responseCode >= 400) conn.errorStream else conn.inputStream
                val text = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() } ?: ""
                if (responseCode >= 400) throw ApiException("That pairing code was not accepted.")
                val token = JSONObject(text).optString("token", "")
                if (token.isEmpty()) throw ApiException("Host didn't return a session token.")
                prefs.token = token
            } finally {
                conn.disconnect()
            }
        }
    }

    private fun openAuthed(path: String, method: String): HttpURLConnection {
        val url = URL(base() + path)
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 4000
        conn.readTimeout = 15000
        val token = prefs.token
        if (!token.isNullOrEmpty()) conn.setRequestProperty("Authorization", "Bearer $token")
        return conn
    }

    private suspend fun request(path: String, method: String, body: JSONObject? = null): String {
        return withContext(Dispatchers.IO) {
            val conn = openAuthed(path, method)
            try {
                if (body != null) {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
                }
                val code = conn.responseCode
                if (code == 401) {
                    prefs.token = null
                    throw NotPairedException()
                }
                if (code >= 400) throw ApiException("HTTP $code")
                conn.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
            } finally {
                conn.disconnect()
            }
        }
    }

    // ---------------- Remote control (REMOTE + CHANNELS tabs) ----------------

    // Relays one button press exactly as the phone-web remote does — see
    // handleKey, renderer/js/app.js, for the full key map this feeds.
    suspend fun command(key: String, shift: Boolean = false, ctrl: Boolean = false, alt: Boolean = false) {
        request("/command", "POST", JSONObject()
            .put("key", key).put("shift", shift).put("ctrl", ctrl).put("alt", alt))
    }

    suspend fun tune(number: Int) {
        request("/tune", "POST", JSONObject().put("number", number))
    }

    // Fires the breaking-news plugin's interrupt, optionally with a custom
    // headline — see companion-app/main.js's POST /news/trigger.
    suspend fun triggerNews(headline: String? = null) {
        val body = JSONObject()
        if (!headline.isNullOrBlank()) body.put("headline", headline)
        request("/news/trigger", "POST", body)
    }

    // Sets the box-wide static ticker message live — see companion-app/
    // main.js's POST /ticker/set.
    suspend fun setTicker(text: String? = null, enabled: Boolean? = null) {
        val body = JSONObject()
        if (text != null) body.put("text", text)
        if (enabled != null) body.put("enabled", enabled)
        request("/ticker/set", "POST", body)
    }

    data class ThemeOption(val id: String, val label: String)

    // Installed theme-pack list for the SETTINGS tab's theme dropdown — see
    // companion-app/main.js's GET /api/themes. Can be empty (nothing
    // reported yet); callers should fall back to a text field in that case.
    suspend fun themes(): List<ThemeOption> {
        val text = request("/api/themes", "GET")
        val arr = if (text.isBlank()) JSONArray() else JSONArray(text)
        val out = ArrayList<ThemeOption>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            out.add(ThemeOption(o.optString("id"), o.optString("label", o.optString("id"))))
        }
        return out
    }

    // Host-side party control — mirrors the desktop setup screen's own
    // TRIGGER TRIVIA button (startTriviaRound, renderer/js/party.js).
    suspend fun triggerTrivia() {
        request("/party/trivia/start", "POST")
    }

    // Floats a reaction emoji over whatever's on screen right now (see
    // renderFloatingReaction, renderer/js/party.js).
    suspend fun reaction(emoji: String) {
        request("/reaction", "POST", JSONObject().put("emoji", emoji))
    }

    suspend fun state(): JSONObject {
        val text = request("/state", "GET")
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }

    data class ChannelInfo(val number: Int, val name: String, val favorite: Boolean, val quickAccess: Boolean)

    suspend fun channels(): List<ChannelInfo> {
        val text = request("/channels", "GET")
        val arr = if (text.isBlank()) JSONArray() else JSONArray(text)
        val out = ArrayList<ChannelInfo>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            out.add(ChannelInfo(
                number = o.optInt("number"),
                name = o.optString("name"),
                favorite = o.optBoolean("favorite"),
                quickAccess = o.optBoolean("quickAccess"),
            ))
        }
        return out
    }

    suspend fun setChannelFlag(number: Int, field: String, value: Boolean) {
        request("/channel/flag", "POST", JSONObject()
            .put("number", number).put("field", field).put("value", value))
    }

    // ---------------- Settings + Files ----------------

    // Full box config, for the SETTINGS tab's generic section editor.
    suspend fun getConfig(): JSONObject {
        val text = request("/api/config", "GET")
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }

    // patch is {sectionKey: {...arbitrarily nested values...}} — see
    // companion-app/main.js's POST /api/settings and app.js's
    // onCompanionApplySettings/deepMergeExistingKeys for what's actually
    // applied on the desktop side: a recursive merge that only ever
    // assigns onto a key that already exists in config, at any depth,
    // never a new section or key.
    suspend fun postSettings(patch: JSONObject) {
        request("/api/settings", "POST", JSONObject().put("patch", patch))
    }

    data class Root(val id: String, val label: String)

    suspend fun roots(): List<Root> {
        val text = request("/api/roots", "GET")
        val arr = if (text.isBlank()) JSONArray() else JSONArray(text)
        val out = ArrayList<Root>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            out.add(Root(o.optString("id"), o.optString("label")))
        }
        return out
    }

    data class FileEntry(val name: String, val isDir: Boolean, val size: Long, val mtime: Long)

    suspend fun listFiles(rootId: String, relPath: String): List<FileEntry> {
        val q = "root=" + URLEncoder.encode(rootId, "UTF-8") + "&path=" + URLEncoder.encode(relPath, "UTF-8")
        val text = request("/api/files?$q", "GET")
        val entries = if (text.isBlank()) JSONArray() else JSONObject(text).optJSONArray("entries") ?: JSONArray()
        val out = ArrayList<FileEntry>()
        for (i in 0 until entries.length()) {
            val o = entries.getJSONObject(i)
            out.add(FileEntry(
                name = o.optString("name"),
                isDir = o.optBoolean("isDir"),
                size = if (o.isNull("size")) -1L else o.optLong("size"),
                mtime = if (o.isNull("mtime")) 0L else o.optLong("mtime"),
            ))
        }
        return out
    }

    // Streams a file straight to disk (no whole-file buffering) so large
    // video files from a channel folder don't blow up phone memory — mirrors
    // the Range-aware GET /api/files/download the plugin serves, just
    // without ever needing to send a Range header ourselves for a plain
    // save-to-device download.
    suspend fun downloadFile(rootId: String, relPath: String, destFile: File) {
        withContext(Dispatchers.IO) {
            val q = "root=" + URLEncoder.encode(rootId, "UTF-8") + "&path=" + URLEncoder.encode(relPath, "UTF-8")
            val conn = openAuthed("/api/files/download?$q", "GET")
            try {
                val code = conn.responseCode
                if (code == 401) { prefs.token = null; throw NotPairedException() }
                if (code >= 400) throw ApiException("HTTP $code")
                conn.inputStream.use { input ->
                    FileOutputStream(destFile).use { output ->
                        input.copyTo(output)
                    }
                }
            } finally {
                conn.disconnect()
            }
        }
    }
}

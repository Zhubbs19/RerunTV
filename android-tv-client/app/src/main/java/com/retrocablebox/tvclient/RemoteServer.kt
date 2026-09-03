package com.retrocablebox.tvclient

import android.content.res.AssetManager
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets

/**
 * A minimal hand-rolled HTTP server letting a phone act as a physical
 * remote for THIS specific Android TV device — mirrors main.js's
 * startRemoteServer (the Electron host's own phone-remote feature) almost
 * exactly, just reimplemented here since a separate device has no access to
 * that process's IPC. Serves the exact same remote/ page files (copied
 * verbatim into assets/remote/) so the phone UI is byte-identical either
 * way — those files already fetch '/command' and '/state' as same-origin
 * relative paths, so nothing in them needed to change.
 *
 * Hand-rolled rather than using a library: Android's core library doesn't
 * include com.sun.net.httpserver (unlike a desktop JRE), and pulling in a
 * third-party embedded-server dependency felt like overkill for four tiny
 * routes. Deliberately minimal — assumes simple, well-formed requests from
 * a browser's fetch() (Content-Length-based, not chunked), always responds
 * Connection: close (no keep-alive/pipelining to handle), and a single
 * malformed request just gets its connection dropped rather than crashing
 * the server loop.
 */
class RemoteServer(
    private val assets: AssetManager,
    private val port: Int,
    private val onCommand: (key: String, shift: Boolean, action: String?) -> Unit,
    private val getState: () -> String,
) {
    private var serverSocket: ServerSocket? = null
    @Volatile private var running = false

    fun start() {
        if (running) return
        running = true
        Thread {
            try {
                val ss = ServerSocket(port)
                serverSocket = ss
                while (running) {
                    try {
                        val socket = ss.accept()
                        Thread { handleClient(socket) }.start()
                    } catch (e: Exception) {
                        // Accept loop error (e.g. socket closed on stop()) —
                        // exits the while on the next running check.
                    }
                }
            } catch (e: Exception) {
                // Port unavailable, etc. — the remote just won't be reachable.
            }
        }.start()
    }

    fun stop() {
        running = false
        try { serverSocket?.close() } catch (e: Exception) {}
    }

    private fun handleClient(socket: Socket) {
        try {
            socket.soTimeout = 5000
            val input = BufferedReader(InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))
            val requestLine = input.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0]
            val path = parts[1].substringBefore('?')

            var contentLength = 0
            while (true) {
                val line = input.readLine() ?: break
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx > 0) {
                    val name = line.substring(0, idx).trim().lowercase()
                    val value = line.substring(idx + 1).trim()
                    if (name == "content-length") contentLength = value.toIntOrNull() ?: 0
                }
            }

            var body = ""
            if (contentLength > 0) {
                val buf = CharArray(contentLength)
                var readTotal = 0
                while (readTotal < contentLength) {
                    val n = input.read(buf, readTotal, contentLength - readTotal)
                    if (n < 0) break
                    readTotal += n
                }
                body = String(buf, 0, readTotal)
            }

            val output = socket.getOutputStream()
            when {
                method == "POST" && path == "/command" -> {
                    handleCommand(body)
                    writeResponse(output, 204, "", "text/plain")
                }
                method == "GET" && path == "/state" -> {
                    writeResponse(output, 200, getState(), "application/json")
                }
                // path is attacker-controlled (any LAN device can open a socket to this
                // port, per this file's own trust-model comment) and unnormalized — a
                // ".." segment resolves against the APK's own asset zip and can read
                // any packaged entry (compiled DEX, resources.arsc, etc.), not just
                // files under assets/remote/. Reject it outright rather than trying to
                // normalize, since nothing under remote/ ever legitimately needs one.
                method == "GET" && path.contains("..") -> writeResponse(output, 400, "Bad request", "text/plain")
                method == "GET" -> {
                    val assetPath = if (path == "/") "remote/index.html" else "remote$path"
                    serveAsset(output, assetPath)
                }
                else -> writeResponse(output, 405, "Method not allowed", "text/plain")
            }
        } catch (e: Exception) {
            // A single malformed/dropped connection shouldn't affect the
            // server loop — just close and move on.
        } finally {
            try { socket.close() } catch (e: Exception) {}
        }
    }

    private fun handleCommand(body: String) {
        try {
            val json = JSONObject(body)
            val key = json.optString("key", "")
            val shift = json.optBoolean("shift", false)
            val action = json.optString("action", "").ifEmpty { null }
            if (key.isNotEmpty() || action != null) onCommand(key, shift, action)
        } catch (e: Exception) {
            // Malformed body — ignore, matches main.js's own /command
            // handler treating a bad body as a no-op rather than crashing.
        }
    }

    private fun serveAsset(output: OutputStream, assetPath: String) {
        try {
            val data = assets.open(assetPath).use { it.readBytes() }
            val contentType = when {
                assetPath.endsWith(".html") -> "text/html"
                assetPath.endsWith(".js") -> "text/javascript"
                assetPath.endsWith(".css") -> "text/css"
                else -> "application/octet-stream"
            }
            writeRawResponse(output, 200, "OK", contentType, data)
        } catch (e: Exception) {
            writeResponse(output, 404, "Not found", "text/plain")
        }
    }

    private fun writeResponse(output: OutputStream, status: Int, body: String, contentType: String) {
        val statusText = when (status) {
            200 -> "OK"; 204 -> "No Content"; 404 -> "Not Found"; 405 -> "Method Not Allowed"; else -> "Error"
        }
        writeRawResponse(output, status, statusText, contentType, body.toByteArray(StandardCharsets.UTF_8))
    }

    private fun writeRawResponse(output: OutputStream, status: Int, statusText: String, contentType: String, data: ByteArray) {
        val header = "HTTP/1.1 $status $statusText\r\nContent-Type: $contentType\r\nContent-Length: ${data.size}\r\nConnection: close\r\n\r\n"
        output.write(header.toByteArray(StandardCharsets.UTF_8))
        if (data.isNotEmpty()) output.write(data)
        output.flush()
    }
}

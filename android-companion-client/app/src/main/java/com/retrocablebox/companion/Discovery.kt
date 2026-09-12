package com.retrocablebox.companion

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

/**
 * LAN auto-discovery for the desktop app — same UDP broadcast/reply
 * protocol as android-remote-client's Discovery.kt, just reading
 * `companionPort` out of the reply instead of `remotePort` (see
 * startDiscoveryServer, main-discovery-server.js, which now sends both plus
 * viewerPort). Never required — the connect bar's manual host field always
 * works if this finds nothing (different subnet, UDP blocked by a
 * firewall, companion access not enabled on the host yet, etc).
 *
 * Returns every box that answers, not just the first. A house with two
 * boxes on one network used to get whichever replied fastest, with no sign
 * that the other existed and no way to reach it except typing its address.
 */
object Discovery {
    private const val DISCOVERY_PORT = 41234
    private const val DISCOVERY_MAGIC = "RETRO_CABLE_BOX_DISCOVER"
    private const val DISCOVERY_REPLY_MAGIC = "RETRO_CABLE_BOX_HELLO"
    private const val TIMEOUT_MS = 2500

    data class Result(val host: String, val companionPort: Int, val name: String)

    /** The first box to answer, or null. Kept for callers that just want one. */
    suspend fun find(): Result? = findAll().firstOrNull()

    suspend fun findAll(): List<Result> = withContext(Dispatchers.IO) {
        // Closed in `finally`, not just on the two in-loop success/timeout
        // paths below — any *other* exception (e.g. a Wi-Fi toggle or VPN
        // change throwing mid-scan) used to skip straight past both close()
        // calls and leak the socket. Repeated taps of FIND during a flaky
        // network session could exhaust sockets and make later networking
        // silently fail.
        val socket = DatagramSocket()
        try {
            socket.broadcast = true
            socket.soTimeout = TIMEOUT_MS
            val magicBytes = DISCOVERY_MAGIC.toByteArray()
            socket.send(DatagramPacket(
                magicBytes, magicBytes.size, InetAddress.getByName("255.255.255.255"), DISCOVERY_PORT
            ))

            // A LAN can have the viewer/remote/companion services in any mix
            // of enabled/disabled, so a reply without a companionPort is
            // skipped rather than ending the scan — and the scan always runs
            // the full window so a second box gets its chance to answer.
            val found = LinkedHashMap<String, Result>()
            val buf = ByteArray(512)
            val deadline = System.currentTimeMillis() + TIMEOUT_MS
            while (System.currentTimeMillis() < deadline) {
                socket.soTimeout = (deadline - System.currentTimeMillis()).toInt().coerceAtLeast(1)
                val receivePacket = DatagramPacket(buf, buf.size)
                try {
                    socket.receive(receivePacket)
                } catch (timeout: java.net.SocketTimeoutException) {
                    break // window is up; report whatever answered
                }
                val response = String(receivePacket.data, 0, receivePacket.length, Charsets.UTF_8)
                val json = try { JSONObject(response) } catch (bad: Exception) { continue }
                if (json.optString("magic") != DISCOVERY_REPLY_MAGIC) continue
                val companionPort = json.optInt("companionPort", 0)
                if (companionPort <= 0) continue
                val hostIp = receivePacket.address.hostAddress ?: continue
                // Keyed by address:port so a box that answers the broadcast
                // twice is listed once.
                found.putIfAbsent("$hostIp:$companionPort",
                    Result(hostIp, companionPort, json.optString("name", "RerunTV")))
            }
            found.values.toList()
        } catch (e: Exception) {
            emptyList() // any network error — treated as "found nothing"
        } finally {
            socket.close()
        }
    }
}

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
 * viewerPort). Never required — the CONNECT tab's manual host field always
 * works if this finds nothing (different subnet, UDP blocked by a
 * firewall, companion access not enabled on the host yet, etc).
 */
object Discovery {
    private const val DISCOVERY_PORT = 41234
    private const val DISCOVERY_MAGIC = "RETRO_CABLE_BOX_DISCOVER"
    private const val DISCOVERY_REPLY_MAGIC = "RETRO_CABLE_BOX_HELLO"
    private const val TIMEOUT_MS = 2500

    data class Result(val host: String, val companionPort: Int, val name: String)

    suspend fun find(): Result? = withContext(Dispatchers.IO) {
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
            // of enabled/disabled — keep reading replies until one actually
            // carries a companionPort (or the socket times out), rather than
            // stopping at the first reply, which might be a box with only
            // the viewer or remote enabled.
            val buf = ByteArray(512)
            val deadline = System.currentTimeMillis() + TIMEOUT_MS
            while (System.currentTimeMillis() < deadline) {
                socket.soTimeout = (deadline - System.currentTimeMillis()).toInt().coerceAtLeast(1)
                val receivePacket = DatagramPacket(buf, buf.size)
                socket.receive(receivePacket)
                val response = String(receivePacket.data, 0, receivePacket.length, Charsets.UTF_8)
                val json = JSONObject(response)
                if (json.optString("magic") != DISCOVERY_REPLY_MAGIC) continue
                val companionPort = json.optInt("companionPort", 0)
                if (companionPort <= 0) continue
                val hostIp = receivePacket.address.hostAddress ?: continue
                return@withContext Result(hostIp, companionPort, json.optString("name", "RerunTV"))
            }
            null
        } catch (e: Exception) {
            null // timeout or any network error — treated as "not found"
        } finally {
            socket.close()
        }
    }
}

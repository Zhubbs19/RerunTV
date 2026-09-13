package com.retrocablebox.tvclient

import android.annotation.SuppressLint
import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface

/**
 * A thin fullscreen WebView wrapper around Retro Cable Box's LAN viewer
 * (see the Electron app's main.js: startViewerServer). This activity owns
 * three things a plain browser tab wouldn't give you on a TV: remembering
 * the host address across launches, a Settings-button-triggered form to
 * (re)enter it, and forwarding remote button presses as real keyboard
 * events so the page's own keyboard shortcuts (handleKey, app.js) work
 * without a physical keyboard. It also handles TV-specific rough edges a
 * plain browser tab doesn't: a visible D-pad focus state on every button
 * (no pointer hover to fall back on), a branded retry screen instead of
 * Chromium's generic error page when the host drops off the network,
 * recovering from a WebView renderer-process crash instead of leaving a
 * frozen black screen, LAN auto-discovery instead of requiring the host's
 * IP to be typed in, pausing playback when backgrounded, debouncing
 * rapid-fire channel changes from a held remote button, and running its own
 * embedded phone-remote server (RemoteServer.kt) — a phone on the same LAN
 * can control THIS specific TV the same way the Electron host's own phone
 * remote controls it, since a separate device has no access to that
 * process's IPC.
 *
 * A typical Google TV remote (confirmed against a real Hisense remote
 * during development) has NO letter keys at all — just D-pad/OK, Back,
 * Home, a CH channel rocker, a VOL rocker + Mute, Play/Pause, a "123"
 * numeric-entry toggle, a Settings gear icon, and fixed streaming-app
 * shortcut buttons that the OS reserves for launching those apps directly
 * (not deliverable to this app as ordinary key events). That means most of
 * Retro Cable Box's own shortcuts (Guide/Settings/Info/Mute/Time Machine —
 * all letter-key-bound in handleKey, app.js) have no 1:1 physical button to
 * land on. Rather than guess at undocumented vendor keycodes for the
 * remaining icons, the overlay screen doubles as a small D-pad-navigable
 * "TV menu" reachable via Play/Pause, giving every one of those features a
 * real, focusable on-screen button instead. Play/Pause, not the Settings
 * gear icon, despite the gear icon being the obvious pick: confirmed live
 * that this specific remote's Settings button is intercepted by the TV's
 * own system UI before it ever reaches any app at all (opens Android's
 * system Settings instead) — not something any app can override, so
 * KEYCODE_SETTINGS/KEYCODE_MENU are kept mapped only as a best-effort
 * fallback for a different remote that might actually deliver one of them.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var setupOverlay: View
    private lateinit var hostInput: EditText
    private lateinit var quickActionsRow: View
    private lateinit var quickActionsRow2: View
    private lateinit var quickActionsRow3: View
    private lateinit var quickActionsTitle: View
    private lateinit var watchTvButton: View
    private lateinit var connectionLostOverlay: View
    private lateinit var scanStatusText: TextView
    private lateinit var remoteUrlText: TextView
    private lateinit var prefs: SharedPreferences
    private lateinit var remoteServer: RemoteServer

    // Mirrors the last state the page reported via the AndroidRemoteBridge
    // JS interface (see StateBridge below, and sendRemoteState in
    // browser-api-shim.js) — served back out over RemoteServer's /state
    // route for the phone remote's own "NOW WATCHING" readout, the same
    // shape main.js's latestRemoteState already uses.
    @Volatile private var latestState: String = "{\"number\":null,\"name\":null}"

    // Pairing is a real HTML form, so its text field must receive trusted
    // Android key events. The normal TV screen still uses injected DOM keys
    // for cable-box controls.
    @Volatile private var showingPairingPage = false

    // What loadHost() most recently pointed the WebView at — the retry
    // handler below reloads exactly this, not whatever's saved in prefs, so
    // a retry always matches what's actually on screen even if the user
    // changed the address again in the meantime.
    private var currentHost: String? = null

    // True once the CURRENT load has genuinely finished successfully at
    // least once — see showConnectionLost()'s use of this below. Reset to
    // false only when a fresh load actually starts (loadHost).
    private var hasLoadedSuccessfully = false

    private val retryHandler = Handler(Looper.getMainLooper())
    private val retryRunnable = Runnable {
        currentHost?.let { webView.loadUrl("$it/") }
    }

    // Debounces channel-change key repeats (see dispatchKeyEvent) — Android
    // fires a fresh ACTION_DOWN roughly every ~50-100ms while a D-pad/CH key
    // is held, and without this a held button would fire a flurry of
    // channel changes (each a full retune + static-burst transition) far
    // faster than is watchable, unlike a real cable box's more measured
    // repeat rate.
    private var lastChannelChangeMs = 0L

    // The page's remote-input API version (window.RerunTVInput, renderer
    // tv-input.js), probed after each page load. 0 = an older host: keep
    // injecting keyboard events exactly as before. 1+ = post RemoteKey names
    // and let the page own Back, long-press OK and the CH rocker
    // (docs/design/01 §5.1, Phase B).
    @Volatile private var pageInputVersion = 0
    private var okDownAtMs = 0L
    private var okLongSent = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureTvWindow()
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences("retro_cable_box_tv_client", MODE_PRIVATE)
        webView = findViewById(R.id.webview)
        setupOverlay = findViewById(R.id.setup_overlay)
        hostInput = findViewById(R.id.host_input)
        quickActionsRow = findViewById(R.id.quick_actions_row)
        quickActionsRow2 = findViewById(R.id.quick_actions_row2)
        quickActionsRow3 = findViewById(R.id.quick_actions_row3)
        quickActionsTitle = findViewById(R.id.quick_actions_title)
        watchTvButton = findViewById(R.id.action_watch_tv_btn)
        connectionLostOverlay = findViewById(R.id.connection_lost_overlay)
        scanStatusText = findViewById(R.id.scan_status_text)
        remoteUrlText = findViewById(R.id.remote_url_text)

        configureWebView()

        remoteServer = RemoteServer(
            assets = assets,
            port = ANDROID_REMOTE_PORT,
            // onCommand fires from RemoteServer's own per-connection
            // background thread (see RemoteServer.handleClient), never the
            // UI thread — but WebView methods (evaluateJavascript, inside
            // sendJsKey) may ONLY be called from the UI thread. Without
            // this hop, the call either silently no-ops or throws an
            // exception that RemoteServer's own try/catch swallows
            // silently, which is exactly why /state (a plain read, no
            // WebView touch) worked while every button press did nothing
            // with no visible error anywhere.
            onCommand = { key, shift, action ->
                runOnUiThread {
                    if (action == "watch-tv") sendWatchTv() else sendJsKey(key, shift)
                }
            },
            getState = { latestState },
        )
        remoteServer.start()

        findViewById<Button>(R.id.scan_btn).setOnClickListener { runDiscovery() }
        findViewById<Button>(R.id.connect_btn).setOnClickListener { connectFromInput() }
        findViewById<Button>(R.id.action_watch_tv_btn).setOnClickListener {
            sendWatchTv()
            setupOverlay.visibility = View.GONE
            webView.requestFocus()
        }
        findViewById<Button>(R.id.action_guide_btn).setOnClickListener { runQuickAction("g") }
        findViewById<Button>(R.id.action_settings_btn).setOnClickListener { runQuickAction("s") }
        findViewById<Button>(R.id.action_info_btn).setOnClickListener { runQuickAction("i") }
        findViewById<Button>(R.id.action_mute_btn).setOnClickListener { runQuickAction("m") }
        findViewById<Button>(R.id.action_vol_down_btn).setOnClickListener { runQuickAction("-") }
        findViewById<Button>(R.id.action_vol_up_btn).setOnClickListener { runQuickAction("+") }
        findViewById<Button>(R.id.action_crt_btn).setOnClickListener { runQuickAction("c") }
        findViewById<Button>(R.id.action_picture_btn).setOnClickListener { runQuickAction("v") }
        findViewById<Button>(R.id.action_aspect_btn).setOnClickListener { runQuickAction("a") }
        findViewById<Button>(R.id.action_sleep_btn).setOnClickListener { runQuickAction("z") }
        findViewById<Button>(R.id.action_power_btn).setOnClickListener { runQuickAction("p") }
        // Shift+M (stereo/mono/SAP cycle, app.js's handleKey) — same trick
        // as the phone-remote page's FAV ▲/▼ buttons (data-shift="1"): no
        // physical key on this remote can produce a shifted keypress, so it
        // needs its own quick-action entry rather than reusing runQuickAction
        // (which always sends shift=false).
        findViewById<Button>(R.id.action_sap_btn).setOnClickListener {
            sendJsKey("m", shift = true)
            setupOverlay.visibility = View.GONE
            webView.requestFocus()
        }
        findViewById<Button>(R.id.connection_lost_change_btn).setOnClickListener { showSetupOverlay() }

        val savedHost = prefs.getString(PREF_HOST, null)
        if (savedHost.isNullOrBlank()) {
            showSetupOverlay()
            // A genuinely fresh install has nothing to lose by trying —
            // saves the most common case (exactly one Retro Cable Box on
            // the LAN) a manual IP lookup entirely. Only auto-runs once,
            // here; reopening the menu later never re-triggers it, only
            // pressing SCAN again does.
            runDiscovery()
        } else {
            loadHost(savedHost)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        // Pinned rather than left at WebView's default, which otherwise
        // follows the device's system "Font size" accessibility setting —
        // some Google TV OEM builds ship that non-default out of the box.
        // That's a second, independent text-scaling channel from the
        // viewport/overview-mode one addressed below (a wrong textZoom would
        // look like wrong-sized page text even with everything below
        // correct), so it needs its own explicit fix rather than assuming
        // "correct viewport" already covers it.
        settings.textZoom = 100
        // Marks this as the native television client before index.html's
        // first-paint viewport script runs. Unlike a query parameter, the
        // marker survives the viewer pairing form's redirect back to `/`.
        // RerunTV then lays out against one 1920-wide logical TV canvas and
        // WebView composites it sharply at either 1080p or 4K.
        settings.userAgentString = "${settings.userAgentString} RerunTV-AndroidTV"
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        // Deliberately NOT setting loadWithOverviewMode/useWideViewPort —
        // those tell WebView to render at a wide desktop-style virtual
        // viewport and zoom-to-fit, which is only useful for pages with no
        // viewport meta tag of their own. renderer/index.html already sets
        // <meta name="viewport" content="width=device-width, initial-scale=1">
        // for exactly this reason (see its own comment). On several Android
        // TV OEM WebView builds that combination overrides/fights the page's
        // device-width meta instead of respecting it, rendering the whole UI
        // at the wrong scale on high-resolution (4K) panels — confirmed live
        // on a real 4K TV: general UI scaling was off and the hint bar
        // (guide.css's fixed-height, overflow:hidden .hint-bar) clipped
        // wrapped items because content reflowed at the wrong CSS width.
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        // Cookies are accepted by default, but WebView only *buffers* new
        // cookie writes — they aren't guaranteed durable on disk until
        // flush() is called (see onPageFinished/onPause below). Without
        // that, the pairing session cookie the host sets (a 90-day
        // HttpOnly cookie, main-lan-security.js) can be silently lost the
        // moment Android kills this backgrounded process — routine on
        // low-RAM TV hardware, and not a clean onDestroy the app gets any
        // warning for — forcing the pairing screen every single launch
        // instead of the intended "pair once" behavior.
        CookieManager.getInstance().setAcceptCookie(true)

        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        // Matches the splash background (styles.xml/splash_background.xml)
        // so there's no flash of white while the page itself is still
        // loading its own CSS — the WebView paints this immediately on
        // creation, well before any network response arrives.
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.launcher_background))

        webView.webViewClient = RetroCableBoxWebViewClient()
        webView.webChromeClient = WebChromeClient()
        // Lets the page report its current channel back to this activity —
        // browser-api-shim.js's sendRemoteState calls
        // window.AndroidRemoteBridge.reportState(...) whenever it exists
        // (only true here, never in a plain browser), which this app's own
        // embedded RemoteServer serves back out over /state for the phone
        // remote's "NOW WATCHING" readout.
        webView.addJavascriptInterface(StateBridge(), "AndroidRemoteBridge")
    }

    private fun configureTvWindow() {
        // A television viewer should remain awake and fully immersive while
        // it is actively showing the continuous channel. Transient system
        // bars remain reachable by swipe, but never steal a strip of the
        // 16:9 render surface or shift the guide after first paint.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        hideSystemBars()
    }

    private fun hideSystemBars() {
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private inner class StateBridge {
        @JavascriptInterface
        fun reportState(json: String) {
            latestState = json
        }

        // TV mode's exit prompt (tv-input.js): Back from live TV asks first,
        // and only the EXIT choice there closes the app.
        @JavascriptInterface
        fun exitApp() {
            runOnUiThread { finish() }
        }
    }

    // ---- LAN auto-discovery ---------------------------------------------
    // Broadcasts a small magic string to DISCOVERY_PORT and waits briefly
    // for a reply — the server-side half (startDiscoveryServer, main.js)
    // listens on the same port and answers with its viewer port. Must run
    // off the main thread (Android forbids network I/O there). Never
    // required — the manual address field always still works if this finds
    // nothing (a different subnet, a firewall blocking UDP, multiple
    // candidates, etc.).
    private fun runDiscovery() {
        scanStatusText.visibility = View.VISIBLE
        scanStatusText.text = getString(R.string.scan_searching)
        Thread {
            var foundUrl: String? = null
            try {
                val socket = DatagramSocket()
                socket.broadcast = true
                socket.soTimeout = DISCOVERY_TIMEOUT_MS
                val magicBytes = DISCOVERY_MAGIC.toByteArray()
                val sendPacket = DatagramPacket(
                    magicBytes, magicBytes.size,
                    InetAddress.getByName("255.255.255.255"), DISCOVERY_PORT
                )
                socket.send(sendPacket)

                val buf = ByteArray(512)
                val receivePacket = DatagramPacket(buf, buf.size)
                socket.receive(receivePacket)
                val response = String(receivePacket.data, 0, receivePacket.length, Charsets.UTF_8)
                val json = JSONObject(response)
                if (json.optString("magic") == DISCOVERY_REPLY_MAGIC) {
                    val viewerPort = json.optInt("viewerPort", 0)
                    val hostIp = receivePacket.address.hostAddress
                    if (viewerPort > 0 && hostIp != null) {
                        foundUrl = "http://$hostIp:$viewerPort"
                    }
                }
                socket.close()
            } catch (e: Exception) {
                // Timeout or any network error — treated the same as "not
                // found" below; the manual field is always the fallback.
            }
            val resultUrl = foundUrl
            runOnUiThread {
                if (resultUrl != null) {
                    hostInput.setText(resultUrl)
                    scanStatusText.text = getString(R.string.scan_found, resultUrl)
                } else {
                    scanStatusText.text = getString(R.string.scan_not_found)
                }
            }
        }.start()
    }

    private fun connectFromInput() {
        var value = hostInput.text.toString().trim()
        if (value.isEmpty()) return
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "http://$value"
        }
        value = value.trimEnd('/')
        prefs.edit().putString(PREF_HOST, value).apply()
        loadHost(value)
    }

    private fun loadHost(host: String) {
        currentHost = host
        hasLoadedSuccessfully = false
        retryHandler.removeCallbacks(retryRunnable)
        connectionLostOverlay.visibility = View.GONE
        setupOverlay.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl("$host/")
        webView.requestFocus()
    }

    // Called from both the Settings-button/KEYCODE_MENU path and the (rare)
    // first-run case where no host is saved yet. The quick-actions row only
    // makes sense once a page is actually loaded underneath — a fresh
    // install with nothing connected has nothing for GUIDE/INFO/etc. to act
    // on, so it stays hidden until a host has been reached at least once.
    private fun showSetupOverlay() {
        retryHandler.removeCallbacks(retryRunnable)
        connectionLostOverlay.visibility = View.GONE
        scanStatusText.visibility = View.GONE

        val savedHost = prefs.getString(PREF_HOST, null)
        val alreadyConnected = !savedHost.isNullOrBlank() && webView.visibility == View.VISIBLE
        if (!savedHost.isNullOrBlank()) hostInput.setText(savedHost)
        quickActionsRow.visibility = if (alreadyConnected) View.VISIBLE else View.GONE
        quickActionsRow2.visibility = if (alreadyConnected) View.VISIBLE else View.GONE
        quickActionsRow3.visibility = if (alreadyConnected) View.VISIBLE else View.GONE
        quickActionsTitle.visibility = if (alreadyConnected) View.VISIBLE else View.GONE
        watchTvButton.visibility = if (alreadyConnected) View.VISIBLE else View.GONE
        setupOverlay.visibility = View.VISIBLE
        if (alreadyConnected) {
            findViewById<Button>(R.id.action_guide_btn).requestFocus()
        } else {
            hostInput.requestFocus()
        }

        val lanAddresses = getLanAddresses()
        if (lanAddresses.isEmpty()) {
            remoteUrlText.visibility = View.GONE
        } else {
            val url = "http://${lanAddresses[0]}:$ANDROID_REMOTE_PORT"
            remoteUrlText.text = getString(R.string.remote_url_text, url)
            remoteUrlText.visibility = View.VISIBLE
        }
    }

    // Ported from main.js's own getLanAddresses (Electron host) — a naive
    // "first non-internal address" picks up VPN/virtual adapters that
    // enumerate before the real WiFi/Ethernet interface, which this exact
    // project already hit for real once before on the Electron side (a
    // Tailscale link-local address won the "first" slot ahead of the real
    // 192.168.x.x WiFi address there). Skipping loopback/down interfaces
    // wasn't enough by itself, which is very likely why the phone-remote
    // URL shown here has been unreachable — same class of bug, just never
    // ported to this side when the feature was first built. Only the first
    // surviving candidate is shown (unlike the host's settings screen,
    // which lists every candidate) to keep this one line on a small
    // TV-menu screen.
    private val nonLanAdapterName = Regex(
        "vpn|tailscale|nordlynx|wireguard|zerotier|hyper-v|virtualbox|vmware|loopback|utun|tap\\d|tun\\d",
        RegexOption.IGNORE_CASE
    )

    private fun getLanAddresses(): List<String> {
        val result = mutableListOf<String>()
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val iface = interfaces.nextElement()
                if (!iface.isUp || iface.isLoopback) continue
                val name = iface.name ?: ""
                val displayName = iface.displayName ?: ""
                if (nonLanAdapterName.containsMatchIn(name) || nonLanAdapterName.containsMatchIn(displayName)) continue
                val addresses = iface.inetAddresses
                while (addresses.hasMoreElements()) {
                    val addr = addresses.nextElement()
                    if (addr is Inet4Address && !addr.isLoopbackAddress && !(addr.hostAddress ?: "").startsWith("169.254.")) {
                        addr.hostAddress?.let { result.add(it) }
                    }
                }
            }
        } catch (e: Exception) {
            // No usable network info — remoteUrlText just stays hidden.
        }
        return result
    }

    // A quick-action button: send the key, then dismiss the overlay and
    // hand focus straight back to the page so the resulting screen (guide/
    // settings/details) is what's showing, not this menu.
    private fun runQuickAction(key: String) {
        sendJsKey(key)
        setupOverlay.visibility = View.GONE
        webView.requestFocus()
    }

    private fun showConnectionLost() {
        // Don't cover a screen the user is actively looking at/editing —
        // the setup overlay already has its own "try again" path via its
        // CONNECT button, and stacking the connection-lost screen on top of
        // it would just be confusing.
        if (setupOverlay.visibility == View.VISIBLE) return
        connectionLostOverlay.visibility = View.VISIBLE
        retryHandler.removeCallbacks(retryRunnable)
        retryHandler.postDelayed(retryRunnable, RETRY_DELAY_MS)
    }

    // ---- Remote button -> real keyboard events -------------------------
    // Android TV's D-pad normally drives View-level spatial focus
    // navigation rather than producing standard 'keydown' DOM events inside
    // a WebView, and Enter/Center isn't guaranteed to reach page JS either
    // depending on device/WebView version. Rather than depend on that,
    // directly inject a real KeyboardEvent into the page for the keys the
    // app's own handleKey() (renderer/js/app.js) already understands — the
    // same {key: 'ArrowUp', ...} shape the existing phone-remote feature
    // synthesizes on the Electron side (see onRemoteCommand, app.js),
    // just produced here via JS injection instead of an IPC relay.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // Only the native setup/host-address form needs real Android focus
        // navigation (a real EditText + Buttons) — the connection-lost
        // screen deliberately does NOT gate key handling here anymore
        // (it used to): that meant if it were ever shown incorrectly, the
        // whole app would look alive but be permanently unresponsive to
        // every remote button with no way out except a fresh reinstall.
        // Any D-pad/OK/Play-Pause press now dismisses it outright and falls
        // through to normal handling instead — the WebView underneath
        // stays the real source of truth for whether the connection is
        // actually still down, and CHANGE ADDRESS is still reachable via
        // Play/Pause regardless (showSetupOverlay wins over this screen
        // every time it's called).
        if (setupOverlay.visibility == View.VISIBLE) {
            return super.dispatchKeyEvent(event)
        }
        if (showingPairingPage) {
            return super.dispatchKeyEvent(event)
        }
        if (connectionLostOverlay.visibility == View.VISIBLE && event.action == KeyEvent.ACTION_DOWN) {
            connectionLostOverlay.visibility = View.GONE
        }
        if (event.action == KeyEvent.ACTION_DOWN) {
            // KEYCODE_SETTINGS/KEYCODE_MENU are kept as a best-effort
            // fallback, but confirmed live on a real Hisense remote: the
            // system intercepts the dedicated Settings/gear button before
            // it ever reaches this Activity at all — it opens Android's own
            // system Settings instead, and no app can override that. So
            // Play/Pause is now the real, working way to open the TV menu —
            // it was previously just a redundant duplicate of OK/Center
            // (both sent "Enter"), so repurposing it costs nothing, and as
            // a standard media key it isn't reserved by the system the way
            // the Settings icon apparently is on this hardware.
            if (event.keyCode == KeyEvent.KEYCODE_SETTINGS || event.keyCode == KeyEvent.KEYCODE_MENU ||
                event.keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
                showSetupOverlay()
                return true
            }
            if (pageInputVersion >= 1) {
                val remoteKey = remoteKeyFor(event.keyCode)
                if (remoteKey != null) {
                    postRemoteKey(remoteKey, event)
                    return true
                }
            }
            val jsKey = mapKeyCode(event.keyCode)
            if (jsKey != null) {
                if (jsKey == "ArrowUp" || jsKey == "ArrowDown") {
                    val now = SystemClock.uptimeMillis()
                    if (now - lastChannelChangeMs < CHANNEL_DEBOUNCE_MS) {
                        return true // swallow the repeat; still consumed either way
                    }
                    lastChannelChangeMs = now
                }
                sendJsKey(jsKey)
                return true
            }
        }
        if (pageInputVersion >= 1 && event.action == KeyEvent.ACTION_UP) {
            val remoteKey = remoteKeyFor(event.keyCode)
            if (remoteKey != null) {
                postRemoteKey(remoteKey, event)
                return true
            }
        }
        // An older host (pageInputVersion 0) doesn't own BACK — it behaves
        // normally and leaves the app, as it always has.
        return super.dispatchKeyEvent(event)
    }

    // Physical buttons -> the page's RemoteKey vocabulary (remote-input.js).
    // Play/Pause, Settings and Menu stay native (they open this app's own
    // overlay, handled above); Home and the OS-reserved buttons never arrive.
    private fun remoteKeyFor(keyCode: Int): String? = when (keyCode) {
        KeyEvent.KEYCODE_DPAD_UP -> "up"
        KeyEvent.KEYCODE_DPAD_DOWN -> "down"
        KeyEvent.KEYCODE_DPAD_LEFT -> "left"
        KeyEvent.KEYCODE_DPAD_RIGHT -> "right"
        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "ok"
        KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> "back"
        KeyEvent.KEYCODE_CHANNEL_UP -> "chUp"
        KeyEvent.KEYCODE_CHANNEL_DOWN -> "chDown"
        KeyEvent.KEYCODE_LAST_CHANNEL -> "last"
        KeyEvent.KEYCODE_INFO -> "info"
        KeyEvent.KEYCODE_GUIDE -> "guide"
        KeyEvent.KEYCODE_PROG_RED -> "red"
        KeyEvent.KEYCODE_PROG_GREEN -> "green"
        KeyEvent.KEYCODE_PROG_YELLOW -> "yellow"
        KeyEvent.KEYCODE_PROG_BLUE -> "blue"
        KeyEvent.KEYCODE_MEDIA_REWIND -> "rewind"
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> "fastForward"
        KeyEvent.KEYCODE_CAPTIONS -> "captions"
        KeyEvent.KEYCODE_0 -> "digit0"
        KeyEvent.KEYCODE_1 -> "digit1"
        KeyEvent.KEYCODE_2 -> "digit2"
        KeyEvent.KEYCODE_3 -> "digit3"
        KeyEvent.KEYCODE_4 -> "digit4"
        KeyEvent.KEYCODE_5 -> "digit5"
        KeyEvent.KEYCODE_6 -> "digit6"
        KeyEvent.KEYCODE_7 -> "digit7"
        KeyEvent.KEYCODE_8 -> "digit8"
        KeyEvent.KEYCODE_9 -> "digit9"
        else -> null
    }

    // Long-press is decided here only because Android's repeatCount is the
    // reliable signal on TV hardware; the threshold matches the page's
    // LONG_PRESS_MS. OK acts on release (short) or once the hold crosses
    // the threshold (long). Back acts on release and, if the page is gone
    // or can't answer, falls back to leaving the app. Everything else acts
    // on press, with channel repeats debounced as before.
    private fun postRemoteKey(remoteKey: String, event: KeyEvent) {
        val now = SystemClock.uptimeMillis()
        when (remoteKey) {
            "ok" -> {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    if (event.repeatCount == 0) {
                        okDownAtMs = now
                        okLongSent = false
                    } else if (!okLongSent && now - okDownAtMs >= LONG_PRESS_MS) {
                        okLongSent = true
                        sendRemoteKey("ok", longPress = true, repeat = false)
                    }
                } else if (event.action == KeyEvent.ACTION_UP && !okLongSent) {
                    sendRemoteKey("ok", longPress = false, repeat = false)
                }
            }
            "back" -> {
                if (event.action != KeyEvent.ACTION_UP) return
                webView.evaluateJavascript(
                    "(window.RerunTVInput && window.RerunTVInput.native({key:'back'})) || 'missing'",
                ) { result ->
                    if (result == null || result.contains("missing")) finish()
                }
            }
            else -> {
                if (event.action != KeyEvent.ACTION_DOWN) return
                if (remoteKey == "up" || remoteKey == "down" || remoteKey == "chUp" || remoteKey == "chDown") {
                    if (event.repeatCount > 0 && now - lastChannelChangeMs < CHANNEL_DEBOUNCE_MS) return
                    lastChannelChangeMs = now
                }
                sendRemoteKey(remoteKey, longPress = false, repeat = event.repeatCount > 0)
            }
        }
    }

    private fun sendRemoteKey(remoteKey: String, longPress: Boolean, repeat: Boolean) {
        // remoteKey only ever comes from remoteKeyFor's fixed literals.
        webView.evaluateJavascript(
            "window.RerunTVInput && window.RerunTVInput.native({key:'$remoteKey',longPress:$longPress,repeat:$repeat})",
            null,
        )
    }

    private fun probePageInputVersion(view: WebView) {
        view.evaluateJavascript("(window.RerunTVInput && window.RerunTVInput.version) || 0") { result ->
            pageInputVersion = result?.trim('"')?.toDoubleOrNull()?.toInt() ?: 0
        }
    }

    private fun mapKeyCode(keyCode: Int): String? = when (keyCode) {
        KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
        KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
        KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
        KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
        // The remote's dedicated CH rocker — the single most natural
        // channel-surf button on a typical TV remote, and previously
        // unmapped entirely. Same target as D-pad Up/Down.
        KeyEvent.KEYCODE_CHANNEL_UP -> "ArrowUp"
        KeyEvent.KEYCODE_CHANNEL_DOWN -> "ArrowDown"
        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "Enter"
        // KEYCODE_MEDIA_PLAY_PAUSE is handled earlier, as a special case
        // that opens the TV menu (see dispatchKeyEvent) — it never reaches
        // this table.
        KeyEvent.KEYCODE_ESCAPE -> "Escape"
        KeyEvent.KEYCODE_0 -> "0"
        KeyEvent.KEYCODE_1 -> "1"
        KeyEvent.KEYCODE_2 -> "2"
        KeyEvent.KEYCODE_3 -> "3"
        KeyEvent.KEYCODE_4 -> "4"
        KeyEvent.KEYCODE_5 -> "5"
        KeyEvent.KEYCODE_6 -> "6"
        KeyEvent.KEYCODE_7 -> "7"
        KeyEvent.KEYCODE_8 -> "8"
        KeyEvent.KEYCODE_9 -> "9"
        else -> null
    }

    private fun sendJsKey(key: String, shift: Boolean = false) {
        // mapKeyCode/runQuickAction only ever pass a fixed literal from a
        // whitelist; RemoteServer's onCommand passes whatever a phone
        // remote sent over the network instead — same trust model as
        // main.js's own /command handler (LAN-only, no auth, matches "same
        // trust as anyone who could pick up a physical remote"), so this
        // only needs to stay a syntactically-safe JS string, not sanitized
        // against a malicious sender. Escaping backslash/quote is
        // sufficient to prevent breaking out of the single-quoted literal
        // below; nothing else can execute arbitrary code from this string.
        val escaped = key.replace("\\", "\\\\").replace("'", "\\'")
        val js = "window.dispatchEvent(new KeyboardEvent('keydown', { key: '$escaped', shiftKey: $shift, bubbles: true }));"
        webView.evaluateJavascript(js, null)
    }

    private fun sendWatchTv() {
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('reruntv:watch-tv'))",
            null,
        )
    }

    // Handles both the "connection lost" retry flow and renderer-process
    // crash recovery — kept as one inner class since both are really the
    // same concern (this WebView load didn't end up showing a working
    // page, do something about it instead of leaving a dead screen).
    private inner class RetroCableBoxWebViewClient : WebViewClient() {
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            super.onReceivedError(view, request, error)
            // Two guards, not just one: isForMainFrame alone turned out not
            // to be reliable enough in practice — this app is a single-page
            // app that never navigates away from index.html once loaded, so
            // there's no legitimate reason for a real main-frame error to
            // fire again after the initial load already succeeded. Video
            // playback routinely produces aborted/cancelled sub-resource
            // requests as completely normal behavior (confirmed elsewhere
            // in this project), and gating on hasLoadedSuccessfully as well
            // means those can no longer falsely trigger a full-screen
            // "SIGNAL LOST" takeover that silently blocks all D-pad input
            // (see dispatchKeyEvent's early-return while this overlay is
            // visible) for an app that's actually working fine. The retry
            // screen now only ever covers the one case it actually needs
            // to: the very first connection attempt failing outright.
            if (request.isForMainFrame && !hasLoadedSuccessfully) {
                showConnectionLost()
            }
        }

        override fun onPageFinished(view: WebView, url: String?) {
            super.onPageFinished(view, url)
            // A successful load of the real page — clear any retry state
            // left over from an earlier failed attempt.
            hasLoadedSuccessfully = true
            retryHandler.removeCallbacks(retryRunnable)
            connectionLostOverlay.visibility = View.GONE
            pageInputVersion = 0
            view.evaluateJavascript(
                "document.querySelector('form[action=\"/_pair\"] input[name=\"code\"]') !== null",
            ) { result ->
                showingPairingPage = result == "true"
                if (showingPairingPage) {
                    view.requestFocus()
                    view.evaluateJavascript(
                        "document.querySelector('input[name=\"code\"]')?.focus()",
                        null,
                    )
                } else {
                    // Landed on the real page, not the pairing form — either
                    // pairing just succeeded (cookie freshly set) or an
                    // existing session cookie was still valid. Either way,
                    // commit it to disk now rather than waiting for a clean
                    // onPause, which a killed background process never gets.
                    CookieManager.getInstance().flush()
                    // The page's input API installs as its modules run;
                    // probe now and once more after a slow first load.
                    probePageInputVersion(view)
                    retryHandler.postDelayed({ probePageInputVersion(view) }, 3000L)
                }
            }
        }

        // The renderer process died — rare, more likely on lower-RAM TV
        // hardware. Returning false here would let the OS kill this whole
        // app; instead, restart the activity fresh rather than trying to
        // reconstruct/reattach a replacement WebView in place, which is
        // simpler and reliable without needing to test the trickier
        // in-place-swap path. Only actually invoked by the OS on API 26+;
        // harmlessly never called below that.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // Stop the phone-remote server before restarting, not just in
            // onDestroy() — onDestroy() isn't guaranteed to run (and close
            // the ServerSocket) before the new activity instance's onCreate()
            // tries to bind the same hardcoded ANDROID_REMOTE_PORT again.
            // RemoteServer.start() swallows a bind failure silently, so
            // losing that race used to leave the phone remote permanently
            // dead until the whole app was force-stopped and relaunched.
            remoteServer.stop()
            finish()
            startActivity(Intent(this@MainActivity, MainActivity::class.java))
            return true
        }
    }

    // Stops the WebView's JS timers/rendering while backgrounded (e.g. the
    // user pressed Home without fully exiting) — without this the page's
    // live video/audio and its own timers (schedule polling, breaks,
    // screensaver, etc.) keep running unseen, burning battery/CPU for
    // nothing. pauseTimers()/resumeTimers() are process-wide by design
    // (there's only ever one WebView in this app, so that's fine);
    // webView.onPause()/onResume() are this specific instance's own
    // rendering pause.
    override fun onPause() {
        super.onPause()
        webView.onPause()
        webView.pauseTimers()
        // Safety net alongside the onPageFinished flush above — covers a
        // pairing cookie or session renewal that happened without a fresh
        // page load in between (e.g. the sliding-renewal cookie refresh
        // main-lan-security.js does on ordinary requests, not just /_pair).
        CookieManager.getInstance().flush()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.resumeTimers()
    }

    override fun onDestroy() {
        retryHandler.removeCallbacks(retryRunnable)
        remoteServer.stop()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val PREF_HOST = "host_url"
        private const val RETRY_DELAY_MS = 4000L
        private const val CHANNEL_DEBOUNCE_MS = 200L
        private const val LONG_PRESS_MS = 500L
        private const val DISCOVERY_PORT = 41234
        private const val DISCOVERY_MAGIC = "RETRO_CABLE_BOX_DISCOVER"
        private const val DISCOVERY_REPLY_MAGIC = "RETRO_CABLE_BOX_HELLO"
        private const val DISCOVERY_TIMEOUT_MS = 2500
        private const val ANDROID_REMOTE_PORT = 8725
    }
}

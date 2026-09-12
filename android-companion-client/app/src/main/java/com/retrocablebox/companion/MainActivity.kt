package com.retrocablebox.companion

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import kotlinx.coroutines.launch

/**
 * Thin native shell for the responsive Companion surface served by the
 * desktop companion-app plugin. The old activity independently rebuilt the
 * remote, settings tree, channel manager, and file browser in Kotlin; every
 * desktop feature then had to be implemented twice and the two clients
 * drifted. Android and a phone browser now use the exact same authenticated
 * UI and API contract, while this shell retains LAN discovery, remembered
 * host selection, native downloads, and Android back navigation.
 *
 * Because the UI is served, a desktop update changes what this app shows
 * with no new APK. The shell only needs rebuilding when something in THIS
 * file changes.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var webView: WebView
    private lateinit var hostInput: EditText
    private lateinit var statusText: TextView
    private lateinit var connectBar: LinearLayout
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var errorPanel: View
    private lateinit var errorDetail: TextView
    private lateinit var discoverButton: Button

    /** True once a load has completed without an error we had to show. */
    private var connected = false
    private var loadFailed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = Prefs(this)
        webView = findViewById(R.id.companionWebView)
        hostInput = findViewById(R.id.hostInput)
        statusText = findViewById(R.id.statusText)
        connectBar = findViewById(R.id.connectBar)
        swipeRefresh = findViewById(R.id.swipeRefresh)
        errorPanel = findViewById(R.id.errorPanel)
        errorDetail = findViewById(R.id.errorDetail)
        discoverButton = findViewById(R.id.discoverButton)
        val openButton: Button = findViewById(R.id.openButton)
        val toggleConnectButton: Button = findViewById(R.id.toggleConnectButton)

        hostInput.setText(prefs.host?.let { host -> if (prefs.port == 8725) host else "$host:${prefs.port}" } ?: "")
        configureWebView()

        openButton.setOnClickListener { openEnteredHost() }
        discoverButton.setOnClickListener { discover() }
        findViewById<Button>(R.id.errorFindButton).setOnClickListener { discover() }
        findViewById<Button>(R.id.retryButton).setOnClickListener { loadCompanion() }
        toggleConnectButton.setOnClickListener { setConnectBarVisible(connectBar.visibility != View.VISIBLE) }
        swipeRefresh.setOnRefreshListener { loadCompanion() }
        swipeRefresh.setColorSchemeColors(0xFFE8B23A.toInt())

        // The page is a single document with JS tabs — there is no history to
        // walk, so treating Back as "go back in the WebView" always just quit.
        // Closing the connect bar first at least gives Back something to
        // undo, and matches what the button that opened it did.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    connectBar.visibility == View.VISIBLE && connected -> setConnectBarVisible(false)
                    webView.canGoBack() -> webView.goBack()
                    else -> finish()
                }
            }
        })

        if (prefs.host != null) {
            loadCompanion()
        } else {
            statusText.text = "FIND OR ENTER YOUR RERUNTV HOST"
            setConnectBarVisible(true)
        }
    }

    /** Picking a box is a once-ever job; the page needs the screen after that. */
    private fun setConnectBarVisible(visible: Boolean) {
        connectBar.visibility = if (visible) View.VISIBLE else View.GONE
    }

    private fun discover() {
        statusText.text = "SCANNING LAN…"
        discoverButton.isEnabled = false
        lifecycleScope.launch {
            val results = Discovery.findAll()
            discoverButton.isEnabled = true
            when {
                results.isEmpty() -> {
                    statusText.text = "NOT FOUND — ENTER HOST MANUALLY"
                    setConnectBarVisible(true)
                    Toast.makeText(this@MainActivity, "No RerunTV companion service found", Toast.LENGTH_SHORT).show()
                }
                results.size == 1 -> useHost(results[0])
                // More than one box answered, so ask rather than racing them.
                else -> AlertDialog.Builder(this@MainActivity)
                    .setTitle("Which RerunTV?")
                    .setItems(results.map { "${it.name} — ${it.host}" }.toTypedArray()) { _, which -> useHost(results[which]) }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
        }
    }

    private fun useHost(result: Discovery.Result) {
        prefs.host = result.host
        prefs.port = result.companionPort
        prefs.hostName = result.name
        hostInput.setText(if (result.companionPort == 8725) result.host else "${result.host}:${result.companionPort}")
        loadCompanion()
    }

    @Suppress("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        // Was LOAD_NO_CACHE, which re-downloaded the page, its CSS and its JS
        // on every single launch — needless latency at exactly the moment
        // someone wants the remote NOW. The server already marks the live
        // data routes no-store (see companion-app/main.js), so the cache can
        // only ever hold the static shell.
        webView.settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        webView.settings.builtInZoomControls = false
        webView.settings.displayZoomControls = false
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val allowedHost = prefs.host
                return if (request.url.host == allowedHost) false else {
                    startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, request.url))
                    true
                }
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                statusText.text = "CONNECTING…"
            }

            override fun onPageFinished(view: WebView, url: String) {
                swipeRefresh.isRefreshing = false
                if (loadFailed) return // the error panel is already up; don't claim success
                connected = true
                errorPanel.visibility = View.GONE
                setConnectBarVisible(false)
                statusText.text = (prefs.hostName?.let { "CONNECTED TO ${it.uppercase()}" } ?: "CONNECTED") +
                    "  ·  v${BuildConfig.VERSION_NAME}"
                // A remote you hold while watching should not dim and lock
                // after thirty seconds.
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }

            // The modern overload: it carries the real error and, unlike the
            // deprecated one this replaces, distinguishes the main document
            // failing from a sub-resource that merely 404'd.
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                showFailure(error.description?.toString())
            }
        }
        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            try {
                val request = DownloadManager.Request(Uri.parse(url))
                    .setMimeType(mimeType)
                    .addRequestHeader("User-Agent", userAgent)
                    .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType))
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, "Download started", Toast.LENGTH_SHORT).show()
            } catch (error: Exception) {
                Toast.makeText(this, "Download failed: ${error.message}", Toast.LENGTH_LONG).show()
            }
        })
    }

    /** A dead end before: the failure was a text label with nothing to tap. */
    private fun showFailure(detail: String?) {
        loadFailed = true
        swipeRefresh.isRefreshing = false
        statusText.text = "CONNECTION FAILED"
        errorDetail.text = listOfNotNull(prefs.baseUrl(), detail).joinToString("\n")
        errorPanel.visibility = View.VISIBLE
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun openEnteredHost() {
        val entered = hostInput.text.toString().trim().removePrefix("http://").removePrefix("https://").trimEnd('/')
        if (entered.isBlank()) {
            Toast.makeText(this, "Enter the RerunTV computer address", Toast.LENGTH_SHORT).show()
            return
        }
        val host = entered.substringBefore(':').trim()
        val port = entered.substringAfter(':', "8725").toIntOrNull() ?: 8725
        prefs.host = host
        prefs.port = port
        prefs.hostName = null
        loadCompanion()
    }

    private fun loadCompanion() {
        val url = prefs.baseUrl()
        if (url == null) {
            swipeRefresh.isRefreshing = false
            setConnectBarVisible(true)
            return
        }
        loadFailed = false
        errorPanel.visibility = View.GONE
        webView.loadUrl("$url/")
    }

    override fun onPause() {
        super.onPause()
        // Pairing is a session cookie. Android writes cookies to disk on its
        // own schedule, so a process death between the pairing response and
        // that flush lost the pairing and sent the user back to the TV for a
        // fresh code.
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        webView.stopLoading()
        webView.destroy()
        super.onDestroy()
    }
}

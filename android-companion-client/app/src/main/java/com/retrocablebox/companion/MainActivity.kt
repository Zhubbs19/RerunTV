package com.retrocablebox.companion

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * Thin native shell for the responsive Companion surface served by the
 * desktop companion-app plugin. The old activity independently rebuilt the
 * remote, settings tree, channel manager, and file browser in Kotlin; every
 * desktop feature then had to be implemented twice and the two clients
 * drifted. Android and a phone browser now use the exact same authenticated
 * UI and API contract, while this shell retains LAN discovery, remembered
 * host selection, native downloads, and Android back navigation.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var webView: WebView
    private lateinit var hostInput: EditText
    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = Prefs(this)
        webView = findViewById(R.id.companionWebView)
        hostInput = findViewById(R.id.hostInput)
        statusText = findViewById(R.id.statusText)
        val discoverButton: Button = findViewById(R.id.discoverButton)
        val openButton: Button = findViewById(R.id.openButton)

        hostInput.setText(prefs.host?.let { host -> if (prefs.port == 8725) host else "$host:${prefs.port}" } ?: "")
        configureWebView()

        openButton.setOnClickListener { openEnteredHost() }
        discoverButton.setOnClickListener {
            statusText.text = "SCANNING LAN…"
            discoverButton.isEnabled = false
            lifecycleScope.launch {
                val result = Discovery.find()
                discoverButton.isEnabled = true
                if (result == null) {
                    statusText.text = "NOT FOUND — ENTER HOST MANUALLY"
                    Toast.makeText(this@MainActivity, "No RerunTV companion service found", Toast.LENGTH_SHORT).show()
                    return@launch
                }
                prefs.host = result.host
                prefs.port = result.companionPort
                prefs.hostName = result.name
                hostInput.setText(if (result.companionPort == 8725) result.host else "${result.host}:${result.companionPort}")
                loadCompanion()
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        if (prefs.host != null) loadCompanion() else statusText.text = "FIND OR ENTER YOUR RERUNTV HOST"
    }

    @Suppress("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
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
                statusText.text = prefs.hostName?.let { "CONNECTED TO ${it.uppercase()}" } ?: "CONNECTED"
            }
            @Deprecated("Deprecated in Java")
            override fun onReceivedError(view: WebView, errorCode: Int, description: String, failingUrl: String) {
                statusText.text = "CONNECTION FAILED"
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
        val url = prefs.baseUrl() ?: return
        webView.loadUrl("$url/")
    }

    override fun onDestroy() {
        webView.stopLoading()
        webView.destroy()
        super.onDestroy()
    }
}

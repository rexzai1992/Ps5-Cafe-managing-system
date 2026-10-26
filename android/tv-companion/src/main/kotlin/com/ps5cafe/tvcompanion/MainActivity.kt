package com.ps5cafe.tvcompanion

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.media.tv.TvContract
import android.media.tv.TvView
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import kotlin.random.Random

/**
 * Shows this TV's screen page full screen.
 *
 * The page (served by the PS5 Cafe server) polls the server itself; this activity only loads it,
 * keeps it on screen, and retries when the server cannot be reached. It is NOT a lock: HOME, INPUT,
 * the TV's panel buttons, a reboot, HDMI-CEC from the PS5 and other apps can all replace it.
 *
 * ADB configuration (see README.md):
 *   am start -n com.ps5cafe.tvcompanion/.MainActivity --es url '<screen URL>'
 *   am start -n com.ps5cafe.tvcompanion/.MainActivity --es server <origin> --es station <id> --es key <key>
 * Optional extras: --ez setup true, --ez diagnostics true, --ez reset true, --ez boot_launch true|false,
 *   --ei overlay_test <seconds> (show the fake timer box, 1-300 s)
 *
 * When configured it also starts [TimerOverlayService], the informational remaining-time box.
 */
class MainActivity : Activity() {

    private enum class State { SUSPENDED, UNCONFIGURED, NO_WEBVIEW, LOADING, SHOWN, WAITING_RETRY }

    private val handler = Handler(Looper.getMainLooper())
    private val random = Random(System.nanoTime())

    private lateinit var store: ConfigStore
    private lateinit var root: FrameLayout
    private lateinit var webContainer: FrameLayout
    private lateinit var overlay: View
    private lateinit var overlayTitle: TextView
    private lateinit var overlayDetail: TextView
    private lateinit var overlayHint: TextView

    private var webView: WebView? = null
    /** Shows the PS5's HDMI input inside this app while a session runs (Android TV Input Framework). */
    private var tvView: TvView? = null
    /** The timer service asked for the PS5 (session ACTIVE) and has not asked for the screen page since. */
    private var ps5Wanted = false
    private var ps5Showing = false
    /** An input staff picked with the remote (HDMI 1-4); cleared when a session starts, ends or expires. */
    private var manualInputId: String? = null
    private var showingInputId: String? = null
    private var webViewError: String? = null
    private var config: ScreenConfig? = null
    private var state = State.SUSPENDED
    private var started = false

    /** URL currently shown or being loaded; null when unloaded. */
    private var loadedUrl: String? = null
    private var forceReload = false
    private var loadFailed = false
    private var failedAttempts = 0
    private var lastError = ""
    private var retryAtElapsed = 0L

    /** Set when the target URL must be loaded after an intermediate about:blank (see startLoad). */
    private var pendingAfterBlank: String? = null
    private var setupOpenedAutomatically = false

    private var watchdogPending = false
    private var watchdogMisses = 0

    private var backStreakStart = 0L
    private var backLastEvent = 0L
    private var backDown = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ConfigStore(this)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root = findViewById(R.id.main_root)
        webContainer = findViewById(R.id.web_container)
        overlay = findViewById(R.id.overlay)
        overlayTitle = findViewById(R.id.overlay_title)
        overlayDetail = findViewById(R.id.overlay_detail)
        overlayHint = findViewById(R.id.overlay_hint)

        // Lets chrome://inspect attach over ADB to debug the screen page on the real TV.
        // Only reachable by someone who already has ADB access to this TV.
        if (BuildConfig.DEBUG) {
            try {
                WebView.setWebContentsDebuggingEnabled(true)
            } catch (e: RuntimeException) {
                DiagLog.w("WebView debugging could not be enabled: $e")
            }
        }
        createWebView()
        DiagLog.i(
            "Screen activity created: app ${BuildConfig.VERSION_NAME}, ${Build.MANUFACTURER} ${Build.MODEL}, " +
                "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}).",
        )
        // After process death the system re-delivers the original intent; do not re-apply it.
        if (savedInstanceState == null) handleLaunchIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunchIntent(intent)
        // onResume follows and reloads the page if the configuration changed.
    }

    override fun onStart() {
        super.onStart()
        started = true
        TimerOverlayState.screenVisible = true
        webView?.onResume()
        DiagLog.i("Screen activity visible (onStart).")
    }

    override fun onResume() {
        super.onResume()
        applyImmersive()
        // Every request to switch arrives through an intent, and onResume always follows one: apply it here.
        if (ps5Wanted) {
            if (!showPs5(if (manualInputId != null) "chosen with the remote" else "session running")) ensureScreen()
        } else {
            if (ps5Showing) closePs5("session not running")
            ensureScreen()
        }
        handler.removeCallbacks(watchdogTick)
        handler.postDelayed(watchdogTick, WATCHDOG_INTERVAL_MS)
    }

    override fun onPause() {
        handler.removeCallbacks(watchdogTick)
        super.onPause()
    }

    override fun onStop() {
        super.onStop()
        started = false
        TimerOverlayState.screenVisible = false
        // Release the HDMI session when someone leaves the app; it is shown again on return if the session still runs.
        if (ps5Showing) closePs5("app left")
        suspendScreen()
    }

    // ---------------------------------------------------------------- PS5 input (TV Input Framework)

    /**
     * Shows the PS5's HDMI input full screen inside this app, so starting a session needs no input switching on the TV.
     * Software only: the TV's own remote or menus can still switch away. The page is unloaded meanwhile, so the server
     * never takes this for the screen page being visible; the timer box stays on top.
     */
    private fun showPs5(reason: String): Boolean {
        val inputId = manualInputId ?: Ps5Input.resolve(this, store.ps5Input)
        if (ps5Showing && inputId == showingInputId) return true
        if (inputId == null) {
            DiagLog.w("Cannot show the PS5 (ps5_input=${store.ps5Input ?: "off"}): no input configured, or no HDMI source connected.")
            ps5Wanted = false
            return false
        }
        val view = tvView ?: TvView(this).also { created ->
            created.setCallback(object : TvView.TvInputCallback() {
                override fun onConnectionFailed(inputId: String) {
                    DiagLog.w("PS5 input $inputId: connection failed. Showing the screen page instead.")
                    handler.post { ps5Wanted = false; closePs5("connection failed"); ensureScreen() }
                }
                override fun onDisconnected(inputId: String) { DiagLog.w("PS5 input $inputId: disconnected.") }
                override fun onVideoAvailable(inputId: String) { DiagLog.i("PS5 input $inputId: picture available.") }
                override fun onVideoUnavailable(inputId: String, reason: Int) { DiagLog.i("PS5 input $inputId: no picture (reason $reason).") }
            })
            // Above the page, below the "cannot reach the server" overlay.
            root.addView(created, 1, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            tvView = created
        }
        suspendScreen("the PS5 input is showing")
        overlay.visibility = View.GONE
        view.visibility = View.VISIBLE
        view.tune(inputId, TvContract.buildChannelUriForPassthroughInput(inputId))
        ps5Showing = true
        showingInputId = inputId
        TimerOverlayState.screenVisible = false
        TimerOverlayState.ps5Showing = true
        DiagLog.i("Showing the PS5 input $inputId ($reason). Software only: the TV's own controls can still switch away.")
        return true
    }

    private fun closePs5(reason: String) {
        tvView?.let { it.reset(); it.visibility = View.GONE }
        ps5Showing = false
        showingInputId = null
        TimerOverlayState.ps5Showing = false
        TimerOverlayState.screenVisible = started
        webView?.onResume()
        forceReload = true
        DiagLog.i("PS5 input closed ($reason).")
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        destroyWebView()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    // ---------------------------------------------------------------- configuration from intents

    private fun handleLaunchIntent(intent: Intent?) {
        if (intent == null) return
        if (intent.getBooleanExtra(EXTRA_FROM_BOOT, false)) {
            store.lastBootScreenShownAt = System.currentTimeMillis()
            DiagLog.i("Launch after boot reached the screen activity.")
        }
        if (intent.getBooleanExtra(EXTRA_RESET, false)) {
            TimerOverlayService.stop(this)
            store.clearConfig()
            forceReload = true
            setupOpenedAutomatically = false
            DiagLog.i("Configuration cleared by intent extra reset=true.")
        }
        if (intent.hasExtra(EXTRA_BOOT_LAUNCH)) {
            val enabled = intent.getBooleanExtra(EXTRA_BOOT_LAUNCH, true)
            store.bootLaunchEnabled = enabled
            DiagLog.i("Launch-after-boot set to $enabled by intent extra.")
        }

        val url = intent.getStringExtra(EXTRA_URL)
        val server = intent.getStringExtra(EXTRA_SERVER)
        val station = intent.getStringExtra(EXTRA_STATION)
        val key = intent.getStringExtra(EXTRA_KEY)
        val source = if (url != null) "ADB intent (url)" else "ADB intent (server/station/key)"
        val result = when {
            url != null -> ScreenConfigParser.fromScreenUrl(url)
            server != null || station != null || key != null ->
                ScreenConfigParser.fromParts(server, station, key)
            else -> null
        }
        when (result) {
            is ConfigResult.Valid -> {
                store.save(result.config, source)
                forceReload = true
                DiagLog.i("Configuration ACCEPTED from $source: ${result.config.redactedScreenUrl}")
                toast(getString(R.string.toast_config_saved, result.config.redactedScreenUrl))
            }
            is ConfigResult.Invalid -> {
                DiagLog.w("Configuration REJECTED from $source: ${result.reason}. Saved configuration unchanged.")
                toast(getString(R.string.toast_config_rejected, result.reason))
            }
            null -> Unit
        }

        if (intent.hasExtra(EXTRA_OVERLAY_TEST)) {
            val seconds = intent.getIntExtra(EXTRA_OVERLAY_TEST, TimerOverlayService.DEFAULT_TEST_SECONDS)
            TimerOverlayService.test(this, seconds, "intent extra overlay_test")
        }
        if (intent.hasExtra(EXTRA_PS5_INPUT)) {
            val value = intent.getStringExtra(EXTRA_PS5_INPUT)?.trim().orEmpty()
            store.ps5Input = if (value.isEmpty() || value == "off") null else value
            DiagLog.i("PS5 input set to ${store.ps5Input ?: "off"} by intent extra.")
        }
        // Sent by the timer service; applied in onResume, which always follows a new intent.
        if (intent.getBooleanExtra(EXTRA_SHOW_PS5, false)) { ps5Wanted = true; manualInputId = null }
        if (intent.getBooleanExtra(EXTRA_SHOW_SCREEN, false)) { ps5Wanted = false; manualInputId = null }
        // From the dashboard's remote (over ADB): show HDMI 1-4 here, or APP for the screen page.
        intent.getStringExtra(EXTRA_SHOW_INPUT)?.let { requested ->
            val number = Regex("^HDMI([1-4])$").find(requested)?.groupValues?.get(1)?.toInt()
            when {
                requested == "APP" -> { ps5Wanted = false; manualInputId = null; DiagLog.i("Remote: show the screen page.") }
                number != null -> {
                    val id = Ps5Input.hdmi(this, number)
                    if (id == null) DiagLog.w("Remote asked for HDMI $number, but this TV has no such input.")
                    else { manualInputId = id; ps5Wanted = true; DiagLog.i("Remote: show HDMI $number ($id).") }
                }
                else -> DiagLog.w("Remote asked for an unknown input: $requested")
            }
        }
        if (intent.getBooleanExtra(EXTRA_SETUP, false)) openSetup()
        if (intent.getBooleanExtra(EXTRA_DIAGNOSTICS, false)) openDiagnostics()
    }

    // ---------------------------------------------------------------- loading state machine

    private fun ensureScreen() {
        // Creation can fail while the WebView provider is being updated; try again on each resume.
        if (webView == null) createWebView()
        val wv = webView
        if (wv == null) {
            state = State.NO_WEBVIEW
            showOverlay(
                getString(R.string.overlay_no_webview_title),
                getString(R.string.overlay_no_webview_detail, webViewError ?: "unknown"),
                getString(R.string.overlay_setup_hint),
            )
            return
        }
        val cfg = store.load()
        config = cfg
        if (cfg == null) {
            cancelPending()
            if (state != State.UNCONFIGURED) {
                DiagLog.w("No valid configuration is saved. Showing the not-configured message.")
                wv.loadUrl(BLANK)
            }
            state = State.UNCONFIGURED
            loadedUrl = null
            showOverlay(
                getString(R.string.overlay_unconfigured_title),
                getString(R.string.overlay_unconfigured_detail),
                getString(R.string.overlay_setup_hint),
            )
            if (!setupOpenedAutomatically) openSetup()
            return
        }
        // Idempotent: keeps the remaining-time overlay service running while this TV is configured.
        TimerOverlayService.start(this, "screen activity")
        val busy = state == State.LOADING || state == State.SHOWN || state == State.WAITING_RETRY
        if (!forceReload && busy && loadedUrl == cfg.screenUrl) return
        forceReload = false
        failedAttempts = 0
        startLoad(cfg)
    }

    private fun startLoad(cfg: ScreenConfig) {
        val wv = webView ?: return
        cancelPending()
        state = State.LOADING
        loadFailed = false
        loadedUrl = cfg.screenUrl
        watchdogPending = false
        watchdogMisses = 0
        if (failedAttempts > 0) {
            showOverlay(getString(R.string.overlay_connecting_title), detailText(cfg), getString(R.string.overlay_retry_hint))
        }
        DiagLog.i(
            "Loading ${cfg.redactedScreenUrl}" +
                if (failedAttempts > 0) " (retry after $failedAttempts failed attempts)" else "",
        )
        // A URL that differs only after '#' from the current document is a same-document
        // navigation and would not reload the page. Go through about:blank to force a real load.
        val current = wv.url
        if (current != null && current != BLANK && current.substringBefore('#') == cfg.screenUrl.substringBefore('#')) {
            pendingAfterBlank = cfg.screenUrl
            wv.loadUrl(BLANK)
        } else {
            wv.loadUrl(cfg.screenUrl)
        }
        handler.postDelayed(loadTimeout, LOAD_TIMEOUT_MS)
    }

    private fun onLoadFailed(reason: String) {
        if (state != State.LOADING || loadFailed) return
        val cfg = config ?: return
        loadFailed = true
        pendingAfterBlank = null
        handler.removeCallbacks(loadTimeout)
        failedAttempts++
        lastError = reason
        val delay = RetryPolicy.delayMs(failedAttempts, random)
        retryAtElapsed = SystemClock.elapsedRealtime() + delay
        state = State.WAITING_RETRY
        DiagLog.w(
            "Cannot reach the server ${cfg.serverOrigin} (station ${cfg.stationId}): $reason. " +
                "Failed attempts: $failedAttempts. Next retry in $delay ms.",
        )
        handler.postDelayed(retryNow, delay)
        updateCountdown()
    }

    private fun onLoadSucceeded() {
        handler.removeCallbacks(loadTimeout)
        state = State.SHOWN
        DiagLog.i(
            if (failedAttempts > 0) "Screen page loaded after $failedAttempts failed attempts." else "Screen page loaded.",
        )
        failedAttempts = 0
        hideOverlay()
    }

    private fun suspendScreen(reason: String = "another app or TV input is in front") {
        cancelPending()
        val wv = webView
        if (wv != null) {
            state = State.SUSPENDED
            loadedUrl = null
            // Unload the page so ad video releases its hardware decoder before HDMI gameplay.
            wv.stopLoading()
            wv.loadUrl(BLANK)
            wv.onPause()
        }
        DiagLog.i("Screen page unloaded: $reason.")
    }

    private fun cancelPending() {
        handler.removeCallbacks(retryNow)
        handler.removeCallbacks(countdownTick)
        handler.removeCallbacks(loadTimeout)
        pendingAfterBlank = null
    }

    private val retryNow = Runnable {
        if (state == State.WAITING_RETRY) config?.let { startLoad(it) }
    }

    private val loadTimeout = Runnable {
        if (state == State.LOADING && !loadFailed) {
            onLoadFailed("no response within ${LOAD_TIMEOUT_MS / 1000} s")
            webView?.stopLoading()
        }
    }

    private val countdownTick = Runnable { updateCountdown() }

    private fun updateCountdown() {
        handler.removeCallbacks(countdownTick)
        if (state != State.WAITING_RETRY) return
        val cfg = config ?: return
        val remainingMs = (retryAtElapsed - SystemClock.elapsedRealtime()).coerceAtLeast(0L)
        val seconds = ((remainingMs + 999L) / 1000L).toInt()
        showOverlay(getString(R.string.overlay_retry_title, seconds), detailText(cfg), getString(R.string.overlay_retry_hint))
        if (remainingMs > 0L) {
            val untilNextSecond = remainingMs % 1000L
            handler.postDelayed(countdownTick, if (untilNextSecond == 0L) 1000L else untilNextSecond)
        }
    }

    private fun detailText(cfg: ScreenConfig): String =
        getString(R.string.overlay_retry_detail, cfg.serverOrigin, cfg.stationId, failedAttempts, lastError.ifEmpty { "-" })

    /**
     * Optional watchdog: every 30 s the page must answer a trivial JavaScript call. Two missed
     * intervals (about a minute of a frozen page) recreate the WebView and reload.
     */
    private val watchdogTick: Runnable = object : Runnable {
        override fun run() {
            handler.postDelayed(this, WATCHDOG_INTERVAL_MS)
            val wv = webView ?: return
            if (state != State.SHOWN) {
                watchdogPending = false
                watchdogMisses = 0
                return
            }
            if (watchdogPending) {
                watchdogMisses++
                if (watchdogMisses >= WATCHDOG_MAX_MISSES) {
                    watchdogPending = false
                    watchdogMisses = 0
                    restartRenderer(wv, "page did not answer a JavaScript ping for about ${WATCHDOG_INTERVAL_MS * WATCHDOG_MAX_MISSES / 1000} s")
                }
                return
            }
            watchdogPending = true
            wv.evaluateJavascript("1") {
                if (wv === webView) {
                    watchdogPending = false
                    watchdogMisses = 0
                }
            }
        }
    }

    private fun restartRenderer(wv: WebView, reason: String) {
        DiagLog.w("Watchdog: $reason.")
        // On API 29+ a hung renderer can be killed; onRenderProcessGone then recreates the WebView.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val killed = try {
                wv.webViewRenderProcess?.terminate() == true
            } catch (e: RuntimeException) {
                false
            }
            if (killed) return
        }
        recreateWebView("watchdog")
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled") // The screen page is a JavaScript app served by our own LAN server.
    private fun createWebView() {
        val wv = try {
            WebView(this)
        } catch (e: Exception) {
            webViewError = e.toString()
            DiagLog.w("WebView could not be created: $e")
            return
        } catch (e: LinkageError) {
            webViewError = e.toString()
            DiagLog.w("WebView could not be created: $e")
            return
        }
        webViewError = null
        with(wv.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false // advertising video autoplays
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString PS5CafeTvCompanion/${BuildConfig.VERSION_NAME}"
        }
        wv.setBackgroundColor(Color.BLACK)
        wv.isFocusable = true
        wv.isFocusableInTouchMode = true
        wv.isVerticalScrollBarEnabled = false
        wv.isHorizontalScrollBarEnabled = false
        wv.overScrollMode = View.OVER_SCROLL_NEVER
        wv.setDownloadListener { _, _, _, _, _ -> DiagLog.w("Ignored a download request from the page.") }
        wv.webViewClient = ScreenClient()
        wv.webChromeClient = ScreenChromeClient()
        webContainer.addView(
            wv,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        webView = wv
        if (overlay.visibility != View.VISIBLE) wv.requestFocus()
    }

    private fun destroyWebView() {
        val wv = webView ?: return
        webView = null
        webContainer.removeView(wv)
        wv.destroy()
    }

    private fun recreateWebView(reason: String) {
        DiagLog.w("Recreating the WebView ($reason).")
        cancelPending()
        destroyWebView()
        createWebView()
        state = State.SUSPENDED
        loadedUrl = null
        if (started) ensureScreen()
    }

    private fun isAllowedNavigation(url: String): Boolean {
        if (url == BLANK) return true
        val cfg = config ?: return false
        if (ScreenConfigParser.isSameOrigin(cfg.serverOrigin, url)) return true
        DiagLog.w("Blocked navigation outside ${cfg.serverOrigin}: ${url.substringBefore('?').take(120)}")
        return false
    }

    private inner class ScreenClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            !isAllowedNavigation(request.url?.toString().orEmpty())

        // API 23 WebViews only call the String variant.
        @Deprecated("Deprecated in Java")
        override fun shouldOverrideUrlLoading(view: WebView, url: String?): Boolean =
            !isAllowedNavigation(url.orEmpty())

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (view !== webView || url == null || url == BLANK) return
            if (state == State.SHOWN) {
                // The page navigated by itself (for example location.reload()); track it like our own load.
                state = State.LOADING
                loadFailed = false
                handler.removeCallbacks(loadTimeout)
                handler.postDelayed(loadTimeout, LOAD_TIMEOUT_MS)
            }
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (view !== webView) return
            if (url == BLANK) {
                val next = pendingAfterBlank
                if (next != null && state == State.LOADING) {
                    pendingAfterBlank = null
                    view.loadUrl(next)
                }
                return
            }
            if (state == State.LOADING && !loadFailed && pendingAfterBlank == null) onLoadSucceeded()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (view !== webView || !request.isForMainFrame) return
            onLoadFailed("${error.description} (error ${error.errorCode})")
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            if (view !== webView || !request.isForMainFrame) return
            onLoadFailed("HTTP ${errorResponse.statusCode} ${errorResponse.reasonPhrase.orEmpty()}".trim())
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel() // never proceed past a certificate error
            if (view !== webView) return
            val cfg = config ?: return
            if (ScreenConfigParser.isSameOrigin(cfg.serverOrigin, error.url.orEmpty())) {
                onLoadFailed("TLS certificate rejected (SslError ${error.primaryError})")
            }
        }

        // Only ever called on API 26+, where RenderProcessGoneDetail exists.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === webView) {
                val crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail.didCrash()
                recreateWebView(if (crashed) "renderer crashed" else "renderer was stopped by the system")
            }
            return true
        }
    }

    private inner class ScreenChromeClient : WebChromeClient() {
        override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
            if (consoleMessage.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                android.util.Log.w(
                    WEB_TAG,
                    "${consoleMessage.message()} (${consoleMessage.sourceId()}:${consoleMessage.lineNumber()})",
                )
            }
            return true
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            request.deny() // no camera or microphone
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }

        // Kiosk: a JavaScript dialog would freeze the screen until someone presses OK.
        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            DiagLog.w("Suppressed a JavaScript alert from the page.")
            result.confirm()
            return true
        }

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            DiagLog.w("Suppressed a JavaScript confirm dialog from the page (answered Cancel).")
            result.cancel()
            return true
        }

        override fun onJsPrompt(
            view: WebView,
            url: String?,
            message: String?,
            defaultValue: String?,
            result: JsPromptResult,
        ): Boolean {
            DiagLog.w("Suppressed a JavaScript prompt from the page (answered Cancel).")
            result.cancel()
            return true
        }

        override fun onJsBeforeUnload(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            result.confirm()
            return true
        }

        // Avoid the grey play-button placeholder some TVs draw before a video's first frame.
        override fun getDefaultVideoPoster(): Bitmap? = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    }

    // ---------------------------------------------------------------- keys (kiosk-style BACK)

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        when (event.keyCode) {
            KeyEvent.KEYCODE_BACK -> {
                onBackKey(event)
                return true // a short BACK press is ignored on purpose; this is not a security boundary
            }
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER,
            KeyEvent.KEYCODE_BUTTON_A,
            -> if (overlay.visibility == View.VISIBLE) {
                if (event.action == KeyEvent.ACTION_UP) onOverlayConfirm()
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /**
     * Holding BACK for about 3 s opens setup. Remotes either auto-repeat ACTION_DOWN while held or
     * send rapid DOWN/UP pairs, so a "hold" is any stream of BACK events with gaps under 500 ms.
     */
    private fun onBackKey(event: KeyEvent) {
        val now = SystemClock.uptimeMillis()
        when (event.action) {
            KeyEvent.ACTION_DOWN -> {
                if (backStreakStart == 0L || now - backLastEvent > BACK_GAP_MS) {
                    backStreakStart = now
                    handler.removeCallbacks(backHoldCheck)
                    handler.postDelayed(backHoldCheck, BACK_HOLD_MS)
                }
                backDown = true
                backLastEvent = now
            }
            KeyEvent.ACTION_UP -> {
                backDown = false
                backLastEvent = now
            }
        }
    }

    private val backHoldCheck = Runnable {
        val now = SystemClock.uptimeMillis()
        val stillHeld = backDown || now - backLastEvent <= BACK_GAP_MS
        backStreakStart = 0L
        backDown = false
        if (stillHeld) {
            DiagLog.i("BACK held for ${BACK_HOLD_MS / 1000} s: opening setup.")
            openSetup(openedByBackHold = true)
        }
    }

    private fun onOverlayConfirm() {
        when (state) {
            State.WAITING_RETRY -> {
                DiagLog.i("Retry requested with OK.")
                config?.let { startLoad(it) }
            }
            State.UNCONFIGURED, State.NO_WEBVIEW -> openSetup()
            else -> Unit
        }
    }

    // ---------------------------------------------------------------- helpers

    private fun openSetup(openedByBackHold: Boolean = false) {
        setupOpenedAutomatically = true
        startActivity(
            Intent(this, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_OPENED_BY_BACK_HOLD, openedByBackHold),
        )
    }

    private fun openDiagnostics() {
        // Diagnostics may run before the TV is configured; do not stack setup on top of it.
        setupOpenedAutomatically = true
        startActivity(Intent(this, DiagnosticsActivity::class.java))
    }

    private fun showOverlay(title: String, detail: String, hint: String) {
        overlayTitle.text = title
        overlayDetail.text = detail
        overlayHint.text = hint
        if (overlay.visibility != View.VISIBLE) {
            overlay.visibility = View.VISIBLE
            overlay.bringToFront()
        }
    }

    private fun hideOverlay() {
        if (overlay.visibility != View.GONE) overlay.visibility = View.GONE
        webView?.requestFocus()
    }

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_LONG).show()
    }

    private fun applyImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Deprecated in API 35 (edge-to-edge is then the default) but still needed on API 30-34.
            @Suppress("DEPRECATION")
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                )
        }
    }

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_SERVER = "server"
        const val EXTRA_STATION = "station"
        const val EXTRA_KEY = "key"
        const val EXTRA_SETUP = "setup"
        const val EXTRA_DIAGNOSTICS = "diagnostics"
        const val EXTRA_RESET = "reset"
        const val EXTRA_BOOT_LAUNCH = "boot_launch"
        const val EXTRA_OVERLAY_TEST = "overlay_test"
        /** `--es ps5_input auto|<TV input id>|off`: which input the app shows while a session runs. */
        const val EXTRA_PS5_INPUT = "ps5_input"
        const val EXTRA_SHOW_PS5 = "show_ps5"
        const val EXTRA_SHOW_SCREEN = "show_screen"
        /** `--es show_input HDMI1..HDMI4|APP`, sent by the dashboard's remote. */
        const val EXTRA_SHOW_INPUT = "show_input"
        const val EXTRA_FROM_BOOT = "com.ps5cafe.tvcompanion.extra.FROM_BOOT"

        private const val BLANK = "about:blank"
        private const val WEB_TAG = "PS5CafeWeb"
        private const val LOAD_TIMEOUT_MS = 30_000L
        private const val WATCHDOG_INTERVAL_MS = 30_000L
        private const val WATCHDOG_MAX_MISSES = 2
        private const val BACK_HOLD_MS = 3_000L
        private const val BACK_GAP_MS = 500L
    }
}

package com.ps5cafe.tvcompanion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONException
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/** Process-wide status for the Diagnostics screen. Written by the service, read by activities. */
object TimerOverlayState {
    @Volatile var running = false
    @Volatile var lastPollAt = 0L
    @Volatile var lastPollResult: String? = null
    @Volatile var overlayShowing = false
    /** The screen page (MainActivity) is on screen; it shows the time itself, so the box stays out of the way. */
    @Volatile var screenVisible = false
    /** MainActivity is showing the PS5 input itself. */
    @Volatile var ps5Showing = false
    @Volatile var lastStartError: String? = null
}

/**
 * Shows the remaining session time in a small box in the top-right corner while the TV shows the
 * PS5 input, and a red "Time's up" once the session runs out. When the session expires or staff end
 * it, it brings the screen page back to the front once. Informational only: it is not a lock, it
 * never takes remote/D-pad focus, and a reboot, force-stop or revoked "Display over other apps"
 * permission removes it.
 *
 * Polls `GET <origin>/api/screen/<station>?k=<key>` every 5 s (3 s timeouts), extrapolates the
 * countdown locally between polls, and hides the box after 30 s without a successful poll so it
 * never shows a stale time. Whether a TYPE_APPLICATION_OVERLAY window is drawn above the HDMI
 * picture is model-specific and must be checked on each physical TV.
 */
class TimerOverlayService : Service() {

    private sealed interface PollOutcome {
        data class Success(val sample: StatusSample, val receivedElapsed: Long) : PollOutcome
        data class Failure(val reason: String, val dropSample: Boolean) : PollOutcome
        data object NotConfigured : PollOutcome
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var store: ConfigStore
    private lateinit var windowManager: WindowManager
    private var executor: ScheduledExecutorService? = null

    private var sample: StatusSample? = null
    private var lastSuccessElapsed = 0L
    private var testStartedElapsed = 0L
    private var testUntilElapsed = 0L

    private var overlayRoot: LinearLayout? = null
    private var captionView: TextView? = null
    private var timeView: TextView? = null
    private var background: GradientDrawable? = null
    private var shownLevel: CountdownLevel? = null
    private var overlayAttached = false

    private var lastLoggedPoll: String? = null
    private var destroyed = false
    private var permissionWasGranted: Boolean? = null
    private var addFailureLogged = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        store = ConfigStore(this)
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        TimerOverlayState.running = true
        DiagLog.i("Timer overlay service created.")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Must come first: a service started with startForegroundService() has to call it promptly.
        if (!enterForeground()) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_TEST) {
            val seconds = intent.getIntExtra(EXTRA_TEST_SECONDS, DEFAULT_TEST_SECONDS).coerceIn(1, MAX_TEST_SECONDS)
            val now = SystemClock.elapsedRealtime()
            testStartedElapsed = now
            testUntilElapsed = now + seconds * 1000L
            DiagLog.i(
                "Overlay test started for $seconds s with a fake ${SessionCountdown.format(TEST_REMAINING_MS)}. " +
                    "Switch the TV to the PS5 input now and look at the top-right corner.",
            )
        }
        if (store.load() == null && !isTestActive(SystemClock.elapsedRealtime())) {
            DiagLog.i("Timer overlay service: this TV is not configured; stopping.")
            stopSelf()
            return START_NOT_STICKY
        }
        startPolling()
        main.removeCallbacks(tick)
        main.post(tick)
        return START_STICKY
    }

    override fun onDestroy() {
        destroyed = true
        executor?.shutdownNow()
        executor = null
        main.removeCallbacksAndMessages(null)
        removeOverlay("service stopped")
        TimerOverlayState.running = false
        TimerOverlayState.overlayShowing = false
        DiagLog.i("Timer overlay service stopped.")
        super.onDestroy()
    }

    // ---------------------------------------------------------------- foreground notification

    private fun enterForeground(): Boolean = try {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        true
    } catch (e: RuntimeException) {
        TimerOverlayState.lastStartError = e.toString()
        DiagLog.w("Timer overlay service could not enter the foreground: $e")
        false
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.timer_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.timer_channel_description)
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
        }
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return builder
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.timer_notification_title))
            .setContentText(getString(R.string.timer_notification_text))
            .setOngoing(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setContentIntent(open)
            .build()
    }

    // ---------------------------------------------------------------- polling (worker thread)

    private fun startPolling() {
        if (executor != null) return
        val ex = Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "ps5cafe-timer-poll").apply { isDaemon = true }
        }
        executor = ex
        ex.scheduleWithFixedDelay({ pollOnce() }, 0L, POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    /** Runs on the poll thread. Never throws: an exception would cancel all later polls. */
    private fun pollOnce() {
        val outcome = try {
            val cfg = store.load()
            if (cfg == null) PollOutcome.NotConfigured else fetch(cfg)
        } catch (e: Exception) {
            PollOutcome.Failure("${e.javaClass.simpleName}: ${e.message}", dropSample = false)
        }
        main.post { onPollResult(outcome) }
    }

    private fun fetch(cfg: ScreenConfig): PollOutcome {
        val sentAt = SystemClock.elapsedRealtime()
        val connection = URL(cfg.statusUrl).openConnection() as HttpURLConnection
        return try {
            connection.connectTimeout = HTTP_TIMEOUT_MS
            connection.readTimeout = HTTP_TIMEOUT_MS
            connection.instanceFollowRedirects = false // never leave the configured origin
            connection.useCaches = false
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept", "application/json")
            // Distinct from the WebView's user agent, for server logs. The `overlay=1` in the status URL
            // is what stops these polls from refreshing the station's "screen seen" time.
            connection.setRequestProperty("User-Agent", "PS5CafeTvCompanion/${BuildConfig.VERSION_NAME} (timer-overlay)")
            when (val code = connection.responseCode) {
                200 -> {
                    val body = connection.inputStream.use { readCapped(it) }
                    val receivedAt = SystemClock.elapsedRealtime()
                    val status = ScreenStatusParser.parse(body)
                    PollOutcome.Success(StatusSample(status, sentAt + (receivedAt - sentAt) / 2), receivedAt)
                }
                // Wrong key or unknown station: the server will not vouch for any time, so hide now.
                403 -> PollOutcome.Failure("HTTP 403: wrong screen key for ${cfg.stationId}", dropSample = true)
                404 -> PollOutcome.Failure("HTTP 404: server does not know station ${cfg.stationId}", dropSample = true)
                else -> PollOutcome.Failure("HTTP $code", dropSample = false)
            }
        } catch (e: JSONException) {
            PollOutcome.Failure("unexpected response body: ${e.message}", dropSample = false)
        } catch (e: IOException) {
            PollOutcome.Failure("${e.javaClass.simpleName}: ${e.message}", dropSample = false)
        } finally {
            connection.disconnect()
        }
    }

    private fun readCapped(input: InputStream): String {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            out.write(buffer, 0, n)
            if (out.size() > MAX_BODY_BYTES) throw IOException("response larger than $MAX_BODY_BYTES bytes")
        }
        return out.toString("UTF-8")
    }

    // ---------------------------------------------------------------- results and rendering (main thread)

    private fun onPollResult(outcome: PollOutcome) {
        // A poll that was in flight during onDestroy must not re-add the window.
        if (destroyed) return
        val summary: String
        val logKey: String
        when (outcome) {
            is PollOutcome.Success -> {
                val previous = sample?.status?.sessionStatus
                val current = outcome.sample.status.sessionStatus
                SessionCountdown.screenShouldReturn(previous, current)?.let(::bringScreenToFront)
                if (store.ps5Input != null && SessionCountdown.ps5ShouldShow(previous, current)) showPs5()
                sample = outcome.sample
                lastSuccessElapsed = outcome.receivedElapsed
                val s = outcome.sample.status
                summary = "OK: session ${s.sessionStatus}, mode ${s.mode}, remaining ${SessionCountdown.format(s.remainingMs)}"
                logKey = "OK ${s.sessionStatus}"
            }
            is PollOutcome.Failure -> {
                if (outcome.dropSample) sample = null
                summary = "FAILED: ${outcome.reason}"
                logKey = summary
            }
            PollOutcome.NotConfigured -> {
                sample = null
                summary = "not configured"
                logKey = summary
                if (!isTestActive(SystemClock.elapsedRealtime())) {
                    DiagLog.i("Timer overlay service: configuration was cleared; stopping.")
                    stopSelf()
                }
            }
        }
        TimerOverlayState.lastPollAt = System.currentTimeMillis()
        TimerOverlayState.lastPollResult = summary
        if (logKey != lastLoggedPoll) {
            lastLoggedPoll = logKey
            DiagLog.i("Timer poll $summary")
        }
        render()
    }

    private val tick: Runnable = object : Runnable {
        override fun run() {
            render()
            main.postDelayed(this, if (overlayAttached) VISIBLE_TICK_MS else HIDDEN_TICK_MS)
        }
    }

    private fun isTestActive(now: Long) = testUntilElapsed != 0L && now < testUntilElapsed

    private fun render() {
        if (destroyed) return
        val now = SystemClock.elapsedRealtime()
        if (testUntilElapsed != 0L && !isTestActive(now)) {
            testUntilElapsed = 0L
            DiagLog.i("Overlay test finished.")
            if (store.load() == null) {
                removeOverlay("test finished")
                stopSelf()
                return
            }
        }
        val view = if (isTestActive(now)) {
            val remaining = (TEST_REMAINING_MS - (now - testStartedElapsed)).coerceAtLeast(0L)
            CountdownView(
                visible = true,
                remainingMs = remaining,
                text = SessionCountdown.format(remaining),
                level = SessionCountdown.levelFor(remaining),
            )
        } else {
            SessionCountdown.compute(sample, lastSuccessElapsed, now)
        }
        when {
            !view.visible -> removeOverlay(view.hiddenReason)
            TimerOverlayState.screenVisible && !isTestActive(now) -> removeOverlay("the screen page is showing")
            else -> showOverlay(view)
        }
    }

    /**
     * Brings the screen page in front of the PS5 picture. Starting an activity from the background is allowed because the
     * app may draw over other apps (the same grant the box needs). Not a lock: the customer can switch back with the remote,
     * and the dashboard then shows the expired screen as not showing.
     */
    /** A session became ACTIVE: have the app show the PS5 input (it falls back to the page if it cannot). */
    private fun showPs5() {
        try {
            startActivity(
                Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    .putExtra(MainActivity.EXTRA_SHOW_PS5, true),
            )
            DiagLog.i("Session running: asking the app to show the PS5 input.")
        } catch (e: RuntimeException) {
            DiagLog.w("Could not bring the app forward to show the PS5 input: $e")
        }
    }

    private fun bringScreenToFront(reason: String) {
        if (TimerOverlayState.screenVisible) return
        try {
            startActivity(
                Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    .putExtra(MainActivity.EXTRA_SHOW_SCREEN, true),
            )
            DiagLog.i("Bringing the screen page to the front: $reason (software only).")
        } catch (e: RuntimeException) {
            DiagLog.w("Could not bring the screen page to the front ($reason): $e")
        }
    }

    private fun showOverlay(view: CountdownView) {
        val granted = Settings.canDrawOverlays(this)
        if (granted != permissionWasGranted) {
            permissionWasGranted = granted
            if (!granted) {
                DiagLog.w(
                    "Cannot show the timer overlay: 'Display over other apps' is not granted. Grant it with: " +
                        "adb shell appops set $packageName SYSTEM_ALERT_WINDOW allow",
                )
            } else {
                DiagLog.i("'Display over other apps' is granted.")
            }
        }
        if (!granted) {
            removeOverlay("permission not granted")
            return
        }
        ensureViews()
        applyView(view)
        if (!overlayAttached) {
            try {
                windowManager.addView(overlayRoot, overlayLayoutParams())
                overlayAttached = true
                addFailureLogged = false
                DiagLog.i("Timer overlay shown (${if (view.expired) "time's up" else view.text}${if (view.paused) ", paused" else ""}).")
            } catch (e: RuntimeException) {
                if (!addFailureLogged) {
                    addFailureLogged = true
                    DiagLog.w("Timer overlay could not be added to the screen: $e")
                }
            }
        }
        TimerOverlayState.overlayShowing = overlayAttached
    }

    private fun removeOverlay(reason: String) {
        if (overlayAttached) {
            overlayAttached = false
            try {
                windowManager.removeViewImmediate(overlayRoot)
            } catch (e: RuntimeException) {
                // Already removed by the system (for example the permission was revoked).
            }
            DiagLog.i("Timer overlay hidden: $reason.")
        }
        TimerOverlayState.overlayShowing = false
    }

    private fun ensureViews() {
        if (overlayRoot != null) return
        val bg = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat()
            setColor(getColor(R.color.timer_bg_normal))
        }
        val caption = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            gravity = Gravity.END
        }
        val time = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
            typeface = Typeface.create("sans-serif", Typeface.BOLD)
            fontFeatureSettings = "tnum" // tabular digits: the box does not jitter every second
            gravity = Gravity.END
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = bg
            setPadding(dp(16), dp(8), dp(16), dp(10))
            addView(caption, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(time, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        overlayRoot = root
        captionView = caption
        timeView = time
        background = bg
        shownLevel = null
    }

    private fun applyView(view: CountdownView) {
        val time = timeView ?: return
        val caption = captionView ?: return
        val timeText = if (view.expired) getString(R.string.timer_expired) else view.text
        if (time.text.toString() != timeText) time.text = timeText
        val captionText = getString(when {
            view.expired -> R.string.timer_expired_caption
            view.paused -> R.string.timer_paused
            else -> R.string.timer_time_left
        })
        if (caption.text.toString() != captionText) caption.text = captionText
        if (shownLevel != view.level) {
            shownLevel = view.level
            val (bgColor, fgColor) = when (view.level) {
                CountdownLevel.NORMAL -> R.color.timer_bg_normal to R.color.timer_fg_normal
                CountdownLevel.WARNING -> R.color.timer_bg_warning to R.color.timer_fg_warning
                CountdownLevel.CRITICAL -> R.color.timer_bg_critical to R.color.timer_fg_critical
            }
            background?.setColor(getColor(bgColor))
            time.setTextColor(getColor(fgColor))
            caption.setTextColor(getColor(fgColor))
        }
    }

    private fun overlayLayoutParams(): WindowManager.LayoutParams {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        return WindowManager.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            type,
            // Never focusable or touchable: the game keeps every remote/controller key.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = dp(MARGIN_DP)
            y = dp(MARGIN_DP)
            title = "PS5 Cafe session timer"
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

    companion object {
        const val ACTION_START = "com.ps5cafe.tvcompanion.action.START_TIMER"
        const val ACTION_TEST = "com.ps5cafe.tvcompanion.action.TEST_OVERLAY"
        const val EXTRA_TEST_SECONDS = "com.ps5cafe.tvcompanion.extra.TEST_SECONDS"
        const val DEFAULT_TEST_SECONDS = 10
        const val MAX_TEST_SECONDS = 300

        private const val CHANNEL_ID = "session_timer"
        private const val NOTIFICATION_ID = 1001
        private const val POLL_INTERVAL_MS = 5_000L
        private const val HTTP_TIMEOUT_MS = 3_000
        private const val MAX_BODY_BYTES = 64 * 1024
        private const val VISIBLE_TICK_MS = 500L
        private const val HIDDEN_TICK_MS = 1_000L
        private const val TEST_REMAINING_MS = 9 * 60_000L + 59_000L
        private const val MARGIN_DP = 16

        /** Starts (or refreshes) the service. Safe to call repeatedly; returns false if Android refused. */
        fun start(context: Context, source: String): Boolean =
            send(context, Intent(context, TimerOverlayService::class.java).setAction(ACTION_START), source)

        fun test(context: Context, seconds: Int, source: String): Boolean =
            send(
                context,
                Intent(context, TimerOverlayService::class.java)
                    .setAction(ACTION_TEST)
                    .putExtra(EXTRA_TEST_SECONDS, seconds),
                source,
            )

        fun stop(context: Context) {
            context.stopService(Intent(context, TimerOverlayService::class.java))
        }

        private fun send(context: Context, intent: Intent, source: String): Boolean = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            TimerOverlayState.lastStartError = null
            true
        } catch (e: RuntimeException) {
            // For example ForegroundServiceStartNotAllowedException when started from the background.
            TimerOverlayState.lastStartError = "$source: $e"
            DiagLog.w("Timer overlay service could not be started from $source: $e")
            false
        }
    }
}

package com.ps5cafe.tvcompanion

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.media.tv.TvContract
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * Physical-test screen. Shows device/WebView/TV-input facts and lets the tester fire the public
 * passthrough-input VIEW intent for each HDMI input. The app cannot see the picture, so every
 * result here is "request accepted or rejected", never "the TV switched".
 */
class DiagnosticsActivity : Activity() {

    private lateinit var store: ConfigStore
    private lateinit var reportView: TextView
    private lateinit var resultView: TextView
    private lateinit var overlayStatusView: TextView
    private lateinit var inputsContainer: LinearLayout
    private var lastReport: DiagnosticsReport? = null

    /** Input id and elapsedRealtime of the last switch request, to time when this screen was hidden. */
    private var pendingSwitchId: String? = null
    private var pendingSwitchAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_diagnostics)
        store = ConfigStore(this)
        reportView = findViewById(R.id.diag_report)
        resultView = findViewById(R.id.diag_switch_result)
        overlayStatusView = findViewById(R.id.diag_overlay_status)
        inputsContainer = findViewById(R.id.diag_inputs)

        findViewById<Button>(R.id.diag_log).setOnClickListener {
            writeReportToLog()
            Toast.makeText(this, R.string.diag_logged_toast, Toast.LENGTH_LONG).show()
        }
        findViewById<Button>(R.id.diag_refresh).setOnClickListener { refresh(log = false) }
        findViewById<Button>(R.id.diag_back).setOnClickListener { finish() }
        findViewById<Button>(R.id.diag_test_overlay).setOnClickListener { testOverlay() }

        refresh(log = savedInstanceState == null)
        findViewById<Button>(R.id.diag_log).requestFocus()
    }

    override fun onStart() {
        super.onStart()
        showLastSwitch()
        showOverlayStatus()
    }

    override fun onStop() {
        super.onStop()
        val id = pendingSwitchId ?: return
        val hiddenAfter = SystemClock.elapsedRealtime() - pendingSwitchAt
        pendingSwitchId = null
        if (hiddenAfter <= SWITCH_WATCH_MS) {
            val note = "Diagnostics screen was hidden $hiddenAfter ms after the switch request for $id. " +
                "Something else came to the front; the app cannot see what. Check the TV picture."
            appendSwitchNote(note)
            DiagLog.i(note)
        }
    }

    private fun refresh(log: Boolean) {
        val report = DiagnosticsCollector.collect(this, store)
        lastReport = report
        reportView.text = report.text
        renderInputs(report)
        showLastSwitch()
        showOverlayStatus()
        if (log) writeReportToLog()
    }

    /**
     * Shows the timer box with a fake 0:09:59 for 10 s so the tester can switch to the PS5 input
     * and see whether this TV draws app overlays on top of the HDMI picture.
     */
    private fun testOverlay() {
        if (!Settings.canDrawOverlays(this)) {
            DiagLog.w(
                "Overlay test not started: 'Display over other apps' is not granted. " +
                    "Run: adb shell appops set $packageName SYSTEM_ALERT_WINDOW allow",
            )
            Toast.makeText(this, R.string.diag_overlay_test_refused, Toast.LENGTH_LONG).show()
            showOverlayStatus()
            return
        }
        val started = TimerOverlayService.test(this, TimerOverlayService.DEFAULT_TEST_SECONDS, "diagnostics button")
        Toast.makeText(
            this,
            if (started) R.string.diag_overlay_test_started else R.string.diag_overlay_test_refused,
            Toast.LENGTH_LONG,
        ).show()
        showOverlayStatus()
    }

    private fun showOverlayStatus() {
        val service = buildString {
            append("Timer service: ").append(if (TimerOverlayState.running) "running" else "not running")
            TimerOverlayState.lastPollResult?.let {
                append("; last poll ")
                append(DiagnosticsCollector.formatTime(TimerOverlayState.lastPollAt))
                append(" ").append(it)
            }
            append("; box showing now: ").append(TimerOverlayState.overlayShowing)
            TimerOverlayState.lastStartError?.let { append("; last start error: ").append(it) }
        }
        overlayStatusView.text = if (Settings.canDrawOverlays(this)) {
            getString(R.string.diag_overlay_granted, service)
        } else {
            getString(R.string.diag_overlay_missing, service)
        }
    }

    private fun writeReportToLog() {
        val report = lastReport ?: DiagnosticsCollector.collect(this, store).also { lastReport = it }
        DiagLog.i("===== PS5 Cafe diagnostics report BEGIN =====")
        DiagLog.i(report.text)
        DiagLog.i("===== PS5 Cafe diagnostics report END =====")
    }

    private fun renderInputs(report: DiagnosticsReport) {
        inputsContainer.removeAllViews()
        if (report.passthroughInputs.isEmpty()) {
            inputsContainer.addView(textRow(getString(R.string.diag_no_passthrough)))
            return
        }
        for (input in report.passthroughInputs) {
            inputsContainer.addView(textRow("${input.label}  ·  ${input.typeName}  ·  ${input.state}\n${input.id}"))
            val button = layoutInflater.inflate(R.layout.item_switch_button, inputsContainer, false) as Button
            button.setOnClickListener { trySwitch(input) }
            inputsContainer.addView(button)
        }
    }

    private fun textRow(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 16f
        setTextColor(getColor(R.color.text_primary))
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = resources.getDimensionPixelSize(R.dimen.row_gap) }
    }

    /** Fires the documented public intent for a passthrough input and reports what Android said. */
    private fun trySwitch(input: PassthroughInput) {
        val uri = TvContract.buildChannelUriForPassthroughInput(input.id)
        val intent = Intent(Intent.ACTION_VIEW, uri)
        val handler = try {
            packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo
                ?.let { "${it.packageName}/${it.name}" } ?: "no handler found by resolveActivity"
        } catch (e: RuntimeException) {
            "resolveActivity failed: $e"
        }
        DiagLog.i("Input switch request: label='${input.label}' id=${input.id} uri=$uri handler=$handler")
        val startedAt = SystemClock.elapsedRealtime()
        val result = try {
            startActivity(intent)
            pendingSwitchId = input.id
            pendingSwitchAt = startedAt
            "Android accepted the request for '${input.label}' (${input.id}) in " +
                "${SystemClock.elapsedRealtime() - startedAt} ms; handler $handler. " +
                "NOT verified: look at the TV and record whether it shows this input and how long it took."
        } catch (e: ActivityNotFoundException) {
            "No app on this TV handles $uri (ActivityNotFoundException). Passthrough switching through " +
                "this public intent is UNSUPPORTED here."
        } catch (e: SecurityException) {
            "Rejected by Android: SecurityException: ${e.message}"
        } catch (e: RuntimeException) {
            "Failed: ${e.javaClass.name}: ${e.message}"
        }
        DiagLog.i("Input switch result: $result")
        store.lastSwitchNote = "${DiagnosticsCollector.formatTime(System.currentTimeMillis())} $result"
        showLastSwitch()
    }

    private fun appendSwitchNote(note: String) {
        store.lastSwitchNote = (store.lastSwitchNote?.let { "$it\n" } ?: "") + note
    }

    private fun showLastSwitch() {
        val note = store.lastSwitchNote
        resultView.text =
            if (note == null) getString(R.string.diag_last_switch_none) else getString(R.string.diag_last_switch, note)
    }

    private companion object {
        const val SWITCH_WATCH_MS = 60_000L
    }
}

package com.ps5cafe.tvcompanion

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.media.tv.TvContract
import android.media.tv.TvInputInfo
import android.media.tv.TvInputManager
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.DisplayMetrics
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView
import java.net.Inet4Address
import java.net.NetworkInterface
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** One TV input that can be targeted by a passthrough VIEW intent. */
data class PassthroughInput(val id: String, val label: String, val typeName: String, val state: String)

class DiagnosticsReport(val text: String, val passthroughInputs: List<PassthroughInput>)

/**
 * Collects physical-test evidence using only public Android APIs. Every probe is wrapped so a
 * vendor build that throws or hides something still produces a report with the error text.
 */
object DiagnosticsCollector {

    fun collect(activity: Activity, store: ConfigStore): DiagnosticsReport {
        val out = StringBuilder()
        val inputs = mutableListOf<PassthroughInput>()

        fun line(name: String, value: Any?) {
            out.append(name).append(": ").append(value?.toString() ?: "(null)").append('\n')
        }

        fun section(title: String) {
            out.append('\n').append("## ").append(title).append('\n')
        }

        fun probe(name: String, block: () -> Any?) {
            val value = try {
                block()
            } catch (e: Exception) {
                "ERROR ${e.javaClass.name}: ${e.message}"
            } catch (e: LinkageError) {
                "ERROR ${e.javaClass.name}: ${e.message}"
            }
            line(name, value)
        }

        out.append("PS5 Cafe TV companion diagnostics\n")
        out.append("Physical-test evidence only; record results in docs/HARDWARE_LIMITATIONS.md. Nothing here locks the TV.\n")

        section("Report")
        line("Time", formatTime(System.currentTimeMillis()))
        line("App", "${activity.packageName} ${BuildConfig.VERSION_NAME} (code ${BuildConfig.VERSION_CODE}, ${BuildConfig.BUILD_TYPE})")
        line("Uptime since boot", "${SystemClock.elapsedRealtime() / 1000} s")

        section("Device")
        line("Manufacturer", Build.MANUFACTURER)
        line("Brand", Build.BRAND)
        line("Model", Build.MODEL)
        line("Device", Build.DEVICE)
        line("Product", Build.PRODUCT)
        line("Hardware", Build.HARDWARE)
        line("Board", Build.BOARD)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            line("SoC", "${Build.SOC_MANUFACTURER} ${Build.SOC_MODEL}")
        }
        line("Android version", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        line("Security patch", Build.VERSION.SECURITY_PATCH)
        line("Build ID", Build.ID)
        line("Build display", Build.DISPLAY)
        line("Build incremental", Build.VERSION.INCREMENTAL)
        line("Build type/tags", "${Build.TYPE} / ${Build.TAGS}")
        line("Fingerprint", Build.FINGERPRINT)
        probe("UI mode type") {
            val ui = activity.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
            when (val t = ui?.currentModeType) {
                null -> "UiModeManager unavailable"
                Configuration.UI_MODE_TYPE_TELEVISION -> "TELEVISION ($t)"
                Configuration.UI_MODE_TYPE_NORMAL -> "NORMAL ($t)"
                else -> "other ($t)"
            }
        }

        section("Display")
        probe("Display") { describeDisplay(activity) }

        section("WebView")
        probe("WebView package") {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // Platform API on purpose: the app has no AndroidX dependency. Below API 26 the
                // user agent line still shows the Chromium version.
                @SuppressLint("WebViewApiAvailability")
                val pkg = WebView.getCurrentWebViewPackage()
                if (pkg == null) "none (WebView not installed or disabled)" else "${pkg.packageName} ${pkg.versionName}"
            } else {
                "not queryable below API 26; see the user agent"
            }
        }
        probe("Default user agent") { WebSettings.getDefaultUserAgent(activity) }

        section("System features (PackageManager.hasSystemFeature)")
        val pm = activity.packageManager
        // String literals so the probe also works where a constant is newer than minSdk.
        for (feature in listOf(
            "android.software.leanback",
            "android.software.leanback_only",
            "android.software.live_tv",
            "android.hardware.type.television",
            "android.hardware.hdmi.cec",
            "android.hardware.touchscreen",
            "android.software.webview",
        )) {
            probe(feature) { pm.hasSystemFeature(feature) }
        }

        section("Network (IPv4 addresses of this TV)")
        probe("Interfaces") { describeNetwork() }

        section("Screen configuration")
        val cfg = store.load()
        line("Screen URL", cfg?.redactedScreenUrl ?: "not configured")
        line("Saved by", store.configSource ?: "-")
        line("Saved at", store.configSavedAt.takeIf { it > 0 }?.let(::formatTime) ?: "-")

        section("Launch after boot (best effort, unverified)")
        line("Enabled", store.bootLaunchEnabled)
        line("Last BOOT_COMPLETED received", store.lastBootReceivedAt.takeIf { it > 0 }?.let(::formatTime) ?: "never")
        line("Last boot launch note", store.lastBootLaunchNote ?: "-")
        line("Last boot launch reached the screen", store.lastBootScreenShownAt.takeIf { it > 0 }?.let(::formatTime) ?: "never")
        probe("Display over other apps granted (a documented background-start exemption; unverified here)") {
            Settings.canDrawOverlays(activity)
        }

        section("Timer overlay (informational only, not a lock)")
        probe("Display over other apps granted") { Settings.canDrawOverlays(activity) }
        probe("Low-RAM device (some builds refuse overlays)") {
            (activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).isLowRamDevice
        }
        line("Status URL", cfg?.let { "${it.serverOrigin}/api/screen/${it.stationId}?k=${redactKey(it.screenKey)}" } ?: "-")
        line("Service running", TimerOverlayState.running)
        line(
            "Last poll",
            TimerOverlayState.lastPollResult?.let { "${formatTime(TimerOverlayState.lastPollAt)} $it" } ?: "none",
        )
        line("Box showing now", TimerOverlayState.overlayShowing)
        line("Last start error", TimerOverlayState.lastStartError ?: "-")

        section("Last input switch attempt")
        line("Result", store.lastSwitchNote ?: "none yet")

        section("TV inputs (TvInputManager.getTvInputList)")
        line(
            "Note",
            "HDMI-CEC device details (TvInputInfo.getHdmiDeviceInfo) are a system API and not available to apps; " +
                "parentId links a CEC device input to its HDMI port input.",
        )
        val tim = try {
            activity.getSystemService(Context.TV_INPUT_SERVICE) as? TvInputManager
        } catch (e: Exception) {
            line("TvInputManager", "ERROR ${e.javaClass.name}: ${e.message}")
            null
        }
        if (tim == null) {
            line("TvInputManager", "not available on this device (no TV input framework service)")
        } else {
            try {
                val list = tim.tvInputList
                line("Input count", list.size)
                if (list.isEmpty()) {
                    line("Note", "Empty list. Some vendor builds hide inputs from third-party apps.")
                }
                for (info in list) {
                    describeInput(activity, tim, info, out, inputs)
                }
            } catch (e: Exception) {
                line("getTvInputList", "ERROR ${e.javaClass.name}: ${e.message}")
            }
        }

        return DiagnosticsReport(out.toString().trimEnd(), inputs)
    }

    private fun describeInput(
        context: Context,
        tim: TvInputManager,
        info: TvInputInfo,
        out: StringBuilder,
        inputs: MutableList<PassthroughInput>,
    ) {
        fun safe(block: () -> Any?): String = try {
            block()?.toString() ?: "(null)"
        } catch (e: Exception) {
            "ERROR ${e.javaClass.simpleName}: ${e.message}"
        }

        val id = info.id
        val label = safe { info.loadLabel(context) }
        val typeName = typeName(info.type)
        val state = safe { stateName(tim.getInputState(id)) }
        out.append("- id: ").append(id).append('\n')
        out.append("  label: ").append(label).append('\n')
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            out.append("  custom label: ").append(safe { info.loadCustomLabel(context) }).append('\n')
            out.append("  hidden: ").append(safe { info.isHidden(context) }).append('\n')
            out.append("  tuner count / can record: ")
                .append(safe { info.tunerCount }).append(" / ").append(safe { info.canRecord() }).append('\n')
            out.append("  extras: ").append(safe { info.extras?.keySet()?.sorted() }).append('\n')
        }
        out.append("  type: ").append(typeName).append('\n')
        out.append("  passthrough: ").append(info.isPassthroughInput).append('\n')
        out.append("  parentId: ").append(safe { info.parentId }).append('\n')
        out.append("  state: ").append(state).append('\n')
        out.append("  service: ").append(safe { "${info.serviceInfo.packageName}/${info.serviceInfo.name}" }).append('\n')
        if (info.isPassthroughInput) {
            out.append("  passthrough URI: ").append(safe { TvContract.buildChannelUriForPassthroughInput(id) }).append('\n')
            inputs += PassthroughInput(id, label, typeName, state)
        }
    }

    private fun typeName(type: Int): String = when (type) {
        TvInputInfo.TYPE_TUNER -> "TUNER"
        TvInputInfo.TYPE_OTHER -> "OTHER"
        TvInputInfo.TYPE_COMPOSITE -> "COMPOSITE"
        TvInputInfo.TYPE_SVIDEO -> "SVIDEO"
        TvInputInfo.TYPE_SCART -> "SCART"
        TvInputInfo.TYPE_COMPONENT -> "COMPONENT"
        TvInputInfo.TYPE_VGA -> "VGA"
        TvInputInfo.TYPE_DVI -> "DVI"
        TvInputInfo.TYPE_HDMI -> "HDMI"
        TvInputInfo.TYPE_DISPLAY_PORT -> "DISPLAY_PORT"
        else -> "UNKNOWN"
    } + " ($type)"

    private fun stateName(state: Int): String = when (state) {
        TvInputManager.INPUT_STATE_CONNECTED -> "CONNECTED"
        TvInputManager.INPUT_STATE_CONNECTED_STANDBY -> "CONNECTED_STANDBY"
        TvInputManager.INPUT_STATE_DISCONNECTED -> "DISCONNECTED"
        else -> "UNKNOWN"
    } + " ($state)"

    private fun describeDisplay(activity: Activity): String {
        val wm = activity.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        val display = wm.defaultDisplay
        val real = DisplayMetrics()
        @Suppress("DEPRECATION")
        display.getRealMetrics(real)
        val app = activity.resources.displayMetrics
        val mode = display.mode
        val cssWidth = Math.round(real.widthPixels / real.density)
        val cssHeight = Math.round(real.heightPixels / real.density)
        val modes = display.supportedModes.joinToString { "${it.physicalWidth}x${it.physicalHeight}@${"%.2f".format(Locale.US, it.refreshRate)}" }
        return buildString {
            append("${real.widthPixels}x${real.heightPixels} px, densityDpi ${real.densityDpi}, density ${real.density}")
            append("; app window ${app.widthPixels}x${app.heightPixels} px")
            append("; WebView CSS viewport about ${cssWidth}x$cssHeight")
            append("; current mode ${mode.physicalWidth}x${mode.physicalHeight}@${"%.2f".format(Locale.US, mode.refreshRate)} Hz")
            append("; supported modes [$modes]")
        }
    }

    private fun describeNetwork(): String {
        val parts = mutableListOf<String>()
        val interfaces = NetworkInterface.getNetworkInterfaces() ?: return "none"
        for (nif in interfaces.toList()) {
            if (!nif.isUp || nif.isLoopback) continue
            val v4 = nif.inetAddresses.toList().filterIsInstance<Inet4Address>().map { it.hostAddress }
            if (v4.isNotEmpty()) parts += "${nif.name} ${v4.joinToString()}"
        }
        return if (parts.isEmpty()) "no IPv4 address" else parts.joinToString("; ")
    }

    fun formatTime(epochMs: Long): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.US).format(Date(epochMs))
}

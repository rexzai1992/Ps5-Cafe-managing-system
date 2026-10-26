package com.ps5cafe.tvcompanion

import org.json.JSONException
import org.json.JSONObject
import java.util.Locale

/**
 * The fields of `GET <origin>/api/screen/<stationId>?k=<key>` that the timer overlay needs.
 * `remainingMs` is the server's remaining session time at `serverTime` (epoch ms).
 */
data class ScreenStatus(
    val sessionStatus: String,
    val mode: String,
    val serverTime: Long,
    val remainingMs: Long,
)

object ScreenStatusParser {
    /** Throws [JSONException] when the body is not the expected JSON object. */
    fun parse(body: String): ScreenStatus {
        val json = JSONObject(body)
        if (!json.has("sessionStatus") || !json.has("remainingMs")) {
            throw JSONException("missing sessionStatus or remainingMs")
        }
        return ScreenStatus(
            sessionStatus = json.optString("sessionStatus", "UNKNOWN").uppercase(Locale.ROOT),
            mode = json.optString("mode", "UNKNOWN").uppercase(Locale.ROOT),
            serverTime = json.optLong("serverTime", 0L),
            remainingMs = json.optLong("remainingMs", 0L),
        )
    }
}

/**
 * One successful poll. [midpointElapsed] is the elapsedRealtime half-way between sending the
 * request and receiving the answer, the best local estimate of when `serverTime` was read.
 */
data class StatusSample(val status: ScreenStatus, val midpointElapsed: Long) {
    /** serverTime - elapsedRealtime: converts the local monotonic clock to server time. */
    val serverOffsetMs: Long
        get() = status.serverTime - midpointElapsed
}

enum class CountdownLevel { NORMAL, WARNING, CRITICAL }

data class CountdownView(
    val visible: Boolean,
    val paused: Boolean = false,
    /** The session ran out: the box says "Time's up" in red until staff end or extend it. */
    val expired: Boolean = false,
    val remainingMs: Long = 0L,
    val text: String = "",
    val level: CountdownLevel = CountdownLevel.NORMAL,
    val hiddenReason: String = "",
)

/**
 * Pure countdown rules for the overlay, kept free of Android types so they are unit-tested.
 * The server stays authoritative: the overlay only extrapolates between 5-second polls and
 * hides itself instead of showing a time it can no longer vouch for.
 */
object SessionCountdown {
    const val STALE_AFTER_MS = 30_000L
    const val WARNING_AT_MS = 10 * 60_000L
    const val CRITICAL_AT_MS = 60_000L

    fun compute(sample: StatusSample?, lastSuccessElapsed: Long, nowElapsed: Long): CountdownView {
        if (sample == null) return CountdownView(visible = false, hiddenReason = "no successful poll yet")
        if (nowElapsed - lastSuccessElapsed > STALE_AFTER_MS) {
            return CountdownView(visible = false, hiddenReason = "no successful poll for over ${STALE_AFTER_MS / 1000} s")
        }
        val status = sample.status
        val remaining = when (status.sessionStatus) {
            "ACTIVE" -> {
                // Deadline in server time minus "now" in server time.
                val deadlineServer = status.serverTime + status.remainingMs
                deadlineServer - (nowElapsed + sample.serverOffsetMs)
            }
            "PAUSED" -> status.remainingMs
            "EXPIRED" -> return CountdownView(visible = true, expired = true, level = CountdownLevel.CRITICAL)
            else -> return CountdownView(visible = false, hiddenReason = "session ${status.sessionStatus}")
        }.coerceAtLeast(0L)
        return CountdownView(
            visible = true,
            paused = status.sessionStatus == "PAUSED",
            remainingMs = remaining,
            text = format(remaining),
            level = levelFor(remaining),
        )
    }

    /**
     * Whether the screen page should come back to the front after this poll, and why: when the session runs out (so the
     * TV shows "Time expired") and when staff end it (so ads and the QR code show again). Only a change seen between two
     * polls counts, never the first poll after the service starts. Software only: the TV remote can switch away again.
     */
    fun screenShouldReturn(previous: String?, current: String): String? {
        val running = previous == "ACTIVE" || previous == "PAUSED"
        return when {
            running && current == "EXPIRED" -> "session expired"
            (running || previous == "EXPIRED") && (current == "NONE" || current == "ENDED") -> "session ended"
            else -> null
        }
    }

    /**
     * Whether the PS5 input should come to the front after this poll: when a session becomes ACTIVE (started, extended
     * after expiry, or resumed). Also on the first poll of an already-running session, so a restarted app returns to the
     * game.
     */
    fun ps5ShouldShow(previous: String?, current: String): Boolean = current == "ACTIVE" && previous != "ACTIVE"

    fun levelFor(remainingMs: Long): CountdownLevel = when {
        remainingMs <= CRITICAL_AT_MS -> CountdownLevel.CRITICAL
        remainingMs <= WARNING_AT_MS -> CountdownLevel.WARNING
        else -> CountdownLevel.NORMAL
    }

    /** H:MM:SS, rounded up so 0:00:00 only appears when time is really up. */
    fun format(remainingMs: Long): String {
        val totalSeconds = (remainingMs.coerceAtLeast(0L) + 999L) / 1000L
        val hours = totalSeconds / 3600
        val minutes = (totalSeconds % 3600) / 60
        val seconds = totalSeconds % 60
        return String.format(Locale.US, "%d:%02d:%02d", hours, minutes, seconds)
    }
}

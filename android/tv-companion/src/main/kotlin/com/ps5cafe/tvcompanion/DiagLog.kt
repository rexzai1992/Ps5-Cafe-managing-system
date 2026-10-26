package com.ps5cafe.tvcompanion

import android.util.Log

/**
 * Owner-facing log lines for the physical test. Read them with:
 *
 *     adb logcat -s PS5CafeDiag
 *
 * Every line is logged separately (logcat truncates long entries) and screen keys are never logged
 * in full (callers pass redacted URLs).
 */
object DiagLog {
    const val TAG = "PS5CafeDiag"
    private const val MAX_CHUNK = 3_000

    fun i(message: String) = emit(Log.INFO, message)

    fun w(message: String) = emit(Log.WARN, message)

    private fun emit(priority: Int, message: String) {
        for (line in message.lines()) {
            if (line.isEmpty()) {
                Log.println(priority, TAG, " ")
                continue
            }
            var start = 0
            while (start < line.length) {
                val end = minOf(line.length, start + MAX_CHUNK)
                Log.println(priority, TAG, line.substring(start, end))
                start = end
            }
        }
    }
}

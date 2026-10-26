package com.ps5cafe.tvcompanion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Best-effort: try to bring the screen up after the TV boots.
 *
 * Unverified on every model. On Android 10+ the system silently blocks most activity starts from
 * the background, and many TVs resume from standby without a new BOOT_COMPLETED. The broadcast is
 * also not delivered until the app has been opened once after install, nor after a force-stop.
 * Diagnostics shows whether the launch actually reached the screen. The timer overlay service
 * is started too (when configured), independently of the launch-after-boot setting.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val store = ConfigStore(context)
        store.lastBootReceivedAt = System.currentTimeMillis()
        val note = when {
            !store.bootLaunchEnabled -> "launch after boot is disabled; screen not started"
            store.load() == null -> "not configured; screen not started"
            else -> try {
                context.startActivity(
                    Intent(context, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        .putExtra(MainActivity.EXTRA_FROM_BOOT, true),
                )
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    "startActivity called; Android ${Build.VERSION.RELEASE} may block background starts silently"
                } else {
                    "startActivity called"
                }
            } catch (e: RuntimeException) {
                "startActivity failed: $e"
            }
        }
        store.lastBootLaunchNote = note
        DiagLog.i("BOOT_COMPLETED received: $note.")
        // Starting a foreground service from BOOT_COMPLETED is an allowed background-start exemption.
        if (store.load() != null) TimerOverlayService.start(context, "boot")
    }
}

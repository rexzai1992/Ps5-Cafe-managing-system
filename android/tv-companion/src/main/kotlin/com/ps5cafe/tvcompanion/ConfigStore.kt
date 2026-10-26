package com.ps5cafe.tvcompanion

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences

/**
 * App-private SharedPreferences. The screen key is stored in plain text in the app's private
 * storage (readable only by this app on a non-rooted TV); it is excluded from backup and transfer.
 */
class ConfigStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** The saved configuration, re-validated on every read so a bad value can never be loaded. */
    fun load(): ScreenConfig? {
        val server = prefs.getString(KEY_SERVER, null) ?: return null
        val station = prefs.getString(KEY_STATION, null) ?: return null
        val key = prefs.getString(KEY_SCREEN_KEY, null) ?: return null
        return (ScreenConfigParser.fromParts(server, station, key) as? ConfigResult.Valid)?.config
    }

    // commit(), not apply(): the ADB flow may force-stop or reboot the TV right after configuring.
    @SuppressLint("ApplySharedPref")
    fun save(config: ScreenConfig, source: String) {
        prefs.edit()
            .putString(KEY_SERVER, config.serverOrigin)
            .putString(KEY_STATION, config.stationId)
            .putString(KEY_SCREEN_KEY, config.screenKey)
            .putString(KEY_SOURCE, source)
            .putLong(KEY_SAVED_AT, System.currentTimeMillis())
            .commit()
    }

    @SuppressLint("ApplySharedPref")
    fun clearConfig() {
        prefs.edit()
            .remove(KEY_SERVER)
            .remove(KEY_STATION)
            .remove(KEY_SCREEN_KEY)
            .remove(KEY_SOURCE)
            .remove(KEY_SAVED_AT)
            .commit()
    }

    val configSource: String?
        get() = prefs.getString(KEY_SOURCE, null)

    val configSavedAt: Long
        get() = prefs.getLong(KEY_SAVED_AT, 0L)

    var bootLaunchEnabled: Boolean
        get() = prefs.getBoolean(KEY_BOOT_LAUNCH, true)
        set(value) = putSync { putBoolean(KEY_BOOT_LAUNCH, value) }

    var lastBootReceivedAt: Long
        get() = prefs.getLong(KEY_BOOT_RECEIVED_AT, 0L)
        set(value) = putSync { putLong(KEY_BOOT_RECEIVED_AT, value) }

    var lastBootLaunchNote: String?
        get() = prefs.getString(KEY_BOOT_NOTE, null)
        set(value) = putSync { putString(KEY_BOOT_NOTE, value) }

    var lastBootScreenShownAt: Long
        get() = prefs.getLong(KEY_BOOT_SHOWN_AT, 0L)
        set(value) = putSync { putLong(KEY_BOOT_SHOWN_AT, value) }

    /**
     * Which TV input the PS5 is on, shown by the app itself while a session runs: a TIF input id, or "auto" (the HDMI input
     * that has a signal). Null keeps the old behaviour (staff switch inputs with the TV's own controls).
     */
    var ps5Input: String?
        get() = prefs.getString(KEY_PS5_INPUT, null)
        set(value) = putSync { if (value == null) remove(KEY_PS5_INPUT) else putString(KEY_PS5_INPUT, value) }

    var lastSwitchNote: String?
        get() = prefs.getString(KEY_SWITCH_NOTE, null)
        set(value) = putSync { putString(KEY_SWITCH_NOTE, value) }

    @SuppressLint("ApplySharedPref")
    private inline fun putSync(block: SharedPreferences.Editor.() -> Unit) {
        prefs.edit().apply(block).commit()
    }

    private companion object {
        const val PREFS_NAME = "tv_companion"
        const val KEY_SERVER = "server_origin"
        const val KEY_STATION = "station_id"
        const val KEY_SCREEN_KEY = "screen_key"
        const val KEY_SOURCE = "config_source"
        const val KEY_SAVED_AT = "config_saved_at"
        const val KEY_BOOT_LAUNCH = "boot_launch_enabled"
        const val KEY_BOOT_RECEIVED_AT = "boot_received_at"
        const val KEY_BOOT_NOTE = "boot_launch_note"
        const val KEY_BOOT_SHOWN_AT = "boot_screen_shown_at"
        const val KEY_SWITCH_NOTE = "last_switch_note"
        const val KEY_PS5_INPUT = "ps5_input"
    }
}

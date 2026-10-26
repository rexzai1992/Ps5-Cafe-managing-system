package com.ps5cafe.tvcompanion

import android.content.Context
import android.media.tv.TvInputInfo
import android.media.tv.TvInputManager
import android.os.Build

/** Finds the PS5's TV input through Android's documented TV Input Framework (no vendor commands). */
object Ps5Input {
    const val AUTO = "auto"

    /**
     * The configured input id, or for [AUTO] the first HDMI passthrough input with a connected source. Null when nothing
     * is configured, the TV has no TV Input Framework, or no HDMI source is connected.
     */
    fun resolve(context: Context, configured: String?): String? {
        if (configured == null) return null
        val manager = context.getSystemService(Context.TV_INPUT_SERVICE) as? TvInputManager ?: return null
        if (configured != AUTO) return configured
        val hdmi = manager.tvInputList.filter { it.type == TvInputInfo.TYPE_HDMI && it.isPassthroughInput }
        // Input state needs API 24; older TVs fall back to the first HDMI input.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return hdmi.firstOrNull()?.id
        return hdmi.firstOrNull { manager.getInputState(it.id) == TvInputManager.INPUT_STATE_CONNECTED }?.id
    }

    /** The TV input for "HDMI n" (1-4) as the remote names it, or null if the TV has no such input. */
    fun hdmi(context: Context, number: Int): String? {
        val manager = context.getSystemService(Context.TV_INPUT_SERVICE) as? TvInputManager ?: return null
        val inputs = manager.tvInputList.filter { it.type == TvInputInfo.TYPE_HDMI && it.isPassthroughInput }
            .map { it.id to it.loadLabel(context).toString() }
        return pickHdmi(inputs, number)
    }

    /**
     * Picks "HDMI n" from (id, label) pairs: the input labelled "HDMI n" if the TV names them so, otherwise the n-th HDMI
     * input in id order (on the tested Hisense the ids HW2-HW5 are HDMI ports 1-4).
     */
    fun pickHdmi(inputs: List<Pair<String, String>>, number: Int): String? {
        if (number < 1) return null
        val labelled = inputs.firstOrNull { (_, label) -> label.replace(" ", "").equals("HDMI$number", ignoreCase = true) }
        return labelled?.first ?: inputs.map { it.first }.sorted().getOrNull(number - 1)
    }
}

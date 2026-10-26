package com.ps5cafe.tvcompanion

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import java.util.Locale

/**
 * D-pad friendly setup: server origin, station id, screen key. Opened automatically on first
 * launch when unconfigured, or by holding BACK for ~3 s on the screen. Not a security boundary.
 */
class SetupActivity : Activity() {

    private lateinit var store: ConfigStore
    private lateinit var serverField: EditText
    private lateinit var stationField: EditText
    private lateinit var keyField: EditText
    private lateinit var bootBox: CheckBox
    private lateinit var errorText: TextView

    /** Swallows the tail of the BACK hold that opened this screen, so it does not close at once. */
    private var suppressHeldBack = false
    private var lastBackEventAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        store = ConfigStore(this)
        serverField = findViewById(R.id.setup_server)
        stationField = findViewById(R.id.setup_station)
        keyField = findViewById(R.id.setup_key)
        bootBox = findViewById(R.id.setup_boot)
        errorText = findViewById(R.id.setup_error)

        suppressHeldBack = intent.getBooleanExtra(EXTRA_OPENED_BY_BACK_HOLD, false)
        lastBackEventAt = SystemClock.uptimeMillis()

        val saved = store.load()
        findViewById<TextView>(R.id.setup_current).text =
            if (saved != null) getString(R.string.setup_current, saved.redactedScreenUrl)
            else getString(R.string.setup_current_none)
        if (savedInstanceState == null) {
            serverField.setText(saved?.serverOrigin.orEmpty())
            stationField.setText(saved?.stationId.orEmpty())
            // The saved key is never shown on screen; leaving the field empty keeps it.
            keyField.setText("")
            bootBox.isChecked = store.bootLaunchEnabled
        }
        findViewById<TextView>(R.id.setup_version).text = getString(
            R.string.setup_version,
            BuildConfig.VERSION_NAME,
            BuildConfig.VERSION_CODE,
            packageName,
        )

        findViewById<Button>(R.id.setup_save).setOnClickListener { save() }
        findViewById<Button>(R.id.setup_diagnostics).setOnClickListener {
            startActivity(Intent(this, DiagnosticsActivity::class.java))
        }
        findViewById<Button>(R.id.setup_cancel).setOnClickListener { finish() }

        if (saved == null) serverField.requestFocus() else findViewById<View>(R.id.setup_cancel).requestFocus()
    }

    private fun save() {
        val typedKey = keyField.text.toString().trim()
        val key = typedKey.ifEmpty { store.load()?.screenKey.orEmpty() }
        val result = ScreenConfigParser.fromParts(
            serverField.text.toString(),
            stationField.text.toString().trim().lowercase(Locale.ROOT),
            key,
        )
        when (result) {
            is ConfigResult.Valid -> {
                store.save(result.config, "setup screen")
                store.bootLaunchEnabled = bootBox.isChecked
                DiagLog.i(
                    "Configuration saved from the setup screen: ${result.config.redactedScreenUrl} " +
                        "(launch after boot: ${bootBox.isChecked})",
                )
                Toast.makeText(this, getString(R.string.setup_saved_toast, result.config.stationId), Toast.LENGTH_SHORT).show()
                finish()
            }
            is ConfigResult.Invalid -> {
                errorText.text = result.reason
                errorText.visibility = View.VISIBLE
                DiagLog.w("Setup screen rejected the input: ${result.reason}")
            }
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK && suppressHeldBack) {
            val now = SystemClock.uptimeMillis()
            val freshPress = event.action == KeyEvent.ACTION_DOWN &&
                event.repeatCount == 0 &&
                now - lastBackEventAt > HELD_BACK_GAP_MS
            if (!freshPress) {
                lastBackEventAt = now
                return true
            }
            suppressHeldBack = false
        }
        return super.dispatchKeyEvent(event)
    }

    companion object {
        const val EXTRA_OPENED_BY_BACK_HOLD = "com.ps5cafe.tvcompanion.extra.OPENED_BY_BACK_HOLD"
        private const val HELD_BACK_GAP_MS = 600L
    }
}

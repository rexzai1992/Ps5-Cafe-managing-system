# PS5 Cafe TV companion (Android TV APK)

Shows one TV's **screen page** full screen, and a small **remaining-time box** in the top-right
corner while the PS5 is on screen. Package `com.ps5cafe.tvcompanion`, minSdk 23 (Android 6), targetSdk 35.

> **Status: built and unit-tested on a Mac only. It has not run on any TV or emulator.** Every
> TV behaviour below is what the code is meant to do. Whether it works on a given model is what
> [`docs/TV_TEST_PLAN.md`](../../docs/TV_TEST_PLAN.md) finds out. Record results per model in
> [`docs/HARDWARE_LIMITATIONS.md`](../../docs/HARDWARE_LIMITATIONS.md).

## What it is and is not

- It loads `<server>/#/screen/<station>?k=<key>` in a WebView. The page itself talks to the server.
- It is **not a lock** and is not tamper-proof. HOME, INPUT, the TV's own buttons, a reboot, a
  force-stop, another app, or HDMI-CEC from the PS5 can all replace it. Ignoring a short BACK press
  is a convenience, not a security boundary.
- The timer box is **informational only**. It cannot stop a game, and a reboot, force-stop or a
  revoked overlay permission removes it.
- No analytics, crash reporting, Google Play services or third-party SDKs. The only runtime
  library is the Kotlin standard library.

## Build

Requirements: JDK 17 and the Android SDK (platform 35, build-tools 35). `local.properties`
(not committed) holds `sdk.dir=/Users/<you>/Library/Android/sdk`.

```bash
cd android/tv-companion
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home
./gradlew assembleDebug testDebugUnitTest lint
mkdir -p dist && cp build/outputs/apk/debug/tv-companion-debug.apk dist/ps5-cafe-tv.apk
shasum -a 256 dist/ps5-cafe-tv.apk
```

The debug APK is signed with this Mac's Android debug key (`~/.android/debug.keystore`). An APK
built on another computer has a different signature, so `adb install -r` over it fails with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`; uninstall first. `dist/` and `*.apk` are git-ignored.

Unit tests cover config/URL validation, the same-origin rule, retry backoff, status parsing and the
countdown rules. Nothing Android-specific (WebView, overlay, intents) is covered by automated tests.

## Install and configure (ADB)

```bash
adb connect <tv-ip>:<port>
adb install -r dist/ps5-cafe-tv.apk
# Preferred: the whole screen URL (the dashboard's Device Settings > TV screens and QR booking
# page has a ready-made "ADB setup command" for each TV). The outer double quotes plus inner
# single quotes stop both your Mac's shell and the TV's shell from touching '#', '?' and '&'.
adb shell "am start -n com.ps5cafe.tvcompanion/.MainActivity --es url 'http://192.168.100.65:5173/#/screen/ps5-03?k=KEY'"
# Or the three parts:
adb shell "am start -n com.ps5cafe.tvcompanion/.MainActivity --es server http://192.168.100.65:5173 --es station ps5-03 --es key KEY"
# Let the timer box draw over other apps (Android TV usually hides this setting):
adb shell appops set com.ps5cafe.tvcompanion SYSTEM_ALERT_WINDOW allow
```

`adb shell pm grant ... SYSTEM_ALERT_WINDOW` does **not** work; it is an app-op, not a runtime
permission. Check with `adb shell appops get com.ps5cafe.tvcompanion SYSTEM_ALERT_WINDOW`.

Validation: `http`/`https` origin with no path, query or user info; station `^[a-z0-9-]{1,40}$`;
key of 1-512 characters from `A-Z a-z 0-9 . _ ~ -`. A rejected value keeps the previous
configuration and is logged (`Configuration REJECTED ...`). Running `am start` again while the app
is open re-applies the new values without a restart.

| Extra | Effect |
|---|---|
| `--es url '<screen URL>'` | Save and show this screen URL |
| `--es server <origin> --es station <id> --es key <key>` | Same, from parts |
| `--ez diagnostics true` | Open Diagnostics |
| `--ez setup true` | Open the setup screen |
| `--ei overlay_test <seconds>` | Show the timer box with a fake `0:09:59` for 1-300 s |
| `--ez boot_launch false` | Do not try to open the screen after boot (default: try) |
| `--ez reset true` | Forget the configuration and stop the timer service |

Without ADB: on first launch an unconfigured app opens a D-pad setup screen (server, station, key).
Holding **BACK for about 3 seconds** on the screen page reopens it. The saved key is never shown;
leave the key field empty to keep it.

## Behaviour

- **Navigation:** only the configured origin (scheme, host, port) may load in the WebView. Other
  origins and schemes (`intent:`, `market:`, `file:`, ...) are ignored and logged. JavaScript and DOM
  storage are on, video may autoplay, file/content access is off, JavaScript dialogs are suppressed.
- **Cleartext HTTP:** allowed in `res/xml/network_security_config.xml` because the LAN server is
  plain `http://` at an address chosen at runtime, and the network security config cannot express an
  IP range. The origin allowlist above is what limits it.
- **Server unreachable:** an opaque native message ("Cannot reach the PS5 Cafe server — retrying in N s")
  and retries with capped exponential backoff plus jitter: 1-2 s, 2-4 s, ... up to 30-60 s. A page
  that does not finish loading within 30 s counts as a failure. OK retries immediately.
- **Watchdog:** every 30 s the loaded page must answer a trivial JavaScript call; about a minute
  without an answer recreates the WebView. A crashed WebView renderer is also recreated.
- **Hidden:** when another app or a TV input comes to the front (`onStop`), the page is unloaded so
  ad video frees its decoder before gameplay. It reloads when the app is visible again.
- **Kiosk:** full screen, landscape, screen kept on while visible, short BACK presses ignored.
- **Boot (best effort):** after `BOOT_COMPLETED` it tries to open the screen and starts the timer
  service. Android 10+ blocks most background activity starts (a granted overlay permission is a
  documented exemption, unverified on these TVs); many TVs wake from standby without a boot
  broadcast; and the broadcast is not delivered after a force-stop or before the app's first launch.
  Diagnostics shows whether the boot launch reached the screen.

### Timer box (`TimerOverlayService`)

- A foreground service (`specialUse`, low-importance ongoing notification) started whenever the TV
  is configured and the app opens, and after boot.
- Polls `GET <origin>/api/screen/<station>?k=<key>` every 5 s (3 s timeouts, no redirects), and
  counts down locally between polls using the server's `serverTime`/`remainingMs`.
- Visible only for sessions `ACTIVE` (`Time left H:MM:SS`) or `PAUSED` (`Paused`). Dark box, amber
  at 10 minutes or less, red at 1 minute or less. Hidden for `NONE`/`ENDED`/`EXPIRED`, immediately on
  HTTP 403 (wrong key) or 404 (unknown station), and after 30 s without a successful poll, so it never
  shows a stale time.
- A `TYPE_APPLICATION_OVERLAY` window with `FLAG_NOT_FOCUSABLE | FLAG_NOT_TOUCHABLE`, so the game
  keeps every remote and controller key. Whether a TV draws app overlays **on top of the HDMI
  picture** (some use a separate hardware video plane, or suppress overlays in game mode) is unknown
  until tested on each model.
- Polls use the user agent `PS5CafeTvCompanion/<version> (timer-overlay)`. The endpoint also
  refreshes the station's "screen seen" time, so a TV with the timer service running looks "seen"
  even while it shows the PS5.

## Diagnostics (physical-test evidence)

Open with `--ez diagnostics true` or from setup. It shows and logs device/OS/build identity, WebView
version, display mode and CSS viewport, TV system features, IPv4 addresses, overlay permission and
timer status, boot-launch evidence, and the `TvInputManager` input list (id, label, type, passthrough,
state, parent). For each passthrough input, **Try switch to this input** fires the public
`ACTION_VIEW` intent for `TvContract.buildChannelUriForPassthroughInput(id)` and reports what Android
answered. Android accepting the request does not prove the TV switched; the tester must look.
**Test overlay (10 s)** shows the timer box with a fake time.

```bash
adb logcat -s PS5CafeDiag            # live
adb logcat -d -s PS5CafeDiag > tv.txt  # save what is buffered
```

Screen keys are never logged in full. In this debug build the WebView can be inspected with
`chrome://inspect` from a computer that has ADB access to the TV.

## Security notes

- Any app installed on the TV, or anyone with ADB, can send the configuration intent and repoint the
  screen. Turn ADB off after setup and keep the TVs on a staff-only network.
- The screen key is stored in the app's private storage, excluded from backup and device transfer.
- Never expose ADB (port 5555 or wireless debugging) to the customer network or the internet.

## Uninstall

```bash
adb uninstall com.ps5cafe.tvcompanion
```

Or on the TV: Settings > Apps > PS5 Cafe Screen > Uninstall. To withdraw only the overlay
permission: `adb shell appops set com.ps5cafe.tvcompanion SYSTEM_ALERT_WINDOW default`.

## Layout

```text
build.gradle.kts, settings.gradle.kts   Single-module Gradle project (AGP 8.13.0, Kotlin 2.2.20, Gradle 8.14.3 wrapper)
src/main/AndroidManifest.xml            Leanback launcher, banner, permissions, service, boot receiver
src/main/kotlin/.../MainActivity.kt     Full-screen WebView, retries, watchdog, kiosk BACK, intent config
src/main/kotlin/.../SetupActivity.kt    D-pad setup screen
src/main/kotlin/.../DiagnosticsActivity.kt, DiagnosticsReport.kt   Physical-test screen and report
src/main/kotlin/.../TimerOverlayService.kt, SessionCountdown.kt     Remaining-time box
src/main/kotlin/.../ScreenConfig.kt, ConfigStore.kt, RetryPolicy.kt, BootReceiver.kt, DiagLog.kt
src/test/kotlin/...                     JVM unit tests
```

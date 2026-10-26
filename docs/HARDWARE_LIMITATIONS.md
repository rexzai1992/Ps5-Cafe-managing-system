# Hardware Compatibility and Verification Boundary

## Current truth

One physical display has been partly tested (2026-10-26, Hisense WE3FE, below) in live **screen-only** mode: the companion
app and screen page run on it, but the server sends it no commands. No PS5 was used in that test and no control adapter is
enabled (simulation uses `MockTvAdapter`; live uses `ScreenOnlyAdapter`). Android TV, Google TV, Samsung Tizen, generic
remote control, HDMI selection by the server, and media decode on other models remain unverified.

The simulated expired screen is not proof of a secure lock. With ordinary TVs, a customer may use the physical remote, TV buttons, HDMI-CEC, another app, or a reboot to return to HDMI. Level 4 control requires future controllable HDMI hardware and independent testing.

## Minimum test record per model

Record all of the following before enabling a real adapter profile:

| Field | Required evidence |
|---|---|
| Identity | manufacturer, exact model, region, OS and firmware |
| Pairing | on-screen authorization steps and revocation path |
| Network | port/protocol, trusted subnet, reconnect after DHCP change |
| Commands | power, volume, mute, navigation, each HDMI input, app launch |
| Modes | idle advertising, gameplay transition, expiry transition |
| Verification | what state can actually be read back vs merely acknowledged |
| Recovery | standby, reboot, server restart, TV offline, authorization revoked |
| Performance | idle CPU/RAM, decoder release, gameplay latency/frame behavior |
| Security | credentials/storage, exposed services, firewall configuration |
| CEC wake after expiry | with the expired screen up, wake the PS5 from rest with its controller; record whether the TV switches back to the PS5 input with TV CEC (Anynet+, SIMPLINK, BRAVIA Sync) on/off, PS5 HDMI Device Link on/off, and with any key lock or switch routing applied. Pass: the expired screen stays and the next re-verification still matches |
| Customer phone pairing | from a phone on the customer Wi-Fi, try to pair the vendor remote app (Google TV, SmartThings, others) during an expired session; record discoverability, whether a pairing prompt appears over the expired screen, and whether any key or input change is accepted. Pass: the TV is not reachable from the customer network |
| Mains power cycle | unplug the TV at the wall during an expired session for at least 30 s; record power-on state and input, whether each key/remote lock survives, time until reachable, and whether the server re-applies the expired mode without staff action |
| Firmware change | firmware before and after any update and whether auto-update is on; after a change, re-run the full matrix before the profile is re-enabled and record how the server detects the change and flags the station for re-test |

Background, sources, and the ranked locking tiers (an IP-controlled HDMI switch with routing readback is the only option that removes the PS5 picture in hardware) are in [`docs/research/`](research/README.md). Nothing there is implemented or physically verified.

## Tested models

### Hisense WE3FE "VisionBoard" (2026-10-26, PS5-01, partial)

| Field | Result |
|---|---|
| Identity | Hisense WE3FE (interactive touch panel built by CVTE, not a Google TV), Android 14 / API 34, patch 2025-06-01, build `UP1A.231005.007.A1/20250911`, MediaTek mt9679/mt5896, 3840×2160 @ density 480, Play Store + Chrome, WebView 155.0.8059.43, no `android.software.leanback`, touchscreen |
| Pairing | Developer options → Wireless debugging → "Pair device with pairing code"; `adb pair` OK, connect port found by mDNS. Revoke: turn off Wireless debugging / revoke authorizations |
| Network | Reached over Wi-Fi at 192.168.100.170. **The server Mac's DHCP address changed twice in one day** (.65 → .244 → .202) and the TV lost the server each time; the TV resolves `Craves-MacBook-Air.local`, so TV links now use that name |
| Commands (with a PC on HDMI 1, later the same day) | Panel model string **75WE3FE**; the PC hot-plugged on HDMI port 1 (TIF `HW2`, state CONNECTED). `KEYCODE_TV_INPUT_HDMI_1` (243) still ignored (the vendor `HotkeyService` logged it from the "Virtual" device but did not switch). **`KEYCODE_TV_INPUT` (178) opens the panel's touch source menu** (Android, HDMI 1-3, DP, VGA, USB-C 1-2; green dot = signal); D-pad keys do not move in it (touch-only). **`input tap` on HDMI 1 switches the source**: the HDMI picture is shown by an Android activity, `com.cvte.tv.setting/.TifPlayerActivity`; tapping "Android" in the same menu returns to the last app. Keys that work over ADB: HOME, VOLUME_UP/DOWN (20→21→20), INPUT (menu); BACK does nothing on the launcher; MUTE inconclusive; POWER/SLEEP ignored. `screencap` returns the Android layers; the HDMI picture is a hardware video layer and comes out black |
| Remote control over the live server (opt-in, documented tools only) | PS5-01 assigned to the panel's wireless-debugging service name; through `/api/stations/ps5-01/actions` and `/screenshot`: Sources → tap HDMI 1 → panel on HDMI (TifPlayerActivity) → Sources → tap Android → PS5 Cafe screen back; every key/tap recorded `UNVERIFIED`. The ADB link dropped while idle once; the server now reconnects by service name before each command |
| PS5 input inside the companion app (TIF `TvView`, documented API) | With `ps5_input=auto` the app tuned `com.mediatek.external/.HdmiInputService/HW2` (PC on HDMI 1) through `TvView` and got `onVideoAvailable` ("picture available"); Start → game input within ~9 s, End/expiry → screen page back, expiry CONFIRMED by the page's poll. Third-party apps may tune passthrough inputs on this panel. Picture/audio quality and latency to be confirmed by eye with the PS5 |
| Modes over a real HDMI source | Timer box drawn over the PC picture (screencap shows the box over black; owner to confirm by eye); 1 minute left → red; **at expiry the app came in front of the HDMI player by itself** ("Time expired", server CONFIRMED); Add time → back on HDMI, box shown; End → app back with ads + QR |
| Screen power (corrected 2026-10-26 15:10) | Earlier rows said SLEEP/POWER were "ignored": wrong — they were judged by Android's state, which never changes here. On this panel `PowerManagerService` maps sleep/wake to the **backlight only** ("goToSleep to setBacklightEnable" / "wakeUp to setBacklightEnable") and Android stays awake and interactive. So `KEYCODE_POWER` (26) and `KEYCODE_SLEEP` (223) turn the screen **off**, but POWER can never turn it back on (`powerPress … interactive=true` → go to sleep again); **`KEYCODE_WAKEUP` (224) turns it on** (verified twice, also through the live server). The dashboard's live remote therefore has Screen on / Screen off instead of a Power toggle. The backlight state itself cannot be read through documented APIs, so a dark panel still shows Online |
| Commands (first pass) | HDMI selection: the TIF passthrough intent (`content://android.media.tv/passthrough/…HdmiInputService%2FHW2`) has **no TV handler** (resolves to Google Search/Messages); `KEYCODE_TV_INPUT_HDMI_1` (243) and `KEYCODE_TV_INPUT` (178) **ignored**, from the app and from Home. Power: `KEYCODE_SLEEP` (223) and `KEYCODE_POWER` (26) via ADB **ignored**. Inputs are switched through vendor apps (CVTE/ifpdos), not used (undocumented) |
| Modes | Screen page loads and polls (idle ads + QR, in session, Time expired). Companion app: timer box drawn over other apps (verified over the home screen, red ≤1 min); at expiry the app **brought its screen page back to the front by itself** and the server confirmed the expired screen from the page's poll; Add time → session resumed; End → screen page brought back with ads + QR. **Not yet verified over a live HDMI/PS5 picture** |
| Verification | The server knows only what the page/app polls report. **The panel's power button turns off the backlight only: Android stays awake (display ON, app in front), so the dashboard keeps showing the TV Online with its screen open while the panel looks off.** Power-on needs two presses |
| Recovery | **Server restart:** server down 18 s → the app showed its retry state and the screen page was back 2 s after the server returned, no touch needed. Re-pointed to `http://craves-macbook-air.local:8080/…` by ADB intent; the name also resolves to the Mac's global IPv6 address, which the server deliberately does not listen on (IPv4 LAN only), so the app falls back to IPv4 immediately. Not yet tested: TV reboot / boot launch, network loss on the TV side |
| Media | Advertising on the panel's WebView 155 (checked over WebView remote debugging): 1920×1080 PNG/JPEG shown; 1280×720 H.264 MP4 plays muted (`currentTime` advancing). The QR code points phones at the Mac's current IP while the page itself loads by name |
| Performance | Not measured |
| Security | Panel UI (casting "Broadcast" bar, side menu handles) stays above the app and is touchable; touchscreen gives customers system navigation. Not a lock |

## Companion-app decision gate

Do not create an APK merely for convenience. First prove that server-side supported controls cannot reliably show advertising and the expired screen. If required, use native Kotlin, hardware-decoded media, event-driven communication, backoff with jitter, no screen capture/AI/high-frequency polling, and release playback resources before HDMI gameplay. A foreground app still cannot claim to overlay or securely block protected HDMI input.


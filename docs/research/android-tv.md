# Android TV and Google TV Control Research

Research date: 2026-10-25 (Asia/Kuala_Lumpur). All URLs below were accessed on that date unless a different date is given.
Audience: engineers who will later build and physically verify an `android-tv` or `google-tv` adapter, and the café owner choosing TVs.

> **Status: research only. Nothing in this document is implemented or physically verified in this repository.**
> No Android TV or Google TV set was contacted. The repository has `"android-tv"` and `"google-tv"` values in `AdapterKind` ([`packages/contracts/src/index.ts`](../../packages/contracts/src/index.ts)), but every station is still built as a `MockTvAdapter` ([`apps/server/src/system.ts`](../../apps/server/src/system.ts), `load()`). The Android/Google adapters stay **disabled** until the matrix in [`docs/HARDWARE_LIMITATIONS.md`](../HARDWARE_LIMITATIONS.md) is recorded for the exact model and firmware. This is design-later material; it is not part of the Phase 2 duration-flow slice.

Evidence labels follow [README.md](README.md#evidence-legend): **OFFICIAL**, **VENDOR-AUTHORED, THIRD-PARTY HOSTED**, **COMMUNITY / REVERSE-ENGINEERED**, **UNVERIFIED**, and **REPO** (seen in this repository's code during the research; line numbers move).

## 1. Summary and status

Four mechanisms can partly control an Android TV or Google TV from a LAN server. **None of them can prove what is on the screen.**

| Mechanism | Official status | What it adds | Main limit | Proposed use |
|---|---|---|---|---|
| Android TV Remote protocol v2 (TLS, ports 6466/6467) | Pairing flow has a 2017 AOSP repo; the v2 message schema is **reverse-engineered** | Key injection, deep-link app launch, pushed power/volume/foreground-app state, no developer mode | No command ACK; no HDMI-port readback; any LAN device that can read the on-screen code can pair | Production candidate **only if the user accepts the documentation risk** (section 2) |
| ADB over the network | **OFFICIAL**, but a debug interface | Richest readback (dumpsys, absolute volume, passthrough-input intents) | Fragile per-version parsing; botnet-targeted; wireless debugging on TV needs Android 13+ | Phase 4 test harness only, staff subnet only, disabled afterwards |
| Companion Kotlin APK | Built on **OFFICIAL** public APIs | Ads and the expired screen; reports its own foreground lifecycle | Cannot block Home/Input keys, see HDMI content, or reliably bring itself to the front | Only if the HARDWARE_LIMITATIONS.md companion-app decision gate is passed |
| HDMI-CEC | **OFFICIAL**: system-only API | Nothing usable by the server or an APK | A bypass route: PS5 One-Touch Play can switch the TV back to the PS5 | Turn it off; test the bypass |

Recommended direction, if and when the user approves (section 2) and a physical test record exists:

- Remote v2 for keys and app-link launches.
- The companion app's heartbeat for idle/expired-screen evidence.
- Absolute `KEYCODE_TV_INPUT_HDMI_n` (243-246) or a per-model passthrough URI for input switching, always reported as `UNVERIFIED` for the exact port.
- `KEYCODE_WAKEUP` / `KEYCODE_SLEEP` (224/223) for power instead of the POWER toggle, so a retry is safe.
- `secureDisplayBlocking: false` for every mechanism, always.

## 2. Android TV Remote protocol v2

### 2.1 What it is

This is the protocol the Google TV mobile app uses. It depends on the preinstalled "Android TV Remote Service" on the TV (Amazon Fire TV does not have it) and needs no ADB or developer mode ([Home Assistant Android TV Remote integration](https://www.home-assistant.io/integrations/androidtv_remote/), COMMUNITY).

### 2.2 Transport and pairing (COMMUNITY / REVERSE-ENGINEERED)

- **Transport:** TLS. Pairing runs on TCP **6467**, the control session on TCP **6466**. Both sides use self-signed certificates; the client keeps its certificate and private key as its long-term credential ([androidtvremote2 `pairing.py`](https://raw.githubusercontent.com/tronikos/androidtvremote2/main/src/androidtvremote2/pairing.py), [Freebox wiki](https://github.com/Aymkdn/assistant-freebox-cloud/wiki/Google-TV-(aka-Android-TV)-Remote-Control-(v2))).
- **Pairing sequence:** `pairing_request` -> options (HEXADECIMAL encoding, 6 symbols) -> configuration -> the TV shows a **6-character hex code** -> the client sends SHA-256 over (client modulus, client exponent, server modulus, server exponent, `code[2:]`). The first byte of the hash must equal `code[0:2]`.
- **Step timeout:** the reference library waits up to 10 s per pairing step.

### 2.3 Official status

Confirmed (OFFICIAL):

- Google's user help page describes pairing a phone by entering the code shown on the TV, with phone and TV on the same Wi-Fi ([Google Android TV help](https://support.google.com/androidtv/answer/6122465?hl=en)).
- The only Google source code is the AOSP [`google-tv-pairing-protocol`](https://android.googlesource.com/platform/external/google-tv-pairing-protocol/+/refs/heads/master) repository; its last displayed commit is dated 2017-01-18.

Not official (COMMUNITY / REVERSE-ENGINEERED):

- The v2 message schema ([`remotemessage.proto`](https://raw.githubusercontent.com/tronikos/androidtvremote2/main/src/androidtvremote2/remotemessage.proto)) comes from third parties. Several fields are named `unknown1`, `unknown2`, `int13`, and the [Freebox wiki](https://github.com/Aymkdn/assistant-freebox-cloud/wiki/Google-TV-(aka-Android-TV)-Remote-Control-(v2)) marks many fields `??`.
- The same wiki says Google has used v2 since September 2021 with Remote Service v5 (UNVERIFIED from Google).

### 2.4 Policy conflict the user must resolve

[AGENTS.md](../../AGENTS.md) says: *do not send a manufacturer command unless it is documented, capability-gated, bounded by a timeout, and tested on the target physical model.* Remote v2 is Google's own protocol, used by Google's own app, but it has **no public specification**. Someone with authority must decide explicitly whether third-party documentation plus a per-model physical test record counts as "documented". Until that decision is recorded, no Remote v2 code should be written into the server. See [README.md, decisions](README.md#decisions-needed-from-the-user).

## 3. Capabilities and limits of Remote v2

### 3.1 What it can do (COMMUNITY, from the reference library and proto)

| Capability | Message | Detail |
|---|---|---|
| Inject Android key codes | `remote_key_inject` (SHORT / START_LONG / END_LONG) | The proto enum includes `KEYCODE_TV_INPUT=178`, `KEYCODE_TV_INPUT_HDMI_1..4=243..246`, `KEYCODE_POWER=26`, `KEYCODE_TV_POWER=177`, `KEYCODE_SLEEP=223`, `KEYCODE_WAKEUP=224`, `KEYCODE_VOLUME_MUTE=164` |
| Launch an app by deep link | `remote_app_link_launch_request` | The link must match an `android:host` the target app registers in its manifest |
| Receive pushed power state | `remote_start.started` | `is_on` |
| Receive pushed foreground app | `remote_ime_key_inject.app_info.app_package` | Current foreground package name |
| Receive pushed volume | `remote_set_volume_level` | `volume_level`, `volume_max`, `volume_muted` |
| Negotiate features | `remote_configure` | Feature bits: PING, KEY, IME, VOICE, POWER, VOLUME, APP_LINK |

Key code numbers are also **OFFICIAL** in the Android [`KeyEvent`](https://developer.android.com/reference/android/view/KeyEvent) reference.

Sources: [`remotemessage.proto`](https://raw.githubusercontent.com/tronikos/androidtvremote2/main/src/androidtvremote2/remotemessage.proto), [`remote.py`](https://raw.githubusercontent.com/tronikos/androidtvremote2/main/src/androidtvremote2/remote.py), [`androidtv_remote.py`](https://raw.githubusercontent.com/tronikos/androidtvremote2/main/src/androidtvremote2/androidtv_remote.py).

### 3.2 What it cannot do

- **No command acknowledgement.** In the reference library, `send_key_command` and `send_launch_app_command` "do not block; [they] buffer the data and arrange for it to be sent out asynchronously" ([`androidtv_remote.py`](https://raw.githubusercontent.com/tronikos/androidtvremote2/main/src/androidtvremote2/androidtv_remote.py), COMMUNITY). A send can only be confirmed by a later state push.
- **No absolute volume.** The reference implementation sends only VOLUME_UP/DOWN keys; `remote_set_volume_level` is handled as TV -> client (COMMUNITY).
- **No HDMI-port readback.** Home Assistant exposes no HDMI input for this integration ([HA docs](https://www.home-assistant.io/integrations/androidtv_remote/); [HA community thread](https://community.home-assistant.io/t/android-tv-hdmi/234411?page=5)).
- **No installed-app list.** Launch by application ID "currently doesn't work" for many apps (HA docs).
- **No guarantee that a key works.** HA: "Whether a command does something depends on your Android TV device, its firmware, and the app in the foreground." HA's documented key list does not include the HDMI keys, so `HDMI_n` support is **UNVERIFIED on every model**.

## 4. Liveness and reconnect (feeds TIMEOUT and DEVICE_OFFLINE design)

| Behaviour | Value | Evidence | Adapter consequence |
|---|---|---|---|
| TV ping interval when idle | about 5 s | COMMUNITY ([`remote.py`](https://raw.githubusercontent.com/tronikos/androidtvremote2/main/src/androidtvremote2/remote.py), Freebox wiki) | Treat pings as liveness |
| Client idle close | 16 s with no message (matches the TV closing after 3 unanswered pings) | COMMUNITY | A dead TV can take up to ~16 s to be detected; show `CONNECTING`/stale before `OFFLINE` |
| Reconnect backoff | starts at 0.1 s, doubles, capped at 30 s | COMMUNITY ([`androidtv_remote.py`](https://raw.githubusercontent.com/tronikos/androidtvremote2/main/src/androidtvremote2/androidtv_remote.py)) | Reuse as a starting point; add jitter (ARCHITECTURE.md) |
| Retries on | `CannotConnect`, `ConnectionClosed` | COMMUNITY | Map to `DEVICE_OFFLINE` while retrying |
| Stops on | `InvalidAuth` (pairing revoked) | COMMUNITY | Return `FAILURE` with "re-pair required" and raise a staff task; never retry endlessly |
| Connect timeout | none in the library | COMMUNITY | The adapter must add its own bounded timeout that yields `TIMEOUT` |

Device-specific reports (all COMMUNITY via [Home Assistant](https://www.home-assistant.io/integrations/androidtv_remote/) unless noted; all UNVERIFIED per model):

- "Some devices experience disconnects every 15 seconds"; the usual fix is a reboot after setup.
- Xiaomi sets "become unavailable after they are turned off and can't be turned on with this integration".
- TCL needs its "Screenless service" enabled.
- Sony documents a "Remote start" setting that must be on for apps to power the TV on ([Sony Asia support](https://www.sony-asia.com/electronics/support/televisions-projectors-lcd-tvs-android-/k-85s30/articles/00364921), OFFICIAL).
- Android TV 13 added a Low Power Standby mode that blocks network access; secondary news sources say it is off by default ([AFTVnews](https://www.aftvnews.com/android-tv-13-adds-new-low-power-standby-mode-to-reduce-power-consumption/), [PhoneArena](https://www.phonearena.com/news/Android-TV-13-low-power-mode-smart-tvs_id139672); COMMUNITY, UNVERIFIED from Google).

**UNVERIFIED:** no official figure exists for HDMI input-switch or HDCP re-handshake latency. Set verification windows from the measured per-model p99 in the physical test record; do not hard-code a guess.

## 5. Security: customers can pair their own phones

Google's documented flow (OFFICIAL, [help](https://support.google.com/androidtv/answer/6122465?hl=en), [Google TV help](https://support.google.com/googletv/answer/15766805?hl=en&co=GENIE.Platform%3DAndroid)): open the Google TV app, tap Connect TV, enter the code shown on the TV, tap Pair. Phone and TV must be on the same Wi-Fi.

In a gaming café the customer is looking at the TV, so they can read the code. If the customer Wi-Fi can reach TCP 6466/6467, any customer can pair a phone and press Input or HDMI during an expired session.

Requirements before any Remote v2 deployment:

- TVs on a **staff-only SSID/VLAN** with client isolation; customer Wi-Fi is not routed to the TV subnet. This is a network change and needs explicit user approval.
- The client certificate and private key are credentials: store them encrypted, as [ARCHITECTURE.md](../ARCHITECTURE.md#persistence) already requires.
- Revocation is coarse. Home Assistant's documented reset is to force-stop and clear the storage of the Android TV Remote Service on the TV, which presumably drops every pairing (COMMUNITY; UNVERIFIED per model).
- UNVERIFIED: whether the TV allows several paired controllers at once, and whether the pairing-code prompt overlays an HDMI input.

## 6. Proposed TvAdapter mapping and outcome rules

The interface is `TvAdapter` in [`apps/server/src/adapters.ts`](../../apps/server/src/adapters.ts). Nothing below exists in code.

### 6.1 Method mapping (Remote v2)

| `TvAdapter` method | Proposed mechanism | Outcome rules |
|---|---|---|
| `connect()` | TLS to 6466 with the stored certificate; complete the `remote_configure` / `remote_start` handshake | `SUCCESS`, `verified: true` only after the handshake. `InvalidAuth` -> `FAILURE` ("re-pair required"). Unreachable -> `DEVICE_OFFLINE`. No handshake within the bound -> `TIMEOUT`. |
| pairing (new, not `connect()`) | Separate staff action under Device Settings; a human reads the 6-hex code off the TV | About 30 s bound. Never automatic. |
| `getCapabilities()` | Intersection of negotiated feature bits and the model's physical test record | Never inferred from brand alone. |
| `getDeviceStatus()` | Cached pushed state: `power = is_on`; volume scaled to 0-100 from `level/max`; `muted` | **Do not invent an HDMI port**: input is unknown/null or `APP:<package>`. `displayedMode` only when the foreground package is the companion app. |
| `powerOn()` / `powerOff()` | `KEYCODE_WAKEUP` (224) / `KEYCODE_SLEEP` (223) | `KeyEvent` (OFFICIAL) says each has no effect if the device is already in that state, so a retry is safe. Never `POWER` (26) or `TV_POWER` (177), which toggle. Verify through the `is_on` push or return `TIMEOUT`. Wake from standby is vendor-specific. |
| `setVolume(n)` | Closed-loop VOLUME_UP/DOWN stepping with readback | Not idempotent unless driven by readback. `UNVERIFIED` if volume is routed to CEC or a soundbar. |
| `mute()` | `KEYCODE_VOLUME_MUTE` (toggle) | Verify with the `muted` push. Do not retry blindly; see the `setMuted(boolean)` proposal in 6.3. |
| `sendRemoteKey(k)` | Map `RemoteKey` to `KEYCODE_*` | Always `UNVERIFIED` (no ACK). |
| `switchInput("HDMIn")` | `KEYCODE_TV_INPUT_HDMI_n` (243 + n - 1) | Best possible result is `UNVERIFIED` **for the exact port**, even if `current_app` changes to the vendor's TV-input package. **Never** automate `KEYCODE_TV_INPUT` (178). |
| `launchApp(link)` | `remote_app_link_launch_request` | `SUCCESS`, `verified: true` only if `current_app` equals the target package within the bound; otherwise `TIMEOUT`. |
| `enterIdleMode()` / `enterExpiredMode()` | App-link launch of the companion APK's idle/expired screen | As `launchApp`. Expired-screen evidence is the companion heartbeat (section 8). |
| `enterGamingMode(input)` | `switchInput` plus confirmation that the foreground app is no longer the companion app | Still `UNVERIFIED` for the port. |

Why absolute input keys: `KEYCODE_TV_INPUT_HDMI_1` is documented as "Switches to HDMI input #1", an absolute target. `KEYCODE_TV_INPUT` "switches the input on a television screen", which opens a selector or cycles inputs; it is not idempotent ([`KeyEvent`](https://developer.android.com/reference/android/view/KeyEvent), OFFICIAL). The TV Input Framework docs say "The TV App is in focus and receives all keys", and the system TV App "can't be replaced by a third-party app" ([AOSP TV docs](https://source.android.com/docs/devices/tv), OFFICIAL), so key and passthrough behaviour depends on the vendor's TV App.

The contract `RemoteKey` has only `"INPUT"` (REPO, `packages/contracts/src/index.ts`). Keep it for the manual virtual remote. The automated `switchInput` path, which already validates `HDMI1`-`HDMI4` (REPO, `apps/server/src/validation.ts`, `INPUT_PATTERN`), should map to absolute `HDMI_n` keys or a per-model passthrough URI recorded in the device profile.

### 6.2 Honest `DeviceCapabilities` (only after a per-model test record)

| Flag | Proposed value | Condition |
|---|---|---|
| `remoteKeys` | true | Keys accepted, results always `UNVERIFIED` |
| `volume` | true (relative only) | Readback via push |
| `mute` | true | Toggle verified by push |
| `applicationLaunch` | true | Deep links only |
| `power` | true only if wake from standby is proven on that model | Otherwise false |
| `inputSwitching` | true only if `HDMI_n` keys are proven on that model | Port still `UNVERIFIED` |
| `advertisingPlayback` | false | Unless the companion app exists |
| `stateVerification` | partial: power, volume, foreground app; **not input** | The current single boolean cannot express this (6.3) |
| `secureDisplayBlocking` | **false, always** | No mechanism here is tamper-proof |

### 6.3 Repository prerequisites (REPO findings; not fixed by this document)

- **Persist before awaiting the adapter.** `execute()` mutates the in-memory row and session, awaits the adapter command, records the command, then awaits `adapter.getDeviceStatus()` with no timeout before `persist()`. `UnverifiedTvAdapter.getDeviceStatus()` always throws. A real adapter that throws or hangs leaves memory and SQLite out of step, or stalls that station's queue. Fix: persist the server-authoritative transition first, bound every adapter call (including status) with a timeout that yields `TIMEOUT`, and make status reads non-throwing. See the readiness checklist in [README.md](README.md#pre-adapter-readiness-checklist) for which parts were assigned to the 2026-10-25 slice.
- **Runtime typed to the mock.** `RuntimeStation.adapter` is declared as `MockTvAdapter`, and `SET_CONNECTION`, `SIMULATE_NEXT_FAILURE`, `SIMULATE_UNSUPPORTED` call mock-only methods on the generic action path. Needed: an adapter factory keyed by `adapter_kind` (real kinds off by default), a `SimulationControls` interface rejected with 400 on real stations, and pairing as a separate action.
- **Contracts too coarse.** `DeviceState` fields are non-null; Remote v2 has no input readback and no `displayedMode` without the companion app. Needed: nullable "unknown" fields plus provenance (`observedAt`, `source: push | poll | assumed`), a versioned `device_state_json` migration, per-dimension readback flags (`powerReadback`, `volumeReadback`, `foregroundAppReadback`, `inputReadback`, `companionHeartbeat`), and `setMuted(boolean)` instead of a toggle.
- **Blocking evaluated once.** `blockingStatus` is computed only from the `enterExpiredMode()` result. With push-capable mechanisms the server should subscribe to state changes: if the companion app leaves the foreground, its socket drops, or `is_on` goes false, blocking moves from `CONFIRMED` to `FAILED` or `UNVERIFIED` and staff get an alert. `CONFIRMED` should read "expired screen observed in front (software only)", never "locked".

## 7. ADB: officially documented, but a debug interface

### 7.1 Confirmed facts (OFFICIAL, [adb docs](https://developer.android.com/tools/adb), [dumpsys docs](https://developer.android.com/tools/dumpsys))

- Wireless debugging needs "Android 13 (API level 33) or higher for TV", the same network, and a pairing code or QR code.
- On Android 10 and lower the legacy route is `adb tcpip 5555` after a USB connection.
- An RSA-key dialog "ensures that USB debugging and other adb commands cannot be executed unless you're able to unlock the device and acknowledge the dialog". Ticking "always allow on this network" trusts the whole network.
- Revoke with "Forget" or "Revoke adb debugging authorizations".
- `dumpsys` output "varies depending on the version of Android".

### 7.2 Observed in practice (COMMUNITY)

- Home Assistant's ADB integration polls; it says "there is no standard API for determining the state of the device" and warns "Only one device can be connected". Some Philips TVs accept the first ADB connection only over Wi-Fi ([HA androidtv](https://www.home-assistant.io/integrations/androidtv/)).
- python-androidtv needs separate foreground-app commands for Android 11, 12, 13+ and Google TV ([`constants.py`](https://raw.githubusercontent.com/JeffLIrion/python-androidtv/master/androidtv/constants.py)), which shows how brittle parsing is.
- An AOSP-derived change notes the wireless-debugging port can change when `adbd` restarts ([OmniROM gerrit](https://gerrit.omnirom.org/plugins/gitiles/android_frameworks_base/+/8ee00491ac0ca81b0263f0b2c9b3cd1507e2559a%5E%21)).
- Forum reports say wireless debugging turns off after every reboot on Android 14 TV ([Channels community](https://community.getchannels.com/t/adbtuner-a-channel-tuning-application-for-networked-google-tv-android-tv-devices/36822?page=95); UNVERIFIED).

### 7.3 Threat

- Exposed TCP 5555 is actively exploited: ADB.Miner in 2018 (about 7,400 IPs in its first days, [BleepingComputer](https://bleepingcomputer.com/news/security/android-devices-targeted-by-new-monero-mining-botnet)), Ares on set-top boxes ([Dark Reading](https://www.darkreading.com/attacks-breaches/new-botnet-targets-android-set-top-boxes/d/d-id/1335688)), and a Mirai-derived botnet targeting smart TVs in 2026 ([GBHackers](https://gbhackers.com/adb-exposed-android-devices/)).
- Some insecure vendor builds grant a shell without the prompt (COMMUNITY).
- A customer could accept a rogue host's authorisation prompt on screen, and Developer options stay visible in the TV's settings.

### 7.4 Policy

ADB belongs only in the planned Phase 4 test harness (input-ID discovery, latency measurement). Bind it to a staff-only subnet, never expose it to the WAN or the customer network, and turn it off afterwards unless the user explicitly accepts the risk. [AGENTS.md](../../AGENTS.md) forbids exposing ADB publicly.

### 7.5 ADB mapping (test harness only)

| Method | Mechanism | Notes |
|---|---|---|
| `connect()` | `adb connect ip:port`, bounded | Authorisation pending or refused -> `FAILURE`; unreachable -> `DEVICE_OFFLINE` |
| `getDeviceStatus()` power | `dumpsys power` (`mWakefulness`) | Per-version parsing |
| `getDeviceStatus()` foreground app | per-version `dumpsys window` / `activity` variants | Parse failure -> unknown, never a guess |
| `getDeviceStatus()` HDMI port | `dumpsys tv_input` (Android 11 variant) or `dumpsys activity starter` hardware-ID parsing | The **only** mechanism with possible HDMI readback, and fragile |
| `switchInput` | `am start -a android.intent.action.VIEW -d content://android.media.tv/passthrough/<inputId>`, the URI form of the OFFICIAL [`TvContract.buildChannelUriForPassthroughInput`](https://developer.android.com/reference/android/media/tv/TvContract) (API 21, "pass-through inputs (e.g. HDMI)"), or `input keyevent 243..246` | `inputId` is vendor-specific (e.g. `com.tcl.tvinput`, `com.mediatek.tvinput`, `com.droidlogic.tvinput` plus hardware IDs); Philips needed an explicit component. Reports say the URI broke after an OS update (COMMUNITY) |
| `launchApp` | `am start` | OFFICIAL |
| `setVolume` | `cmd media_session volume --stream 3 --set N` (Android 11+, per python-androidtv) | Absolute and idempotent |

Capability flags after testing: power, volume, mute, remoteKeys, inputSwitching and applicationLaunch could be true; stateVerification partial; `secureDisplayBlocking: false`.

## 8. Companion foreground APK

The [HARDWARE_LIMITATIONS.md decision gate](../HARDWARE_LIMITATIONS.md#companion-app-decision-gate) still applies: build the APK only if supported server-side controls cannot show the advertising and expired screens.

**Can (OFFICIAL APIs):**

- Play ads and show the expired screen with hardware decoding.
- Hold an outbound WebSocket to the server and report lifecycle events: `onResume` means "it comes to the foreground"; `onStop` means "no longer visible to the user" ([activity lifecycle](https://developer.android.com/guide/components/activities/activity-lifecycle)). This is the strongest evidence available that "our expired screen is in front at time T".
- Embed HDMI with [`TvView`](https://developer.android.com/reference/android/media/tv/TvView) (`tune(inputId, channelUri)`); TIF says third-party inputs can display "content from a device manufacturer's passthrough TV inputs" ([AOSP TV](https://source.android.com/docs/devices/tv)). **UNVERIFIED** that a non-input client app can tune HDMI on a given model, or that ALLM/game mode and latency survive. `Window.setPreferMinimalPostProcessing` exists from Android 11 ([TV games guide](https://developer.android.com/training/tv/games)).

**Cannot:**

- Block Home, Input, TV panel buttons or a reboot. The system TV App receives the keys, and "Third-party TV inputs never receive keys" ([AOSP TV](https://source.android.com/docs/devices/tv)). The TV app quality guideline requires Back to lead to the home screen for Play distribution ([TV app quality](https://developer.android.com/docs/quality-guidelines/tv-app-quality)).
- See what the HDMI source shows.
- Bring itself to the front from the background. Since Android 10, background activity starts are blocked unless an exception applies, such as a visible window or a user-granted `SYSTEM_ALERT_WINDOW` ([background starts](https://developer.android.com/guide/components/activities/background-starts)). [`Settings.ACTION_MANAGE_OVERLAY_PERMISSION`](https://developer.android.com/reference/android/provider/Settings) warns "a matching Activity may not exist". Granting it through `adb appops` is reported for Fire OS only ([PlaySignage](https://playsignage.com/setup/amazon-firetv-launch-on-startup/); UNVERIFIED on Google TV).
- Survive reliably once stopped: the system "can destroy your application's process while the user is away and your activity is stopped", so it must cold-start from a deep link.

Implication: the server would foreground the APK with a Remote v2 app-link launch, which comes from a system service; the APK then confirms by heartbeat. **UNVERIFIED** whether that launch bypasses the background-start limits.

## 9. HDMI-CEC: unusable by the server, and a bypass route

- Android exposes CEC through `HdmiControlManager`, a `@SystemApi`: "Access to the HDMI-CEC service is guarded with the protection level SignatureOrSystem" ([AOSP HDMI-CEC](https://source.android.com/docs/devices/tv/hdmi-cec), OFFICIAL). No `HDMI_CEC` or `TV_INPUT_HARDWARE` permission appears in the public [`Manifest.permission`](https://developer.android.com/reference/android/Manifest.permission) reference (checked 2026-10-25). Android says "Each manufacturer implements the HDMI-CEC standard in different ways".
- **Bypass:** third-party guides say the PS5's Settings > System > HDMI > Enable HDMI Device Link / Enable One-Touch Play turns the TV on and switches it to the PS5 input ([Tom's Guide](https://www.tomsguide.com/tvs/heres-how-to-stop-your-tv-from-turning-on-your-xbox-or-ps5), [SlashGear](https://www.slashgear.com/1694295/stop-playstation-from-turning-on-tv/); COMMUNITY, UNVERIFIED from Sony). A customer who wakes the PS5 during an expired session could therefore return the TV to HDMI with no remote involved.
- `KEYCODE_TV_POWER` on an HDMI TV panel "toggles the power state", so it is not idempotent ([`KeyEvent`](https://developer.android.com/reference/android/view/KeyEvent)).
- An external libCEC adapter ([Pulse-Eight libcec](https://github.com/Pulse-Eight/libcec)) could send Active Source or Standby, but the PS5 contends on the same bus, so it is not secure either; it belongs to the future hardware track. Using CEC to put the PS5 in standby would be PS5 control, which AGENTS.md forbids.

Per-station setup checklist (manual configuration, not software PS5 control):

1. Disable CEC on the TV (vendor names include Anynet+, SimpLink, Bravia Sync).
2. Optionally disable HDMI Device Link and One-Touch Play on the PS5; a customer can turn these back on, so the TV-side setting is what matters.
3. Confirm volume still works: Google TV's remote volume setting may be "Auto (CEC)" ([Google TV help](https://support.google.com/googletv/answer/15766805?hl=en&co=GENIE.Platform%3DAndroid)).
4. Run the "CEC wake after expiry" test row ([README.md](README.md#proposed-new-rows-for-hardware_limitationsmd-not-applied)).

## 10. Verification matrix: what can actually be read back

No mechanism verifies the pixels on an HDMI input.

| Mechanism | Power | Volume / mute | Foreground app | HDMI port | Delivery |
|---|---|---|---|---|---|
| Remote v2 | yes | yes | yes (package name) | **no** | push |
| ADB | yes | yes | yes | sometimes, fragile | poll |
| Companion APK | no | no | own visibility only | no | push |
| CEC (server or APK) | no access | no access | no access | no access | n/a |

- UNVERIFIED for Remote v2: whether `current_app` changes when the TV switches to HDMI, and to which vendor package.
- Screen capture is not an option: AGENTS.md forbids continuous capture, and PS5 output is HDCP-protected by default, so a capture would likely be black ([PowerPyx](https://www.powerpyx.com/ps5-how-to-disable-hdcp/), COMMUNITY; UNVERIFIED on TVs).

Rules for `CommandResult.verified`:

- `verified: true` only when a readback taken **after** the command matches the target within a bounded window.
- Fire-and-forget sends stay `UNVERIFIED`.
- No confirming push within the window -> `TIMEOUT`.

## 11. Library landscape

| Library | Licence | Activity | Assessment |
|---|---|---|---|
| [tronikos/androidtvremote2](https://github.com/tronikos/androidtvremote2) (Python) | Apache-2.0 | GitHub last push 2026-10-05; 1 open issue | Behind Home Assistant's integration; the most current reference for message handling, ping/idle rules and reconnect backoff |
| [louis49/androidtv-remote](https://github.com/louis49/androidtv-remote) (npm `androidtv-remote`) | MIT | npm latest 1.0.10 dated 2022-01-09 by the [registry](https://registry.npmjs.org/androidtv-remote); last repo push 2023-07-06; 14 open issues; no releases | Describes itself as "Reverse-engineered PairingSession + RemoteManager protocols over TLS". Looks stale; do not depend on it without review |

Options, either of which stays disabled until a physical test record exists:

1. Port the small protobuf and TLS layer into a TypeScript adapter with recorded-fixture tests.
2. Run a supervised local Python sidecar (adds an operational dependency).

No dependency was added to this repository.

## 12. Rejected or deferred

- **Google Cast:** custom receivers need a Google Cast SDK Developer Console registration with a non-refundable US$5 fee ([registration](https://developers.google.com/cast/docs/registration), [terms](https://developers.google.com/cast/docs/terms)); test devices must also be registered. That is a paid service requiring explicit user approval, and Cast cannot switch HDMI inputs. Out of scope.
- **Lock task / device-owner kiosk:** needs a device-policy controller to allowlist packages ([lock task mode](https://developer.android.com/work/dpc/dedicated-devices/lock-task-mode?hl=nl)). Third-party guides say `dpm set-device-owner` requires removing accounts and undoing it needs a factory reset ([B4X forum](https://b4x.com/android/forum/posts/535470), COMMUNITY). No official source confirms support on Android TV / Google TV or that it blocks the TV App's Input key (UNVERIFIED). Even if it works, it is a software control and cannot be called tamper-proof. Deferred.

## 13. Risks and sources

### 13.1 Risks

- **Policy:** Remote v2 has no public Google spec; using it conflicts with AGENTS.md unless the user explicitly accepts third-party documentation plus a per-model physical test record.
- **Customer bypass is always possible** on consumer Android TVs: Input/Home keys, panel buttons, a reboot, PS5 One-Touch Play, or pairing a phone if the TV subnet is reachable.
- **No ACK:** treating a Remote v2 send as `SUCCESS` would break the rule that a successful command is not a verified screen state.
- **No HDMI readback** except fragile ADB parsing; gaming-mode transitions will at best be `UNVERIFIED` for the exact input.
- **ADB exposure:** shell-level debug surface; port 5555 actively exploited 2018-2026.
- **Firmware drift:** updates can break passthrough IDs, dumpsys parsing, HDMI key handling or the Remote Service. Pin profiles to tested firmware and flag changes for re-test.
- **Standby variation:** some TVs drop off the network, cannot be woken over LAN, or need settings such as Sony "Remote start" or TCL "Screenless service".
- **Latent repo defect** in `execute()` (section 6.3) must be fixed before any non-mock adapter.
- **Companion APK foregrounding** and third-party `TvView` HDMI playback are both unverified.
- **Secondary-source claims** are marked UNVERIFIED: PS5 One-Touch Play (official PS5 manual text not retrieved), Android 14 TV wireless debugging reset, Android TV 13 Low Power Standby details, input-switch latency.

### 13.2 Sources (accessed 2026-10-25)

OFFICIAL:

- Google Android TV help, pairing a phone: https://support.google.com/androidtv/answer/6122465?hl=en
- Google TV help, remote and CEC settings: https://support.google.com/googletv/answer/15766805?hl=en&co=GENIE.Platform%3DAndroid
- AOSP google-tv-pairing-protocol: https://android.googlesource.com/platform/external/google-tv-pairing-protocol/+/refs/heads/master
- Android `KeyEvent`: https://developer.android.com/reference/android/view/KeyEvent
- Android TV Input Framework: https://source.android.com/docs/devices/tv
- Android HDMI-CEC: https://source.android.com/docs/devices/tv/hdmi-cec
- `Manifest.permission` (checked 2026-10-25): https://developer.android.com/reference/android/Manifest.permission
- ADB: https://developer.android.com/tools/adb
- dumpsys: https://developer.android.com/tools/dumpsys
- `TvContract`: https://developer.android.com/reference/android/media/tv/TvContract
- `TvView`: https://developer.android.com/reference/android/media/tv/TvView
- Activity lifecycle: https://developer.android.com/guide/components/activities/activity-lifecycle
- Background activity starts: https://developer.android.com/guide/components/activities/background-starts
- `Settings`: https://developer.android.com/reference/android/provider/Settings
- TV app quality: https://developer.android.com/docs/quality-guidelines/tv-app-quality
- TV games: https://developer.android.com/training/tv/games
- Lock task mode: https://developer.android.com/work/dpc/dedicated-devices/lock-task-mode?hl=nl
- Google Cast registration and terms: https://developers.google.com/cast/docs/registration, https://developers.google.com/cast/docs/terms
- Sony Asia, Remote start: https://www.sony-asia.com/electronics/support/televisions-projectors-lcd-tvs-android-/k-85s30/articles/00364921

COMMUNITY / REVERSE-ENGINEERED:

- androidtvremote2 repository and sources: https://github.com/tronikos/androidtvremote2, https://raw.githubusercontent.com/tronikos/androidtvremote2/main/src/androidtvremote2/pairing.py, https://raw.githubusercontent.com/tronikos/androidtvremote2/main/src/androidtvremote2/androidtv_remote.py, https://raw.githubusercontent.com/tronikos/androidtvremote2/main/src/androidtvremote2/remote.py, https://raw.githubusercontent.com/tronikos/androidtvremote2/main/src/androidtvremote2/remotemessage.proto
- Freebox wiki, Remote v2: https://github.com/Aymkdn/assistant-freebox-cloud/wiki/Google-TV-(aka-Android-TV)-Remote-Control-(v2)
- Home Assistant Android TV Remote: https://www.home-assistant.io/integrations/androidtv_remote/
- Home Assistant Android TV (ADB): https://www.home-assistant.io/integrations/androidtv/
- Home Assistant community, Android TV HDMI: https://community.home-assistant.io/t/android-tv-hdmi/234411?page=5
- python-androidtv constants: https://raw.githubusercontent.com/JeffLIrion/python-androidtv/master/androidtv/constants.py
- OmniROM change (adbd port): https://gerrit.omnirom.org/plugins/gitiles/android_frameworks_base/+/8ee00491ac0ca81b0263f0b2c9b3cd1507e2559a%5E%21
- louis49/androidtv-remote and npm registry: https://github.com/louis49/androidtv-remote, https://registry.npmjs.org/androidtv-remote
- Pulse-Eight libcec: https://github.com/Pulse-Eight/libcec
- Tom's Guide (PS5/Xbox CEC): https://www.tomsguide.com/tvs/heres-how-to-stop-your-tv-from-turning-on-your-xbox-or-ps5
- SlashGear (PlayStation CEC): https://www.slashgear.com/1694295/stop-playstation-from-turning-on-tv/
- PowerPyx (PS5 HDCP): https://www.powerpyx.com/ps5-how-to-disable-hdcp/
- PlaySignage (Fire TV launch on startup): https://playsignage.com/setup/amazon-firetv-launch-on-startup/
- B4X forum (device owner): https://b4x.com/android/forum/posts/535470
- AFTVnews and PhoneArena (Low Power Standby): https://www.aftvnews.com/android-tv-13-adds-new-low-power-standby-mode-to-reduce-power-consumption/, https://www.phonearena.com/news/Android-TV-13-low-power-mode-smart-tvs_id139672
- Security reporting: https://bleepingcomputer.com/news/security/android-devices-targeted-by-new-monero-mining-botnet, https://www.darkreading.com/attacks-breaches/new-botnet-targets-android-set-top-boxes/d/d-id/1335688, https://gbhackers.com/adb-exposed-android-devices/

UNVERIFIED (forum report only):

- Channels community, Android 14 TV wireless debugging: https://community.getchannels.com/t/adbtuner-a-channel-tuning-application-for-networked-google-tv-android-tv-devices/36822?page=95

## 14. Physical verification checklist

Nothing below has been tested. Record every row per manufacturer, exact model, region, Android/Google TV version and firmware, in the format of [docs/HARDWARE_LIMITATIONS.md](../HARDWARE_LIMITATIONS.md#minimum-test-record-per-model), before any Android/Google profile is enabled.

| Field | Required evidence |
|---|---|
| Identity | Manufacturer, exact model, region/SKU, Android TV or Google TV version, firmware build, Android TV Remote Service version |
| Policy | Recorded user decision on accepting the reverse-engineered Remote v2 protocol (section 2.4) |
| Pairing | Remote v2 pairing steps with the 6-hex code; pairing-prompt behaviour over HDMI; number of simultaneous paired controllers; revocation by clearing Remote Service storage and the resulting `InvalidAuth` |
| Network | Ports 6466/6467 reachable from the staff subnet only; not reachable from customer Wi-Fi; reconnect after a DHCP change |
| Liveness | Measured time to detect a powered-off or unplugged TV; reconnect backoff behaviour; any periodic 15 s disconnects |
| Power | `KEYCODE_WAKEUP`/`KEYCODE_SLEEP` effect from on, screen-off and deep standby; repeat-send idempotence; `is_on` push timing; vendor settings needed (Remote start, Screenless service, Low Power Standby) |
| Volume / mute | VOLUME_UP/DOWN step size against `volume_max`; mute push; behaviour with CEC/soundbar audio routing |
| Each HDMI input | `KEYCODE_TV_INPUT_HDMI_1..4` selects the correct physical port on this model; what `current_app` reports after each; passthrough URI and `inputId` if ADB was used to discover it |
| App launch | Deep-link launch of the companion app (if built) from standby, from HDMI and from another app; time to foreground; background-start behaviour |
| Modes | Idle advertising, gameplay transition to the PS5 input, expiry transition; measured p50/p99 latency for each |
| Verification | Which fields are pushed versus assumed; that a send with no confirming push becomes `TIMEOUT`; that no HDMI port is ever reported as verified |
| Bypass | Remote INPUT/HOME, panel buttons, phone pairing from the customer network, reboot, mains power cycle, and PS5 controller wake with CEC on and off during an expired session |
| Recovery | Standby, reboot, server restart, TV offline at expiry then reconnect (expired mode re-applied?), authorisation revoked |
| ADB (test harness only) | Android version allows wireless debugging; authorisation prompt behaviour; port after reboot; ADB disabled again and Developer options state recorded after the test |
| Performance | Gameplay latency and ALLM/game-mode behaviour on the PS5 input; companion app idle CPU/RAM and decoder release before HDMI |
| Security | Certificate and key storage (encrypted); exposed services scan of the TV; firewall/VLAN configuration recorded |

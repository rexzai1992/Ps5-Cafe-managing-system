# Samsung TV and Display Control Research

Research date: 2026-10-25 (Asia/Kuala_Lumpur). All URLs below were accessed on that date unless a different date is given.
Audience: engineers who will later build and physically verify a Samsung adapter profile, and the café owner choosing displays.

> **Status: research only. Nothing in this document is implemented or physically verified in this repository.**
> No Samsung TV or display was contacted. No Samsung endpoint or command is encoded in the server ([ARCHITECTURE.md](../ARCHITECTURE.md#adapter-contract)); the `"samsung-tizen"` `AdapterKind` exists only as a label, and every station is still a `MockTvAdapter`. Any Samsung profile stays **disabled** until the matrix in [`docs/HARDWARE_LIMITATIONS.md`](../HARDWARE_LIMITATIONS.md) is recorded for the exact model and firmware. Purchases, service registrations, service-menu changes and network changes all need explicit user approval.

Evidence labels follow [README.md](README.md#evidence-legend): **OFFICIAL**, **VENDOR-AUTHORED, THIRD-PARTY HOSTED**, **COMMUNITY / REVERSE-ENGINEERED**, **UNVERIFIED**, and **REPO**.

This document deliberately does **not** reproduce default PINs, default passwords or hidden service/hotel/developer menu key sequences. Where a source publishes one, the text says so; treat every published default as known to every customer and change it.

## 1. Summary and status

Five ways a LAN server could control a Samsung TV or display were researched. All are UNVERIFIED on hardware.

| Path | Official status | Absolute HDMI select | State readback | Fit for this project |
|---|---|---|---|---|
| Consumer Tizen WebSocket remote (8001/8002) | **COMMUNITY**-documented only | No (`KEY_HDMI` cycles) | `PowerState` over REST on some models | At most an UNVERIFIED keys-only profile; cannot support START verification or the expiry screen |
| SmartThings cloud API | **OFFICIAL** | Yes (`setInputSource`, cloud-acknowledged) | Cloud-reported | Breaks LAN-first; out of scope without approval |
| MDC on TCP 1515 (commercial/signage) | **VENDOR-AUTHORED, THIRD-PARTY HOSTED** spec v15.0 | Yes | **Device-reported** power, volume, mute, input, panel, locks | The only Samsung path that can honestly report input state |
| Tizen web app on the TV | **OFFICIAL** APIs; lock/power APIs are Partner-only | n/a (embeds HDMI via `tvwindow`) | Own app only (Partner APIs on LFD/HTV) | Companion-app case; decision gate applies |
| Consumer RS-232 "ExLink" | **OFFICIAL** worksheet (Samsung US Business) | Yes | Acknowledgement only | Wired, needs serial-to-IP hardware and service-menu changes |

Recommendation: if the café needs input switching and an expiry screen that the display itself reports, buy MDC-capable Samsung commercial displays and build a `SamsungMdcAdapter` profile under the existing `samsung-tizen` kind, disabled by default until physically tested. Treat consumer Tizen TVs as UNVERIFIED keys-only. Do not use SmartThings as the main control path. None of these makes the display tamper-proof: for example, PS5 HDMI-CEC can pull the TV back to HDMI after expiry (section 9).

## 2. Consumer Tizen WebSocket remote (ports 8001/8002)

### 2.1 Protocol (COMMUNITY / REVERSE-ENGINEERED)

From [samsungtvws](https://github.com/xchwarze/samsung-tv-ws-api) ([`connection.py`](https://github.com/xchwarze/samsung-tv-ws-api/blob/master/samsungtvws/connection.py), [`remote.py`](https://github.com/xchwarze/samsung-tv-ws-api/blob/master/samsungtvws/remote.py), [`rest.py`](https://github.com/xchwarze/samsung-tv-ws-api/blob/master/samsungtvws/rest.py), [`helper.py`](https://github.com/xchwarze/samsung-tv-ws-api/blob/master/samsungtvws/helper.py)) and [Home Assistant](https://www.home-assistant.io/integrations/samsungtv/) ([`const.py`](https://github.com/home-assistant/core/blob/dev/homeassistant/components/samsungtv/const.py), [`bridge.py`](https://github.com/home-assistant/core/blob/dev/homeassistant/components/samsungtv/bridge.py)):

- **Endpoints:** `ws://TV:8001/api/v2/channels/samsung.remote.control?name=<base64 name>`, and `wss://TV:8002/...` with `&token=<token>`. samsungtvws only adds the token on 8002.
- **Key message:** `{"method":"ms.remote.control","params":{"Cmd":"Click|Press|Release","DataOfCmd":"KEY_x","Option":"false","TypeOfRemote":"SendRemoteKey"}}`.
- **Apps:** listed and launched with `ms.channel.emit` events `ed.installedApp.get` and `ed.apps.launch` (DEEP_LINK / NATIVE_LAUNCH).
- **REST:** `GET http://TV:8001/api/v2/` returns device info; `/api/v2/applications/{id}` accepts GET/POST/DELETE for app status, run and close.

### 2.2 Pairing and settings

- The first connection to 8002 shows an allow/deny prompt on the TV. After approval the `ms.channel.connect` reply carries an 8-digit `data.token`.
- Without a token, commands return `ms.channel.unauthorized`; users on 2018 Q-series, NU7120 and RU7400 sets reported this in 2019 ([samsungctl #114](https://github.com/Ape/samsungctl/issues/114), COMMUNITY).
- The 8002 TLS certificate is not verified by the libraries (`CERT_NONE` / `verify=False`); an openHAB user reported an expired certificate ([openHAB thread](https://community.openhab.org/t/samsung-tv-binding-beta/130551?page=14)).
- By default the TV asks permission on every connection. Home Assistant's fix is Device Connection Manager > Access Notification > "First time only". One user found tokens stopped working after a power cycle until that setting was changed (COMMUNITY).
- The TV refuses WebSocket connections from a different subnet or VLAN (HA docs and samsungtvws README). This interacts with the staff-VLAN requirement: the server must sit on the TV subnet.
- Because the allow/deny prompt appears on the TV, a customer in front of it could approve a rogue client. Network isolation is required (README decisions).

### 2.3 Model-year differences (COMMUNITY, Home Assistant code and samsungtvws)

| Model years | Protocol |
|---|---|
| Before 2014 | Legacy protocol on port 55000 |
| 2014 H series and part of 2015 J series | Encrypted protocol on port 8000 with PIN pairing |
| 2016 onward | WebSocket on 8001/8002; Home Assistant tries 8002 first, then 8001 |

- Key codes vary by model: some 2016+ TVs need `KEY_POWEROFF` instead of `KEY_POWER`, and Frame TVs need `KEY_POWER` held for 3 s.
- That 2018+ models require the 8002 token is community-reported only (UNVERIFIED).

### 2.4 Official status

- Samsung's Smart View SDK debugging page documents `http://TV_IP:8001/api/v2/` only as an information page, and requires the TV to be in developer mode ([Samsung developer](https://developer.samsung.com/tv/develop/extension-libraries/smart-view-sdk/receiver-apps/debugging), OFFICIAL).
- No Samsung page documents `samsung.remote.control`. [rainu/samsung-remote](https://github.com/rainu/samsung-remote) says the API "does not seem to be documented anywhere", and the samsungtvws [key list](https://github.com/xchwarze/samsung-tv-ws-api/blob/master/COMMANDS.md) says it is "not an official Samsung list".
- A Samsung Developer Relations forum reply suggests the Smart View SDK is not supported on newer devices ([forum](https://forum.developer.samsung.com/t/which-current-samsung-tv-models-support-smartview-sdk/27690); search snippet only, UNVERIFIED).
- Using this path needs an explicit user decision under AGENTS.md's "documented" rule, plus a per-model physical test record.

### 2.5 No deterministic HDMI1-4 selection: `inputSwitching = false`

- The samsungtvws key list contains `KEY_SOURCE`, `KEY_HDMI` and `KEY_TV`, but not `KEY_HDMI1..4`.
- Community reports agree: "KEY_HDMI1, KEY_HDMI2 ... don't seem to do anything" and "KEY_HDMI ... steps around the available HDMI ports" ([MythTV list, 2021](https://lists.mythtv.org/pipermail/mythtv-users/2021-May/407065.html)); a PS5 owner reports only `KEY_HDMI` works and it cycles ([openHAB](https://community.openhab.org/t/samsung-tv-hdmi-loop/147845)); a Homey post says `KEY_HDMI1/2` work on some models ([Homey](https://community.homey.app/t/app-pro-samsung-smarttv-control-your-samsung-smarttv/10019?page=9), UNVERIFIED).
- Home Assistant's media player only offers sources "TV" and "HDMI" ([`media_player.py`](https://github.com/home-assistant/core/blob/dev/homeassistant/components/samsungtv/media_player.py)). `KEY_SOURCE` only opens the source menu.
- `KEY_HDMI` cycling is blind and not idempotent: the result depends on the current input, which this path cannot read.

Proposed rule: `switchInput()` and `enterGamingMode()` return `UNSUPPORTED` on the WebSocket profile. A model may be promoted to `UNVERIFIED` only after a physical test record shows `KEY_HDMIn` selects the right port on that exact model and firmware. Never `SUCCESS` with `verified: true`.

### 2.6 Readback is only `PowerState`, on some models

- Home Assistant reads `device["PowerState"]` from `GET /api/v2/` when present. Its code comments "On some TVs, opening a websocket turns on the TV", so a **power probe must use REST, not a WebSocket connect**, or it may wake an idle or expired TV.
- Values seen are `"on"` and `"standby"` ([LoxForum](https://www.loxforum.com/forum/german/software-konfiguration-programm-und-visualisierung/383720-anleitung-l%C3%B6sung-powerzustand-eines-samsung-fernsehers-abfragen-nicht-per-ping), Samsung forum snippets; UNVERIFIED per model year).
- A Homey user reports the endpoint stops answering some minutes after power-off ([Homey](https://community.homey.app/t/app-pro-samsung-smarttv-control-your-samsung-smarttv/10019?page=23), UNVERIFIED). Unreachable is therefore ambiguous between `DEVICE_OFFLINE` and deep standby.
- No source documents reading the current input or volume over this API ([Tizen forum question](https://developer.tizen.org/forums/general-support/connect-samsung-tv-using-rest-api), [samsungctl #114](https://github.com/Ape/samsungctl/issues/114)). One user notes the socket "only enables you to emulate the buttons that already exist on the IR remote".
- Home Assistant sets absolute volume through UPnP/DLNA RenderingControl, not the WebSocket. That is a separate, unverified path.

Capabilities for this profile: `stateVerification: false`; power off only as `UNVERIFIED`, power on needs Wake-on-LAN; `setVolume(n)` `UNSUPPORTED` unless UPnP is separately verified; mute toggle only. `DeviceState` (REPO, non-nullable fields) would force the adapter to invent volume and input, which is why nullable fields with provenance are a prerequisite ([README.md](README.md#pre-adapter-readiness-checklist)).

### 2.7 Toggle keys must never be retried

`KEY_POWER`, `KEY_MUTE` and `KEY_HDMI` change state relative to the current state. AGENTS.md allows retries only for idempotent operations, so a timed-out `KEY_POWER` must **never** be retried: a retry can turn a TV that just switched off back on. `powerOff()` should first read `PowerState = "on"` over REST. `powerOn()` needs Wake-on-LAN (MAC address, same L2 segment, "Wake on LAN must be enabled on the TV" per HA). Samsung's support page says "Power On with Mobile" must be on (path differs between 2017-2021 and 2022-2026 models) or the TV cannot be powered on through SmartThings ([Samsung AU support](https://www.samsung.com/au/support/tv-audio-video/power-on-tv-smartthings-app/), OFFICIAL).

### 2.8 RemoteKey mapping (community key names; test each per model)

| `RemoteKey` | WebSocket key | MDC `0xB0` virtual remote (spec v15) |
|---|---|---|
| POWER | `KEY_POWER` (toggle; Frame TVs need a 3 s hold) | `0x02` KEY_POWER, or `0x98` DISCRET_POWER_OFF |
| HOME | `KEY_HOME` | no code -> `UNSUPPORTED` |
| BACK | `KEY_RETURN` | `0x58` |
| UP / DOWN / LEFT / RIGHT | `KEY_UP` / `KEY_DOWN` / `KEY_LEFT` / `KEY_RIGHT` | `0x60` / `0x61` / `0x65` / `0x62` |
| OK | `KEY_ENTER` | `0x68` |
| VOLUME_UP / VOLUME_DOWN | `KEY_VOLUP` / `KEY_VOLDOWN` | `0x07` / `0x0B` |
| MUTE | `KEY_MUTE` (toggle) | `0x0F` |
| INPUT | `KEY_SOURCE` (opens the menu; selects nothing) | `0x01` KEY_SOURCE |
| PLAY / PAUSE | `KEY_PLAY` / `KEY_PAUSE` | `0x47` / `0x4A` |
| MENU | `KEY_MENU` | `0x1A` |
| SETTINGS | no distinct key -> `UNSUPPORTED` until tested | no code -> `UNSUPPORTED` |

Every WebSocket key result is `UNVERIFIED` with `verified: false`; the socket only acknowledges receipt. MDC `0xB0` is set-only ("Get: Not Support"), so it is acknowledged but cannot be read back. On MDC, prefer the absolute commands (`0x11`, `0x12`, `0x13`, `0x14`) over keys wherever possible.

## 3. SmartThings cloud API

**OFFICIAL** and stateful, but out of scope without explicit user approval.

- **Commands:** `POST /v1/devices/{id}/commands` returns `results[].status`. The OpenAPI schema defines `ACCEPTED` as "the command is processing but it's outcome is unknown", plus `COMPLETED` and `FAILED`. The docs say `ACCEPTED` "does not mean the command has completed"; confirmation arrives later as a device event ([control devices](https://developer.smartthings.com/docs/service-integrations/control-devices), [OpenAPI](https://swagger.api.smartthings.com/public/st-api.yml)).
- **Readback:** `GET /devices/{id}/status` and `GET /devices/{id}/health`.
- **Limits:** 12 commands per minute per device and 10 commands per request; exceeding them returns 429 or 422 ([rate limits](https://developer.smartthings.com/docs/getting-started/rate-limits)).
- **Tokens:** "A PAT is valid for 24 hours" for tokens created after 30 December 2024; Samsung recommends an OAuth Service Integration instead ([authorization](https://developer.smartthings.com/docs/getting-started/authorization-and-permissions)). Registering one is a service registration requiring explicit user approval.
- **Standard capabilities:** [`switch`](https://developer.smartthings.com/capabilities/switch) on/off; [`audioVolume`](https://developer.smartthings.com/capabilities/audioVolume) 0-100; [`audioMute`](https://developer.smartthings.com/capabilities/audioMute); [`mediaInputSource`](https://developer.smartthings.com/capabilities/mediaInputSource) with values including HDMI1-HDMI6 and a `supportedInputSources` attribute; [`healthCheck`](https://developer.smartthings.com/capabilities/healthCheck) online/offline.
- **Samsung's own capabilities:** TVs commonly expose `samsungvd.mediaInputSource`, `samsungvd.remoteControl` and `custom.launchapp` (listed in [pysmartthings](https://github.com/pySmartThings/pysmartthings/blob/main/src/pysmartthings/capability.py)). Their public definitions returned **404 on 2026-10-25**. Capabilities outside the `smartthings` namespace are custom and "not supported by the Works with SmartThings (WWST) certification program" ([custom capabilities](https://developer.smartthings.com/docs/devices/capabilities/custom-capabilities)).
- Community users report `setInputSource("HDMI1")` rejected when the value is missing from `supportedInputSources` ([1](https://community.smartthings.com/t/setinputsource-syntax-for-samsungtv/219538), [2](https://community.smartthings.com/t/samsung-g8-no-displayport-option-in-mediainputsource/271357); UNVERIFIED).

Proposed mapping, if ever approved: `ACCEPTED` -> `UNVERIFIED`; a later matching status attribute -> `SUCCESS`, `verified: true`, labelled "cloud-reported"; `healthStatus` offline -> `DEVICE_OFFLINE`. power, volume, mute and inputSwitching may be true but only as cloud-acknowledged; remoteKeys and applicationLaunch rely on undocumented capabilities, so false.

**Why not primary:** every START and expiry would depend on the café's internet link and Samsung's cloud, which breaks the LAN-first, server-authoritative design in [ARCHITECTURE.md](../ARCHITECTURE.md), and needs a Samsung account and a credential store.

## 4. MDC (Multiple Display Control) on TCP 1515

Source: "SEC-VD-DSW Multiple Display Control Ver. 15.0 2020-11-06" by Samsung Electronics Video Display. The copy read is hosted by a third party ([vgavro.github.io](https://vgavro.github.io/samsung-mdc/MDC-Protocol.pdf)), so it is **VENDOR-AUTHORED, THIRD-PARTY HOSTED** and may be out of date for 2023+ models.

### 4.1 Connection and framing

- Port **1515** (stated in the spec). The TCP payload has the same format as RS-232. The port is also confirmed by third-party drivers ([RTI](https://driverstore.rticontrol.com/driver/david-bowdler-samsung-mdc-multi-display), [PepperDash](https://github.com/PepperDash/epi-samsung-mdc-display), [python-samsung-mdc](https://github.com/vgavro/samsung-mdc), which implements 84 commands).
- **Frame:** `0xAA`, command, display ID, data length, data, checksum. The checksum is the sum of all bytes except the header, low byte only.
- **ACK:** `0xAA 0xFF len 'A' r-CMD values`. **NAK:** `'N' r-CMD ERR`.
- Samsung's "Smart Signage User Manual (Common Use)" for QBN/QMN/QEN/OMN and other series documents the same framing, the `0x11`/`0x12`/`0x14`/`0x5D` codes, and MDC over RJ45 or RS-232C daisy-chain, but does not state the port ([manual via Ingram Micro](https://inquirecontent2.ingrammicro.com/User-Manual/1059378728.pdf), VENDOR-AUTHORED, THIRD-PARTY HOSTED).

### 4.2 Relevant commands (spec v15)

| Code | Name | Get / Set | Notes |
|---|---|---|---|
| `0x00` | Status | get | Power, volume, mute, input and aspect in one reply |
| `0x11` | Power | get/set | Absolute (0 off, 1 on): idempotent |
| `0x12` | Volume | get/set | 0-100, absolute |
| `0x13` | Mute | get/set | Absolute |
| `0x14` | Input source | get/set | HDMI1 `0x21`, HDMI2 `0x23`, HDMI3 `0x31`, HDMI4 `0x33`, MagicInfo `0x20`, URL Launcher `0x63`, Web Browser `0x65`; `*_PC` variants are get-only |
| `0xF9` | Panel on/off | get/set | Described as "panel mute" |
| `0x36` | Remote control enable/disable | get/set | "Can operate regardless of whether power is ON/OFF" |
| `0x5D` | Safety Lock | get/set | |
| `0x5F` | Key Lock | get/set | |
| `0x77` | All Keys Lock | get/set | "remoconlock and button lock" |
| `0xB0` | Virtual remote | set only | See section 2.8 |
| `0x8A` | Model name | get | Use to select the tested profile |
| `0xC7`/`0x81` | Play Via | set | MagicInfo or URL Launcher |
| `0xC7`/`0x82` | URL address | set | ASCII, up to 200 characters |
| `0xB5` | Network Standby | get/set | Affects whether MDC works when off |
| `0xCA`/`0x81`-`0x82` | Auto Source Switching | get/set | Must be off (section 9) |

Caveats:

- "URL Launcher can be supported on DB/DM/DH/UE Model" and "Depends on each model spec it will be supported or not".
- `0xFE`/`0x51` screen mute is marked "Undocumented (as of Ver. 15)" in python-samsung-mdc. **Never use it.**
- MDC is for commercial/LFD/signage models; it is not available on consumer Tizen TVs. Support on BE-series Business TVs and HG hospitality models is UNVERIFIED; the [HCU7000 hotel TV page](https://www.samsung.com/ie/business/commercial-tvs/hotel-tv/hospitality-display-hcu7000-hg43cu700euxxu/) lists no control protocol.

### 4.3 Power retry rule (spec v15)

- Power on/off "must retry for 3 times every 2 Seconds until ACK ... If there is no ACK within 3 times, It means failure". This maps cleanly to a bounded retry ending in `TIMEOUT` or `FAILURE`.
- "When Monitor is Power Off status and connect by RJ45 Then you must transmit the WOL protocol instead of MDC protocol ... (In 'Network Standby : Off' ...)".
- After power-on by RJ45, "you must re-connect a socket connection after 10 sec".

MDC is the **only Samsung path with device-reported input state**.

## 5. Proposed `SamsungMdcAdapter` mapping and outcome rules

Model it as a profile under the existing `samsung-tizen` kind, not a new `AdapterKind`. Nothing below exists in code.

| `TvAdapter` method | MDC mechanism |
|---|---|
| `connect()` | TCP connect to 1515 with a bounded timeout; TLS if Secured Protocol is on |
| `getCapabilities()` | From `0x8A` model name plus that model's physical test record, never the brand alone |
| `getDeviceStatus()` | `0x00` Status plus `0xF9` panel; map input codes to `HDMI1`-`HDMI4`, `APP:url-launcher` and so on |
| `powerOn()` / `powerOff()` | `0x11` = 1 / 0; Wake-on-LAN when the display is off and Network Standby is off |
| `setVolume(n)` | `0x12` |
| `mute()` | Read `0x13`, then set explicitly (propose `setMuted(boolean)` in the contract) |
| `sendRemoteKey()` | `0xB0` (set only) |
| `switchInput("HDMIn")` | Set `0x14`, then GET `0x14` and compare |
| `launchApp()` | URL Launcher, where the model supports it |
| `enterIdleMode()` | Set `0xC7`/`0x82` to the server-hosted advertising URL, set `0x14` = `0x63`, then read back |
| `enterGamingMode(input)` | `0x14` = HDMIn, then read back |
| `enterExpiredMode()` | Set the expired-page URL and `0x14` = `0x63`; optionally `0x36` = 0 (remote off) or `0x77` = 1 (all keys locked); then read back input and lock state |

Outcome rules:

| Device response | `CommandOutcome` | Message rule |
|---|---|---|
| ACK and a matching GET | `SUCCESS`, `verified: true` | Must say "device-reported, not screen-verified" |
| ACK but GET mismatches | `UNVERIFIED`, or `FAILURE` after one bounded re-assert | |
| NAK | `FAILURE` | NAK ERR codes were not enumerated in the material read, so `UNSUPPORTED` cannot yet be distinguished (UNVERIFIED) |
| No reply within the timeout | `TIMEOUT` | |
| Connection refused or no route | `DEVICE_OFFLINE` | |

Design choice for the user: keep the remote/key locks on during gameplay (staff control volume) or toggle them per mode.

## 6. MDC security

- Plain MDC is an unauthenticated binary protocol. Anyone on the same network, including a customer on café Wi-Fi, could change inputs, turn off the IR lock or power displays down.
- The signage manual documents these settings ([manual](https://inquirecontent2.ingrammicro.com/User-Manual/1059378728.pdf)): **Remote Management** ("Allow or Deny external commands to access your product via a network"), **Secured Protocol** ("Secure the protocol between this device and other devices"), **Network Lock** ("Block external network access. You can register networks on the server to allow access"), and a PIN-protected **Safety Lock**.
- **The manual publishes the default Safety Lock PIN.** This document does not repeat it. Change it on every display and store the new PIN encrypted, as [ARCHITECTURE.md](../ARCHITECTURE.md#persistence) requires for credentials.
- The Secured Protocol TLS/PIN handshake is known only from python-samsung-mdc's [`connection.py`](https://github.com/vgavro/samsung-mdc/blob/master/samsung_mdc/connection.py); it is not in spec v15 (UNVERIFIED).

Deployment requirements (network changes need user approval):

1. Displays and the server on a dedicated, firewalled VLAN with an ACL that lets only the server reach 1515.
2. Remote Management restricted to the server; Network Lock where available.
3. Secured Protocol enabled where the model supports it.
4. Default PINs changed and stored encrypted.
5. The same isolation applies to the consumer WebSocket token and all TV control ports.

## 7. Tizen web apps on the TV

Public APIs (OFFICIAL):

- **TVWindow** (`tizen.tvwindow`, public privilege `tv.window`, since 2.3) "provides a way to embed a video source" such as HDMI in a web app ([TVWindow API](https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/tvwindow-api.html)). The PiP guide says "All Samsung TVs since 2015 support PiP" ([PiP guide](https://developer.samsung.com/smarttv/develop/guides/pip-picture-in-picture/managing-pip-windows.html)). In theory an advertising/expired app could own the screen and show the HDMI picture inside itself; gameplay latency, HDCP, full-screen game mode and backgrounding behaviour are all **UNVERIFIED**.
- **TVInputDevice** lets an app register extra keys, but apps "cannot register the mandatory keys (ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Enter, Back)" ([TVInputDevice](https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/tvinputdevice-api.html), [remote control guide](https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html)). Nothing says HOME or SOURCE can be captured, so the customer can always leave the app.

Installing on consumer TVs:

- Developer mode is enabled through a key sequence and host-IP setting documented on Samsung's developer site ([TV device setup](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html)), followed by a reboot. The app needs a certificate profile whose distributor certificate contains the target TV's **DUID** ([certificates](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html)). This is a per-device testing workflow, not a deployment channel; the alternative is publishing to Samsung's store.

B2B APIs (Partner privilege, LFD/HTV only):

- **SystemControl** (`setIRLock`, `setButtonLock`, `setPanelMute`, `setSafetyLock`, `captureScreen`, `rebootDevice`) requires Partner privilege `http://developer.samsung.com/privilege/systemcontrol`, is "Since 6.5", and is B2B LFD/HTV only ([SystemControl](https://developer.samsung.com/signage/develop/api-references/samsung-product-api-references/systemcontrol-api.html), [product APIs](https://developer.samsung.com/signage/develop/api-references/samsung-product-api-references.html)).
- **RemotePower** (`getPowerState` NORMAL/STANDBY, `powerOn`, `powerOff`) has the same Partner requirement on HTV/LFD from 6.5 ([RemotePower](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/remotepower-api.html?device=htv)).
- Tizen 6.5 corresponds to 2022 models ([web engine specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html)).
- A Samsung partnership is needed ([forum inquiry](https://forum.developer.samsung.com/t/inquiry-regarding-b2b-api-support-for-samsung-signage-devices/34638)); out of scope without user approval. `captureScreen` must not be used for continuous capture (AGENTS.md).

Hotel models: the [HCU7000 page](https://www.samsung.com/ie/business/commercial-tvs/hotel-tv/hospitality-display-hcu7000-hg43cu700euxxu/) lists Hospitality Plug&Play, Security Mode, Power On Mode and LYNK Cloud (cloud, "purchased separately"); it names no LAN control protocol.

Fit: an on-TV app is the companion-app case in [HARDWARE_LIMITATIONS.md](../HARDWARE_LIMITATIONS.md#companion-app-decision-gate) and must pass that gate first.

## 8. Consumer RS-232 "ExLink"

Source: Samsung US Business "Consumer RS232 Control Worksheet", PDF dated 2023-06-27 ([PDF](https://image-us.samsung.com/SamsungUS/samsungbusiness/tv-ci-resources/Samsung-RS232-Control.pdf), OFFICIAL).

- "Most Samsung Consumer TVs can be controlled via RS232", through the native 3.5 mm ExLink port ("currently Q70 and above") or "a Samsung proprietary dongle" on USB (8000 or Q60 class).
- The dongle route requires **service-menu changes**. This document does not reproduce the service-menu key sequence. Service-menu changes may affect warranty or support; they count as device configuration, need explicit user approval, and must be recorded, even though they are not firmware modification.
- **Format:** `08 22` + 4 command bytes + checksum, where checksum = 256 - (sum of the other bytes). Power off is `08 22 00 00 00 01 D5`. Input HDMI1..4 is `08 22 0A 00 05 00..03` plus checksum.
- **Feedback:** the only documented reply is a "success" `03 0C F1`. There is no get or status command, so results are acknowledged but never device-reported.
- The worksheet says these commands "are different than those used in the Commercial models".
- LAN use needs a serial-to-IP converter per TV (extra hardware, purchase approval).

This is the only Samsung-documented way found to select a specific HDMI port deterministically on consumer models. Outcome rule: an acknowledged command is `UNVERIFIED`, never `SUCCESS` with `verified: true`.

## 9. HDMI-CEC (Anynet+) bypass

- Samsung: when a connected HDMI device powers on, "By default, the TV will immediately switch to this source"; for some TVs the on/off option for this arrived in a firmware update ([Samsung US](https://www.samsung.com/us/support/troubleshoot/TSG10002314), [Samsung SG Anynet+](https://www.samsung.com/sg/support/tv-audio-video/use-anynetplus-hdmi-cec-on-your-samsung-smart-tv/), OFFICIAL). Samsung's support page publishes a remote key sequence for this option on some models; follow it from the source.
- PS5 side: third-party guides describe Settings > System > HDMI > Enable HDMI Device Link / One-Touch Play ([Tom's Guide](https://tomsguide.com/how-to/this-hidden-ps5-feature-could-change-how-you-use-your-console-heres-how-to-access-it), COMMUNITY). No official PlayStation page was found (UNVERIFIED).
- So after expiry, a customer who wakes the PS5 with the controller may switch the TV back to HDMI with no remote involved.
- **UNVERIFIED:** whether MDC IR lock (`0x36`) or All Keys Lock (`0x77`) blocks CEC-initiated switching.
- Signage models also have Auto Source Switching (MDC `0xCA`, manual System > Auto Source Switching); it must be off.

Implications:

1. Add the physical test row "CEC wake after expiry" ([README.md](README.md#proposed-new-rows-for-hardware_limitationsmd-not-applied)).
2. Expiry needs low-frequency re-verification of the MDC input with backoff, re-asserting it and alerting staff on drift. The single `verified` flag at LOCK time is not enough.
3. Disabling CEC on the TV and Device Link on the PS5 is a manual setup step, not software PS5 control.

## 10. Reference timeout and retry values (feeds the Phase 3 TIMEOUT outcome)

| Source | Value | Evidence |
|---|---|---|
| Home Assistant `TIMEOUT_WEBSOCKET` | 5 s | COMMUNITY ([`const.py`](https://github.com/home-assistant/core/blob/dev/homeassistant/components/samsungtv/const.py)) |
| Home Assistant `TIMEOUT_REQUEST` | 31 s (sized for the on-TV authorisation prompt) | COMMUNITY |
| Home Assistant `KEY_PRESS_TIMEOUT` | 1.2 s | COMMUNITY |
| samsungtvws `key_press_delay` | 1 s default | COMMUNITY ([`connection.py`](https://github.com/xchwarze/samsung-tv-ws-api/blob/master/samsungtvws/connection.py)) |
| python-samsung-mdc read/write/connect | 5 s default | COMMUNITY ([repo](https://github.com/vgavro/samsung-mdc)) |
| MDC spec power retry | 3 attempts, 2 s apart, then failure | VENDOR-AUTHORED, THIRD-PARTY HOSTED |
| MDC spec reconnect after power-on | 10 s | VENDOR-AUTHORED, THIRD-PARTY HOSTED |

Suggested bounds (to be replaced by measured per-model values):

- Pairing: about 30 s, so the TV prompt can be answered.
- Normal commands: about 5 s, then `TIMEOUT`.
- Retries only for absolute, idempotent commands: MDC set-power, set-input, set-volume; SmartThings `switch` and `setInputSource`.
- **Never** retry toggle keys (`KEY_POWER`, `KEY_MUTE`, `KEY_HDMI` cycling).
- Tests use an injected fake clock, as AGENTS.md requires.

## 11. Per-profile capability matrix

All values are proposals, **UNVERIFIED** until a physical test record exists for the exact model and firmware. "ack" means acknowledged only; "device" means device-reported via GET; "cloud" means cloud-reported.

| `DeviceCapabilities` flag | Consumer WebSocket | SmartThings | MDC (commercial) | ExLink RS-232 | Tizen app, B2B Partner (LFD/HTV, 6.5+) |
|---|---|---|---|---|---|
| `power` | partial: off as UNVERIFIED, on via WoL | cloud | **true (device)** | ack | via RemotePower (Partner) |
| `volume` | false (relative keys only) | cloud | **true (device)** | UNVERIFIED | n/a |
| `mute` | toggle only | cloud | **true (device)** | UNVERIFIED | n/a |
| `remoteKeys` | true (ack) | false | true (set only) | false | n/a |
| `inputSwitching` | **false** | cloud | **true (device)** | ack | via `tvwindow` embedding only |
| `applicationLaunch` | UNVERIFIED (app launch events) | false | per model (URL Launcher) | false | the app itself |
| `advertisingPlayback` | false | false | per model (URL Launcher) | false | the app itself |
| `stateVerification` | false (PowerState only on some models) | cloud | **true (device)** | false | own app and power state |
| `secureDisplayBlocking` | **false** | **false** | **false** | **false** | **false** |

MDC IR/button locks make tampering harder but are **not** tamper-proof (mains power cycle, HDMI-CEC, LAN access), so the UI must never call them a secure lock. The single `stateVerification` boolean cannot express these differences; see the per-dimension readback and evidence-level proposals in [README.md](README.md#pre-adapter-readiness-checklist).

## 12. Hardware decision notes for the user

For a 10-station PS5 café that needs START to switch to the PS5's HDMI and expiry to show a server-hosted screen with evidence:

- **Consumer Tizen TVs:** undocumented keys-only WebSocket, no direct HDMI select, no input readback. Every alternative adds a dependency: the cloud (SmartThings), serial hardware without readback (ExLink), or developer-mode sideloading (Tizen app).
- **MDC-capable Samsung signage:** absolute input set and GET, URL Launcher (DB/DM/DH/UE per spec v15; newer series per model), panel on/off, and remote/button locks. The signage manual covers the QBN/QMN/QEN/OMN/QBR/QMR series.
- **Malaysia / South-East Asia caveat:** lock features vary by region. Samsung's BED-H Business TV datasheet marks panel-button lock, USB port lock, PlayLock and VXT as "S.E Asia: No" and lists a SolarCell Bluetooth remote for that region ([datasheet](https://image-us.samsung.com/SamsungUS/home/pdf/Samsung_Business_TV_BE98D-H_Datasheet.pdf); see [display-locking.md](display-locking.md#3-regional-caveat-malaysia-and-south-east-asia)). Whether BE-series Business TVs or HG hotel models accept MDC on 1515 is UNVERIFIED; B&H lists the BE55D-H without an RS-232 port ([B&H](https://www.bhphotovideo.com/c/product/1834906-REG/samsung_be55d_h_bed_h_series_crystal_uhd.html)).
- **Before buying,** confirm for the exact local SKU: MDC over RJ45, URL Launcher, IR/All-Keys lock, Secured Protocol, and HDMI 2.1 / 120 Hz game-mode needs for the PS5. Test one unit through the full matrix, including the CEC wake test, before buying the rest. No prices were verified.

Purchasing and network changes need explicit user approval.

## 13. Risks and sources

### 13.1 Risks

- Nothing here was tested on hardware; no claim may be used to enable an adapter.
- The MDC v15.0 spec copy is third-party hosted and may be outdated for 2023+ models; the Secured Protocol handshake is known only from python-samsung-mdc.
- Port 1515 is stated in the spec and third-party drivers; the signage manual read does not state it.
- The consumer WebSocket has no official documentation and firmware updates may break it (one HA user's 2020 QE75 "worked fine until new year").
- Samsung developer-forum threads could not be fetched (HTTP 404/blocked); claims from snippets are marked UNVERIFIED.
- Opening a WebSocket can turn some TVs on; a careless status probe could wake an idle or expired TV.
- `KEY_POWER`, `KEY_MUTE` and `KEY_HDMI` are toggles or cycles; a retried command can reverse the intended state.
- Plain MDC has no authentication; without VLAN/ACL isolation, Secured Protocol, Remote Management restrictions and a changed Safety Lock PIN, a customer on the café network could switch inputs or disable locks.
- PS5 HDMI-CEC can switch the TV back after expiry; whether MDC locks block it is unverified.
- SmartThings needs internet, a Samsung account and token handling; registering an integration needs user approval.
- `samsungvd.*` capability definitions are not public (404 on 2026-10-25) and may change without notice.
- Developer-mode sideloading is tied to each TV's DUID; B2B lock/power APIs need Partner privilege and exist only on LFD/HTV from 2022.
- The ExLink dongle route needs service-menu changes that may affect warranty.
- The latent `execute()` defect (state changed before adapter and status calls, persisted only after them; an expired station stuck at `PENDING` if the adapter throws) must be fixed before any Samsung adapter. See [README.md](README.md#pre-adapter-readiness-checklist).

### 13.2 Sources (accessed 2026-10-25)

OFFICIAL (Samsung and SmartThings):

- Smart View SDK debugging: https://developer.samsung.com/tv/develop/extension-libraries/smart-view-sdk/receiver-apps/debugging
- TVWindow API: https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/tvwindow-api.html
- PiP guide: https://developer.samsung.com/smarttv/develop/guides/pip-picture-in-picture/managing-pip-windows.html
- TVInputDevice API: https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/tvinputdevice-api.html
- Remote control guide: https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html
- TV device setup: https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html
- Certificates: https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html
- Signage product APIs and SystemControl: https://developer.samsung.com/signage/develop/api-references/samsung-product-api-references.html, https://developer.samsung.com/signage/develop/api-references/samsung-product-api-references/systemcontrol-api.html
- RemotePower (HTV): https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/remotepower-api.html?device=htv
- Web engine specifications: https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html
- HCU7000 hotel TV: https://www.samsung.com/ie/business/commercial-tvs/hotel-tv/hospitality-display-hcu7000-hg43cu700euxxu/
- Consumer RS-232 worksheet: https://image-us.samsung.com/SamsungUS/samsungbusiness/tv-ci-resources/Samsung-RS232-Control.pdf
- BED-H datasheet: https://image-us.samsung.com/SamsungUS/home/pdf/Samsung_Business_TV_BE98D-H_Datasheet.pdf
- Power on with SmartThings: https://www.samsung.com/au/support/tv-audio-video/power-on-tv-smartthings-app/
- Anynet+ / auto source switching: https://www.samsung.com/us/support/troubleshoot/TSG10002314, https://www.samsung.com/sg/support/tv-audio-video/use-anynetplus-hdmi-cec-on-your-samsung-smart-tv/
- SmartThings: https://developer.smartthings.com/docs/service-integrations/control-devices, https://swagger.api.smartthings.com/public/st-api.yml, https://developer.smartthings.com/docs/getting-started/rate-limits, https://developer.smartthings.com/docs/getting-started/authorization-and-permissions, https://developer.smartthings.com/capabilities/mediaInputSource, https://developer.smartthings.com/capabilities/switch, https://developer.smartthings.com/capabilities/audioVolume, https://developer.smartthings.com/capabilities/audioMute, https://developer.smartthings.com/capabilities/healthCheck, https://developer.smartthings.com/docs/devices/capabilities/custom-capabilities

VENDOR-AUTHORED, THIRD-PARTY HOSTED:

- MDC protocol v15.0: https://vgavro.github.io/samsung-mdc/MDC-Protocol.pdf
- Smart Signage User Manual (Common Use): https://inquirecontent2.ingrammicro.com/User-Manual/1059378728.pdf

COMMUNITY / REVERSE-ENGINEERED:

- samsungtvws: https://github.com/xchwarze/samsung-tv-ws-api (and `connection.py`, `remote.py`, `rest.py`, `helper.py`, `COMMANDS.md` under it)
- Home Assistant Samsung TV: https://www.home-assistant.io/integrations/samsungtv/, https://github.com/home-assistant/core/blob/dev/homeassistant/components/samsungtv/const.py, https://github.com/home-assistant/core/blob/dev/homeassistant/components/samsungtv/bridge.py, https://github.com/home-assistant/core/blob/dev/homeassistant/components/samsungtv/media_player.py
- python-samsung-mdc: https://github.com/vgavro/samsung-mdc, https://github.com/vgavro/samsung-mdc/blob/master/samsung_mdc/commands.py, https://github.com/vgavro/samsung-mdc/blob/master/samsung_mdc/connection.py
- RTI driver: https://driverstore.rticontrol.com/driver/david-bowdler-samsung-mdc-multi-display
- PepperDash plugin: https://github.com/PepperDash/epi-samsung-mdc-display
- pysmartthings: https://github.com/pySmartThings/pysmartthings/blob/main/src/pysmartthings/capability.py
- samsungctl issue 114: https://github.com/Ape/samsungctl/issues/114
- rainu/samsung-remote: https://github.com/rainu/samsung-remote
- openHAB threads: https://community.openhab.org/t/samsung-tv-binding-beta/130551?page=14, https://community.openhab.org/t/samsung-tv-hdmi-loop/147845
- MythTV list: https://lists.mythtv.org/pipermail/mythtv-users/2021-May/407065.html
- Homey threads: https://community.homey.app/t/app-pro-samsung-smarttv-control-your-samsung-smarttv/10019?page=9, https://community.homey.app/t/app-pro-samsung-smarttv-control-your-samsung-smarttv/10019?page=23
- LoxForum: https://www.loxforum.com/forum/german/software-konfiguration-programm-und-visualisierung/383720-anleitung-l%C3%B6sung-powerzustand-eines-samsung-fernsehers-abfragen-nicht-per-ping
- Tizen forum: https://developer.tizen.org/forums/general-support/connect-samsung-tv-using-rest-api
- SmartThings community: https://community.smartthings.com/t/setinputsource-syntax-for-samsungtv/219538, https://community.smartthings.com/t/samsung-g8-no-displayport-option-in-mediainputsource/271357
- Tom's Guide (PS5 HDMI settings): https://tomsguide.com/how-to/this-hidden-ps5-feature-could-change-how-you-use-your-console-heres-how-to-access-it
- B&H BE55D-H listing: https://www.bhphotovideo.com/c/product/1834906-REG/samsung_be55d_h_bed_h_series_crystal_uhd.html

UNVERIFIED (snippet only or not retrievable):

- Samsung developer forum, Smart View SDK on current models: https://forum.developer.samsung.com/t/which-current-samsung-tv-models-support-smartview-sdk/27690
- Samsung developer forum, B2B API inquiry: https://forum.developer.samsung.com/t/inquiry-regarding-b2b-api-support-for-samsung-signage-devices/34638

## 14. Physical verification checklist

Nothing below has been tested. Record every row per exact model, region/SKU, Tizen version and firmware, in the format of [docs/HARDWARE_LIMITATIONS.md](../HARDWARE_LIMITATIONS.md#minimum-test-record-per-model), before any Samsung profile is enabled.

| Field | Required evidence |
|---|---|
| Identity | Manufacturer, exact model and local SKU, region, Tizen version, firmware; `0x8A` model name reply for MDC displays |
| Profile | Which path is under test (WebSocket, MDC, ExLink, Tizen app); recorded user decision if the path is community-documented or needs service-menu changes |
| Pairing | WebSocket allow/deny prompt and token behaviour, Access Notification setting, token survival across a power cycle; MDC Secured Protocol PIN flow; revocation path for each |
| Network | Port (8001/8002 or 1515) reachable from the staff subnet only; not reachable from customer Wi-Fi; Remote Management and Network Lock settings; reconnect after a DHCP change |
| Credentials | Default Safety Lock PIN and any installer/hotel password changed; new values stored encrypted; nothing default left in place |
| Power | MDC `0x11` set and GET from on, standby and Network Standby off (WoL); spec retry rule (3 x 2 s); 10 s reconnect after power-on; WebSocket `PowerState` values; whether a WebSocket connect wakes the TV |
| Volume / mute | MDC `0x12`/`0x13` set and GET; WebSocket keys acknowledged only |
| Each HDMI input | MDC `0x14` set to `0x21`/`0x23`/`0x31`/`0x33` and GET matches the correct physical port; ExLink HDMI1-4 acknowledgement; WebSocket `KEY_HDMI`/`KEY_HDMIn` behaviour recorded but not enabled without proof |
| App / URL launch | URL Launcher (`0xC7`/`0x82`, `0x14` = `0x63`) shows the server-hosted page; time to display; behaviour with the server unreachable |
| Modes | Idle advertising, gameplay transition to the PS5 input, expiry transition; measured p50/p99 latency for each |
| Locks | `0x36`, `0x5D`, `0x5F`, `0x77` set and GET; what the IR remote, the panel buttons and the Bluetooth remote (where the SKU ships one) can still do while locked |
| Verification | Which fields are device-reported versus acknowledged; NAK codes observed; that an ACK with a mismatched GET is never shown as `SUCCESS` |
| Bypass | Remote SOURCE, panel buttons, phone app pairing from the customer network, Auto Source Switching, and PS5 controller wake with Anynet+ on and off, with and without key locks, during an expired session |
| Recovery | Standby, reboot, mains power cycle (do the locks survive?), server restart, display offline at expiry then reconnect (expired mode and locks re-applied?) |
| Performance | PS5 4K120/VRR/ALLM and HDCP behaviour on the gaming input; URL Launcher memory/CPU during idle playback |
| Security | Exposed-service scan of the display; firewall/VLAN configuration recorded; Secured Protocol state |

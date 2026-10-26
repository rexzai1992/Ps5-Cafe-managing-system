# Making the Expired Screen Hard to Bypass

Research date: 2026-10-25 (Asia/Kuala_Lumpur). All URLs below were accessed on that date unless a different date is given.
Audience: the café owner choosing hardware, and engineers who will later build adapters and the staff display of blocking evidence.

> **Status: research only. Nothing in this document is implemented or physically verified in this repository.**
> No TV, HDMI switch, matrix, serial converter, smart plug or PS5 was tested. Every command, port and setting below comes from documentation and must pass the matrix in [`docs/HARDWARE_LIMITATIONS.md`](../HARDWARE_LIMITATIONS.md) before any adapter is enabled. **This is not a tamper-proof claim.** No option here makes a customer unable to reach the PS5 picture; the options only differ in how much effort a bypass takes and in what evidence staff can see. Purchases and network changes need explicit user approval.

Evidence labels follow [README.md](README.md#evidence-legend): **OFFICIAL**, **VENDOR-AUTHORED, THIRD-PARTY HOSTED**, **COMMUNITY / REVERSE-ENGINEERED**, **UNVERIFIED**, and **REPO**. No default PIN, installer password or hidden menu key sequence is reproduced here; where a manual publishes one, this document says so and requires it to be changed.

## 1. Summary

Ranked from most to least resistant to a customer bypass. Costs are relative estimates; **no price, Malaysian or otherwise, was verified.**

| Rank | Mechanism | Tamper resistance | Relative cost | LAN control | Readback |
|---|---|---|---|---|---|
| 1 | HDMI switch or matrix with a documented API that takes the PS5 out of the TV's signal path | High | Medium | Yes (Telnet, or RS-232 via an IP-to-serial converter) | Yes: routing and output state |
| 2 | Commercial/hospitality TV with documented key and remote locks plus input readback | Medium | Medium | Yes (MDC, RS-232C, REST) | Yes: input and lock state |
| 3 | Smart plug cutting **TV** power (fallback only) | Medium, only if the outlet is out of reach | Low | Yes | Relay state only, not the screen |
| 4 | Hiding or locking away the TV remote | Low | Very low | No | No |
| 5 | Software input switching / app foreground on consumer TVs | Very low | None | Model-dependent, unverified | Model-dependent, unverified |
| 6 | HDMI-CEC tricks | Not a lock: CEC is a **bypass** route | None | n/a | n/a |

Rejected outright: a smart plug cutting **PS5** power, and continuous capture (section 5).

`secureDisplayBlocking` stays `false` for every tier. The staff display should carry a separate assurance label and a verified-at time (section 6).

## 2. Tiers in detail

### Rank 1: HDMI switch or matrix with routing readback

**How it works.** Wire PS5 -> switch -> TV HDMI1. On expiry the server routes the TV output to an empty or advertising input, or turns the output off, then reads the routing back. The expired message on the TV is software messaging only; the enforcement is the switch.

**Example devices with published APIs:**

- **WyreStorm EXP-SW-0401-8K**, an HDMI 2.1 / HDCP 2.3 4x1 switch. The spec sheet lists 40 Gbps FRL, VRR, ALLM, 4096x2160@144, full CEC passthrough, a front-panel IR sensor, a push button, RS-232 and **no LAN port** ([spec sheet](https://www.ambertech.com.au/Documents/Manuals/Wyrestorm/WY-EXPSW04018K_SpecSheet.pdf), VENDOR-AUTHORED, THIRD-PARTY HOSTED via Ambertech). Its API ([API PDF](https://www.ambertech.com.au/Documents/Manuals/Wyrestorm/WY-EXPSW04018K_API.pdf)) uses RS-232 at 115200 8N1 with LF termination:
  - `SET SW in4 out` switches the input; `GET MP out` reads back the current mapping.
  - `SET AUTOSW_M on|off` controls auto-switching. **It must be off**, or the switch can jump back to an active source.
  - `SET CEC_PWR out on|off` controls display power over CEC.
  - For LAN control, add a Global Caché IP2SL or similar, which passes serial data through raw TCP port 4999 unchanged ([Global Caché unified TCP API](https://www.globalcache.com/files/docs/api-gc-unifiedtcp.pdf), OFFICIAL).
- **Atlona AT-HDR-H2H-44M**, a 4K HDR 4x4 matrix whose EDID table tops out at 4K60, controlled over Telnet port 23 ([API PDF](https://ts.atlona.com/pdf/AT-HDR-H2H-44M_API.pdf), OFFICIAL):
  - `x1AVx3` routes input 1 to output 3; `Status` reads back the routing.
  - `x?$ on|off|sta` turns an output's HDMI signal on or off, or reads its state.
  - `Lock` locks the front panel; `IROFF` disables the IR receiver.
  - Note the 4K60 ceiling: this model would not carry PS5 4K120.

**PS5 signal path.** Sony says the PS5 needs HDMI 2.1 for 4K 120 Hz and that equipment between the PS5 and the TV can affect the signal ([PS5 4K guide](https://www.playstation.com/en-us/support/hardware/ps5-4k-resolution-guide/), OFFICIAL). Each switch model must be tested physically with a PS5 (4K120, VRR, HDCP handshake, EDID, behaviour when switched away) before it is enabled.

**Per-station setup:**

- Put the switch in a locked enclosure with its front panel locked and IR off.
- Lock the TV as in Rank 2 so the remote and panel buttons cannot change the TV's own input.
- Use HDMI port blockers on unused TV ports ([example product](https://www.bechtle.com/es/shop/hdmi-port-lock-blue-10x--6004826--p)); these only deter casual tampering.
- A central matrix with one shared advertising-player input can serve many stations, but becomes a single point of failure; HDMI 2.1 cable-length limits are UNVERIFIED.

**What it does not stop:** someone re-plugging the PS5 straight into the TV; PS Remote Play, which Sony documents works anywhere with high-speed internet including mobile data, with the same account as the console ([Remote Play on mobile](https://www.playstation.com/en-us/support/games/playstation-remote-play-on-mobile-devices/), OFFICIAL); audio through a controller headset (UNVERIFIED). In every case the console keeps running.

This is the only candidate for the planned `FutureHDMIHardwareAdapter` ("Level 4", [ARCHITECTURE.md](../ARCHITECTURE.md#adapter-contract)) and would map to the existing `"hdmi-hardware"` `AdapterKind`. Proposed mapping to `TvAdapter` (nothing exists in code); the switch adapter would sit alongside the TV's own adapter, which still shows the expired message:

| `TvAdapter` method or flag | Switch mechanism | Rule |
|---|---|---|
| `connect()` | Telnet (Atlona) or TCP to the IP-to-serial converter (WyreStorm), bounded | Refused or no route -> `DEVICE_OFFLINE`; no reply -> `TIMEOUT` |
| `getDeviceStatus()` | `Status` / `GET MP out` / `x?$ sta` | Routing and output state only; never the TV's picture |
| `enterGamingMode(input)` | Route the PS5 input to the station's output, then read back | `SUCCESS`, `verified: true` only when the readback matches; message says "device-reported" |
| `enterExpiredMode()` | Route away from the PS5 or turn the output off, then read back | As above; the TV adapter's expired message is reported separately |
| `switchInput("HDMIn")` | Absolute route command | Idempotent, so a bounded retry is allowed |
| `inputSwitching`, `stateVerification` | true after a physical test record | Routing readback only |
| `secureDisplayBlocking` | **false** | Re-plugging cables and Remote Play still work |

### Rank 2: Commercial/hospitality TV key and remote locks with readback

**How it works.** The TV's own firmware disables the IR remote and/or panel buttons, and the server reads back both the input and the lock state.

**Samsung Smart Signage** ([common user manual via Ingram Micro](https://inquirecontent2.ingrammicro.com/User-Manual/1059378728.pdf), VENDOR-AUTHORED, THIRD-PARTY HOSTED):

- Safety Lock On restricts what the remote can do and needs a PIN to turn off. **The manual publishes the default PIN; change it.**
- Button Lock leaves only the remote able to control the display. Auto Source Switching must be off. Anynet+ (HDMI-CEC) is a separate setting and should be off.
- MDC codes include input source `0x14` (get/set) and Safety Lock `0x5D` (get/set); the manual says Safety Lock works "regardless of whether or not the power is turned on".
- Samsung VXT/MagicINFO docs add Remote Control Lock, Button Lock and All Keys Lock ([VXT docs](https://docs.samsungvx.com/docs/x/WBWUAw), OFFICIAL).
- Port 1515 and the full command set are in the Samsung-authored MDC spec v15 (third-party hosted) and python-samsung-mdc ([repo](https://github.com/vgavro/samsung-mdc)); see [samsung-tizen.md section 4](samsung-tizen.md#4-mdc-multiple-display-control-on-tcp-1515).

**Samsung hospitality TVs** ([HG43Q60B install guide via Ingram Micro](https://inquirecontent2.ingrammicro.com/User-Manual/1077613251.pdf), VENDOR-AUTHORED, THIRD-PARTY HOSTED):

- A Hotel Option menu is reached by a remote-control sequence printed in the guide (not reproduced here). Factory Lock (password) must be turned on, and the published reset/default values must be changed.
- Panel Button Lock has Lock and OnlyPower settings; Menu OSD and Power On Source are also available.
- Security Mode can disable HDMI entirely, which is not useful here.
- The guide shows no SOURCE-key lock, so whether one exists is UNVERIFIED.

**LG hotel TV** ([UV340C install manual](https://www.lg.com/us/business/download/resources/BT00001837/UV340C-U_Install_Manual_170825.pdf), OFFICIAL):

- The Installer menu is reached by a published remote procedure and a password whose initial value is printed in the manual (not reproduced here); change it.
- Key Management offers IR Operation and Local Key Operation, each with Normal / Use PWR Only / Block All. Limited Mode and Power On Default Input are also available.
- RS-232C `km` (Remote Control Lock Mode) locks both the front panel and the remote, but see section 4: a mains power cycle releases it.
- Sending `FF` as data returns status (readback). `xb` selects the input.

**Sony BRAVIA Professional Displays** (Pro mode, OFFICIAL):

- Display buttons and remote operations can be disabled individually; each external input can be set to "not used"; Pro mode lock needs a 4-digit PIN to leave Pro mode ([function restrictions](https://pro-bravia.sony.net/guides/references/prosettings/android_latest/4_function_restrictions/4-1_tv_remote_controls/)).
- The REST API `getPlayingContentInfo` (private auth) returns the current input, for example `extInput:hdmi?port=2`; `setPlayContent` selects an input ([REST API reference](https://pro-bravia.sony.net/remote-display-control/rest-api/reference/)).

**What it does not stop:** the PS5 cable is still connected to the TV, so anyone who clears the lock (power cycle on LG, a known default PIN, a CEC path that the lock does not cover, a remote the lock does not cover) gets the PS5 picture back; Remote Play and controller audio continue.

### Rank 3 (fallback only): Smart plug cutting TV power

- Shelly Gen2 devices accept local HTTP calls such as `/rpc/Switch.Set?id=0&on=false`, with optional digest authentication ([Shelly Gen2 RPC](https://shelly-api-docs.shelly.cloud/gen2/General/RPCChannels/), OFFICIAL). That gives LAN control and a readback of the **relay** state, not the screen state.
- Downsides: no expired message or advertising can be shown; the TV adapter loses LAN control while the TV is off; on LG a mains cycle releases the `km` lock and the Power On Status setting decides what happens when power returns. No manufacturer guidance was found on how repeated hard power cuts affect TV lifespan (UNVERIFIED).
- Staff should see: "TV power cut: relay off reported; screen not verified".
- **Never on the PS5** (section 5).

### Rank 4: Hiding or locking away the remote

A deterrent, not a lock. Remaining routes:

- The TV's own panel buttons (Samsung documents Button Lock separately because the panel buttons control the TV).
- Phones with IR blasters: Xiaomi's Mi Remote app lists Samsung, LG and Sony among supported brands ([Mi support](https://www.mi.com/global/support/article/KA-36411/); search snippet only, the page refused a direct fetch, UNVERIFIED).
- Phone remote apps: the Google TV app finds "TVs nearby" and pairs with a code shown on the TV ([Google TV help](https://support.google.com/googletv/answer/11136134), OFFICIAL). That these apps need the same network is the researcher's inference; Google's page states it only for casting (UNVERIFIED).

Useful only as basic setup on top of Rank 1 or 2: TV control interfaces on a staff-only VLAN, screen mirroring off.

### Rank 5: Software input switching on consumer TVs

Any ADB, Tizen, IR or CEC command that changes the input or opens an app only changes state the customer can change straight back. Samsung's own manual says to "Press the SOURCE button on the remote control to change the source" ([manual](https://inquirecontent2.ingrammicro.com/User-Manual/1059378728.pdf)). Android's HDMI-CEC docs say a waking device "attempts to wake the connected TV and become the current active source" ([AOSP HDMI-CEC](https://source.android.com/docs/devices/tv/hdmi-cec), OFFICIAL), so pressing the PS button can bring the PS5 picture back. LAN control and readback depend on the model; see [android-tv.md](android-tv.md) and [samsung-tizen.md](samsung-tizen.md). A command result alone must never show as `CONFIRMED`.

### Rank 6: HDMI-CEC is a bypass, not a lock

- Android's docs say CEC devices "don't always understand each other" and "consumers can't safely assume that two products that claim CEC support are completely compatible" ([AOSP HDMI-CEC](https://source.android.com/docs/devices/tv/hdmi-cec)). Turning the TV off over CEC (for example WyreStorm `SET CEC_PWR out off`) is undone by the remote's power button.
- Using CEC to put the PS5 into standby would be PS5 control, which [AGENTS.md](../../AGENTS.md) forbids.
- What to do with CEC is **turn it off**: on the TV inside its locked settings (Samsung Anynet+, LG SIMPLINK, Sony BRAVIA Sync), and optionally on the PS5 under Settings > System > HDMI ([Tom's Guide](https://www.tomsguide.com/tvs/heres-how-to-stop-your-tv-from-turning-on-your-xbox-or-ps5), COMMUNITY; no official playstation.com page found, UNVERIFIED). A customer can re-enable the PS5 setting, so the TV-side setting is what matters.
- WyreStorm lists full CEC passthrough; whether CEC from a non-selected input still reaches the TV is UNVERIFIED and needs a physical test.

## 3. Regional caveat: Malaysia and South-East Asia

- Samsung's BED-H Business TV datasheet marks **Panel button lock, USB port lock, PlayLock and VXT as "S.E Asia: No"** ([datasheet](https://image-us.samsung.com/SamsungUS/home/pdf/Samsung_Business_TV_BE98D-H_Datasheet.pdf), OFFICIAL).
- The same datasheet lists a **SolarCell Bluetooth remote** for S.E. Asia. An IR-only lock may not stop a Bluetooth remote (UNVERIFIED; test it).
- Lock features therefore vary by region and SKU. Before buying, confirm for the exact Malaysian SKU that the key lock exists, which remotes it covers, and that it can be read back.

## 4. LG's lock clears on a mains power cycle

The LG manual states: "When main power is off & on (plug-off and plug-in, after 20-30 seconds), external control lock is released" ([UV340C manual](https://www.lg.com/us/business/download/resources/BT00001837/UV340C-U_Install_Manual_170825.pdf), OFFICIAL). Pulling the TV's plug defeats the `km` lock. Any Tier 2 design therefore requires the server to:

1. detect the TV reconnecting;
2. set blocking to `PENDING` while it re-applies the intended mode and the lock;
3. read both back and only then return to `CONFIRMED`, or `FAILED` with a staff alert.

Re-applying the intended mode on reconnect is an open item in the [readiness checklist](README.md#pre-adapter-readiness-checklist). The "Mains power cycle" proposed test row covers it.

## 5. Rejected options

### Smart plug cutting PS5 power

The PS5 Quick Start Guide says: "Disconnect the AC power cord from the electrical outlet only when the power indicator is off. If you disconnect it while the power indicator is on solidly or blinking, data might be lost", and that data can be corrupted and the console damaged ([ManualsLib mirror](https://manualslib.mx/manual/800926/Sony-Ps5.html?page=12), VENDOR-AUTHORED, THIRD-PARTY HOSTED; Sony's own copy was not found, but see Sony's [power indicator page](https://www.playstation.com/en-ca/support/hardware/ps5-ps4-power-indicator-lights/)). Cutting PS5 power is also PS5 control, which AGENTS.md forbids. Do not implement it, even as a fallback.

### Continuous capture

- Forbidden by AGENTS.md.
- Elgato says the PS5's HDCP setting must be turned off before capture works, because HDCP "blocks video capture" ([Elgato](https://www.elgato.com/ww/en/explorer/products/capture/how-to-set-up-game-capture-4k-s-with-playstation-5-and-playstation-5-pro/), OFFICIAL for Elgato's products). A capture device in the signal path sees nothing usable while HDCP is on, and a customer can change that setting.
- Capture only shows the signal path, not what is on the panel. A camera pointed at the TV records customers; Malaysian PDPA implications are UNVERIFIED.
- Stripping HDCP may engage Malaysia's Copyright Act 1987 s.36A on circumventing technological protection measures. WIPO Lex lists the Act ([WIPO Lex](https://www.wipo.int/wipolex/en/text/597931)), but the section text was not read. **The legal points are UNVERIFIED and this is not legal advice.**
- A possible last-resort design, only if Rank 1/2 protocol readbacks turn out unavailable: a single frame grabbed from a switch's monitor output only at expiry or on a tamper alert, compared in memory with the known expired-screen image and never stored. Prefer protocol readbacks.

## 6. Proposed staff display per tier (future migration)

**Keep the five existing `BlockingStatus` values** (`NOT_APPLICABLE`, `PENDING`, `CONFIRMED`, `FAILED`, `UNVERIFIED`, in [`packages/contracts/src/index.ts`](../../packages/contracts/src/index.ts)). Add, through a new migration and a contract change, two separate fields:

- `blockAssurance: "SIMULATED" | "SOFT" | "TV_LOCKED" | "HARDWARE_ROUTED"`
- `blockVerifiedAt: number | null` (server time of the last matching readback)

These are internal codes. Staff-facing strings must never contain "secure", "tamper-proof" or "locked" as a claim about the session; they describe what the device reported.

### 6.1 Rules for every tier

| Adapter result | `blockingStatus` |
|---|---|
| `SUCCESS` with a matching readback (`verified: true`) | `CONFIRMED` |
| `SUCCESS` without `verified`, or `UNVERIFIED` | `UNVERIFIED` |
| `UNSUPPORTED` | `FAILED` (the adapter said it cannot block) |
| `FAILURE`, `TIMEOUT`, `DEVICE_OFFLINE` | `FAILED` |
| Later readback mismatch, or the device reconnects | `PENDING` while re-applying, then `CONFIRMED` or `FAILED` plus a staff alert |

- Re-verify on a bounded interval with backoff and whenever the device reconnects.
- `CONFIRMED` only from a readback that matches the expected state.

### 6.2 Exact wording per tier

| Tier | State | Colour | Staff-facing text |
|---|---|---|---|
| SIMULATED (now) | `CONFIRMED` | neutral | "Expiry screen CONFIRMED - SIMULATED (mock TV, no physical device)" |
| SOFT (consumer TV, software command) | `UNVERIFIED` | amber | "Expiry screen requested, not verified. Customer can switch back with the TV remote or TV buttons." |
| SOFT | `CONFIRMED` | amber | "Expiry screen CONFIRMED at HH:MM:SS - software only, bypassable" |
| SOFT | later mismatch -> `FAILED` | red | "TV left the expiry screen at HH:MM:SS - go to station" |
| TV_LOCKED (commercial TV) | `CONFIRMED` | neutral | "Expiry screen CONFIRMED at HH:MM:SS - TV remote and buttons disabled, device-reported" |
| TV_LOCKED | input matches, lock unreadable -> `UNVERIFIED` | amber | "Expiry input confirmed; key lock not verifiable" |
| TV_LOCKED | after reconnect or power cycle -> `PENDING` | amber | "Re-applying expiry screen and key lock after reconnect" |
| HARDWARE_ROUTED (HDMI switch) | `CONFIRMED` | neutral | "PS5 signal disconnected at switch at HH:MM:SS - device-reported" plus a separate line "Expiry message: CONFIRMED" or "Expiry message: UNVERIFIED" |
| HARDWARE_ROUTED | switch unreachable -> `FAILED` | red | "Switch offline - PS5 picture may be visible" |

Tier 2 `CONFIRMED` requires **both** the input readback equal to the expired source **and** the lock readback on (Samsung `0x5D`/`0x77` get, LG `km` with `FF`). Tier 3 `CONFIRMED` requires the switch's readback to show the PS5 is not routed to the TV (`GET MP out`, `Status`, or `x1$ sta` returning off).

Every tier also shows: **"Console still running: Remote Play or controller audio possible. End the console session at the station."** Ending the console session is a manual staff task; automating it would be PS5 control.

These strings are consistent with [operator-ux.md](operator-ux.md#6-failed-or-unverified-expired-screen-alerts): the alert is keyed on `blockingStatus`, never on `lastCommand`.

## 7. Rollout recommendation for the user

All purchases and network changes need explicit approval.

1. **Pilot on Tier 1 (SOFT) with basic setup:** remotes stored away, CEC off on every TV, TV control interfaces on an isolated staff VLAN, the honest SOFT wording on the dashboard.
2. **Tier 2:** buy commercial SKUs only after confirming the Malaysian variant really has the key lock, which remotes it covers (IR and Bluetooth), and that it can be read back. Test one unit through the full matrix before buying the rest.
3. **Tier 3:** use an HDMI switch with routing readback wherever bypass resistance matters, after a PS5 compatibility test (4K120, VRR, HDCP) on that switch model.

## 8. Code findings (REPO)

These were seen during the research. They are listed here so staff wording and the mock stay truthful; this document does not fix them.

Fixed in the 2026-10-25 slice, per the slice plan. Other agents implemented these in parallel; work-in-progress code for both was visible in `apps/server/src/system.ts` and `apps/server/src/adapters.ts` while this document was written, but this document did not run or verify it. The verified result, or its absence, is in [CURRENT_STATUS.md](../agent/CURRENT_STATUS.md). The descriptions below are of the code before the fix:

- **UNSUPPORTED mapped to FAILED.** `blockingStatus()` in `apps/server/src/system.ts` mapped `UNSUPPORTED` to `UNVERIFIED`, which suggests the block might have happened when the adapter actually reported it cannot block. This matters for the default `UnverifiedTvAdapter`, whose `enterExpiredMode()` returns `UNSUPPORTED`. It should be `FAILED` (or an explicit "NOT BLOCKED: manual action" message).
- **The bypass modelled in the mock.** `SWITCH_INPUT` and `REMOTE_KEY` while `EXPIRED` did not recalculate `blocking_status`, and `MockTvAdapter.switchInput` changed `input` but left `displayedMode` as `EXPIRED`. A TV Remote switch to HDMI1 after expiry showed "Block CONFIRMED" next to "Input HDMI1": exactly the remote-button bypass, hidden by the simulation. The mock should show the PS5 after an input change while expired, and block status should be derived from readback after any command that affects the input.

Still open:

- **Periodic re-verification.** Block status is evaluated once at LOCK time. It needs a bounded verification tick and push-driven checks, with `FAILED` plus a staff alert on mismatch.
- **Assurance tiers.** `blockAssurance` and `blockVerifiedAt` (section 6) need a contract change and a migration.
- **Simulated `CONFIRMED` shown without a qualifier.** `apps/web/src/App.tsx` prints the raw `Block {blockingStatus}`, so mock stations show "CONFIRMED" although `StationView.simulated` exists. The README says a simulated `CONFIRMED` proves only that the mock reached its expired screen; the label should read "CONFIRMED (simulated)".
- **`SET_REMAINING` on `EXPIRED`/`NONE`/`ENDED`** (current Phase 2 Next task). The non-paused branch sets the session `ACTIVE` with a new deadline but does not change `mode` or `blocking_status`, call `enterGamingMode`, or set `started_at`. After expiry, setting 30 minutes left produces an `ACTIVE` countdown while mode stays `EXPIRED` and the card says `CONFIRMED`. The Next task must choose: reject `SET_REMAINING` outside `ACTIVE`/`PAUSED`, or restore gaming mode as `ADD_TIME` does. [operator-ux.md](operator-ux.md#2-duration-flow-rules) recommends rejecting it.

## 9. Risks and sources

### 9.1 Risks

- No physical TV, switch or PS5 was tested.
- Several sources are distributor- or mirror-hosted copies (Samsung manuals via Ingram Micro, WyreStorm via Ambertech, the PS5 guide via ManualsLib); the PS5 HDMI menu path is third-party only.
- Lock features vary by region and SKU; IR-only locks may not apply to the Bluetooth remote shipped in S.E. Asia.
- Default admin credentials and menu entry methods are published in public manuals; they must be changed and stored encrypted, never as plaintext rows.
- LG's RS-232C lock clears after a mains power cycle; Tier 2 depends on the server re-applying it.
- Blocking the display never stops the console (Remote Play, controller headset audio).
- PS5 compatibility through an HDMI switch is unverified; the Atlona example tops out at 4K60.
- No prices were verified.
- The legal points (HDCP circumvention, camera privacy) are unverified and not legal advice.

### 9.2 Sources (accessed 2026-10-25)

OFFICIAL:

- Atlona AT-HDR-H2H-44M API: https://ts.atlona.com/pdf/AT-HDR-H2H-44M_API.pdf
- Global Caché unified TCP API: https://www.globalcache.com/files/docs/api-gc-unifiedtcp.pdf
- PlayStation 4K guide: https://www.playstation.com/en-us/support/hardware/ps5-4k-resolution-guide/
- PlayStation Remote Play on mobile: https://www.playstation.com/en-us/support/games/playstation-remote-play-on-mobile-devices/
- PlayStation power indicator lights: https://www.playstation.com/en-ca/support/hardware/ps5-ps4-power-indicator-lights/
- Samsung VXT docs: https://docs.samsungvx.com/docs/x/WBWUAw
- Samsung BED-H datasheet: https://image-us.samsung.com/SamsungUS/home/pdf/Samsung_Business_TV_BE98D-H_Datasheet.pdf
- LG UV340C install manual: https://www.lg.com/us/business/download/resources/BT00001837/UV340C-U_Install_Manual_170825.pdf
- Sony BRAVIA Pro function restrictions: https://pro-bravia.sony.net/guides/references/prosettings/android_latest/4_function_restrictions/4-1_tv_remote_controls/
- Sony BRAVIA Pro REST API: https://pro-bravia.sony.net/remote-display-control/rest-api/reference/
- Shelly Gen2 RPC: https://shelly-api-docs.shelly.cloud/gen2/General/RPCChannels/
- Google TV help: https://support.google.com/googletv/answer/11136134
- Android HDMI-CEC: https://source.android.com/docs/devices/tv/hdmi-cec
- Elgato PS5 capture setup: https://www.elgato.com/ww/en/explorer/products/capture/how-to-set-up-game-capture-4k-s-with-playstation-5-and-playstation-5-pro/
- WIPO Lex (Malaysia Copyright Act listing): https://www.wipo.int/wipolex/en/text/597931

VENDOR-AUTHORED, THIRD-PARTY HOSTED:

- WyreStorm EXP-SW-0401-8K API and spec sheet: https://www.ambertech.com.au/Documents/Manuals/Wyrestorm/WY-EXPSW04018K_API.pdf, https://www.ambertech.com.au/Documents/Manuals/Wyrestorm/WY-EXPSW04018K_SpecSheet.pdf
- Samsung Smart Signage manual: https://inquirecontent2.ingrammicro.com/User-Manual/1059378728.pdf
- Samsung HG43Q60B install guide: https://inquirecontent2.ingrammicro.com/User-Manual/1077613251.pdf
- PS5 Quick Start Guide mirror: https://manualslib.mx/manual/800926/Sony-Ps5.html?page=12

COMMUNITY / REVERSE-ENGINEERED:

- python-samsung-mdc: https://github.com/vgavro/samsung-mdc
- Tom's Guide (PS5/Xbox CEC): https://www.tomsguide.com/tvs/heres-how-to-stop-your-tv-from-turning-on-your-xbox-or-ps5
- HDMI port lock product listing: https://www.bechtle.com/es/shop/hdmi-port-lock-blue-10x--6004826--p

UNVERIFIED (snippet only):

- Xiaomi Mi Remote support article: https://www.mi.com/global/support/article/KA-36411/

## 10. Physical verification checklist

Nothing below has been tested. Record every row per device (TV, switch, converter, plug) by manufacturer, exact model, region/SKU and firmware, in the format of [docs/HARDWARE_LIMITATIONS.md](../HARDWARE_LIMITATIONS.md#minimum-test-record-per-model), before any tier is offered to staff as more than SOFT.

| Field | Required evidence |
|---|---|
| Identity | Manufacturer, exact model, local SKU, region, firmware for the TV and every device in the signal or control path |
| Tier | Which assurance tier is being claimed, and the readback commands that prove it |
| PS5 signal path | Through any switch or matrix: 4K120, VRR, ALLM, HDCP 2.3 handshake, EDID, picture recovery time after switching back, audio |
| Routing readback (Tier 3) | Route away from the PS5 and read it back (`GET MP out`, `Status`, `x?$ sta`); auto-switching off and staying off; front panel and IR disabled and read back |
| Lock readback (Tier 2) | Input and lock both read back (Samsung `0x14` and `0x5D`/`0x77`, LG `FF` status and `km`, Sony `getPlayingContentInfo`); which remotes (IR, Bluetooth) and panel buttons still work while locked |
| Credentials | Every published default PIN or installer password changed and stored encrypted |
| Bypass: remote and buttons | During an expired session, try the TV remote SOURCE/INPUT/HOME, panel buttons, a phone IR blaster, and a phone remote app from the customer network |
| Bypass: CEC | PS5 controller wake during an expired session with TV CEC on and off, PS5 Device Link on and off, and with locks applied; CEC passthrough from a non-selected switch input |
| Bypass: power | Mains power cycle of the TV (and switch): what state it returns in, whether the lock survives, and whether the server re-applies mode and lock unaided |
| Bypass: cabling | Time and tools needed to re-plug the PS5 directly into the TV with the enclosure and port blockers fitted |
| Smart plug (Tier 3 fallback only) | Relay state readback; TV behaviour on power return; staff text shows "screen not verified" |
| Staff display | Each wording string in section 6.2 appears for the matching state; no screen says "secure", "tamper-proof" or "locked"; the "console still running" line is shown |
| Re-verification | Bounded re-verification interval measured; a deliberate mismatch (manual input change) becomes `FAILED` with an alert within that interval |
| Recovery | Switch or TV offline at expiry, then reconnect; server restart during an expired session; firmware update forcing a re-test |

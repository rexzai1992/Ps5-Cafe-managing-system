# Research Index: TV Control, Display Blocking and Operator UX

Research date: 2026-10-25 (Asia/Kuala_Lumpur).
Audience: engineers who will later build and physically verify real TV adapters, and the café owner choosing hardware.

> **Status: research only. Nothing in `docs/research/` is implemented, enabled or physically verified.**
> No physical TV, display, HDMI switch, serial converter, smart plug or PS5 was contacted while producing these documents. Only `MockTvAdapter` runs in this repository ([`apps/server/src/adapters.ts`](../../apps/server/src/adapters.ts)). Every vendor, protocol and per-model claim is **UNVERIFIED** until it passes the test matrix in [`docs/HARDWARE_LIMITATIONS.md`](../HARDWARE_LIMITATIONS.md) for the exact manufacturer, model, region, OS and firmware. Nothing here enables an adapter, changes a `DeviceCapabilities` flag, approves a purchase, registers a service or changes a network.

## Documents

| Document | Covers | Headline conclusion |
|---|---|---|
| [android-tv.md](android-tv.md) | Android TV / Google TV: Remote protocol v2, ADB, a companion APK, HDMI-CEC | Remote v2 is the most practical path, but it is reverse-engineered, has no command ACK and cannot read back the HDMI port. ADB is for a test harness only. |
| [samsung-tizen.md](samsung-tizen.md) | Samsung: consumer WebSocket remote, SmartThings, MDC, Tizen apps, ExLink RS-232 | Only MDC on commercial displays gives documented absolute input selection with device-reported readback. Consumer TVs are keys-only and UNVERIFIED. |
| [display-locking.md](display-locking.md) | Ranking ways to make the expired screen hard to bypass; how staff should see blocking evidence | An HDMI switch with routing readback is the only option that removes the PS5 picture in hardware. Nothing is tamper-proof. |
| [operator-ux.md](operator-ux.md) | Operator dashboard precedents and testable UX rules behind the Phase 2 web items | Concrete rules for presets, custom duration, set-remaining, pending states, warnings and failed-expiry alerts; billing, CRM and PS5 control excluded. |

## Evidence legend

Every claim in these documents carries one of these labels. A higher label is still not physical verification.

| Label | Meaning | Examples |
|---|---|---|
| **OFFICIAL** | Published by the vendor or standards body on its own site | Android `KeyEvent` reference; SmartThings capability pages; Samsung developer site; WCAG |
| **VENDOR-AUTHORED, THIRD-PARTY HOSTED** | Written by the vendor, but the copy read is on someone else's server, so it may be outdated or altered | Samsung MDC spec v15.0 on `vgavro.github.io`; Samsung signage manuals via Ingram Micro; WyreStorm PDFs via Ambertech; the PS5 Quick Start Guide via ManualsLib |
| **COMMUNITY / REVERSE-ENGINEERED** | Open-source libraries, Home Assistant docs and code, forums, third-party how-to guides | `androidtvremote2`, `samsungtvws`, `python-samsung-mdc`, Tom's Guide |
| **UNVERIFIED** | Search snippet only, page not retrievable, the researcher's inference, or sources disagree | Smart View SDK support on new TVs; PS5 HDMI menu paths; Android 14 TV wireless-debugging reset |
| **REPO** | Observed in this repository's source during the research; line numbers move | `execute()` in `apps/server/src/system.ts` |
| **PHYSICALLY VERIFIED** | Passed the HARDWARE_LIMITATIONS.md matrix on a named model and firmware | **Nothing has this label yet.** |

## Cross-cutting findings

1. **No mechanism observes the pixels on an HDMI input.** The best evidence is device-reported state (Samsung MDC GET, an HDMI switch's routing readback, LG RS-232C status, Sony BRAVIA Pro REST) or a companion app reporting its own foreground lifecycle. A `CONFIRMED` block should read "expired screen reported by the device", never "locked".
2. **`secureDisplayBlocking` stays `false` for every mechanism researched**, including commercial key locks and HDMI switches.
3. **Toggle commands are never retried.** POWER, MUTE, Samsung `KEY_HDMI` cycling and Android `KEYCODE_TV_INPUT` act relative to the current state, so a retry can undo the first send. Bounded retries with backoff are only for absolute targets (Android `WAKEUP`/`SLEEP` and `TV_INPUT_HDMI_n`, MDC set-power/set-input/set-volume, switch routing).
4. **HDMI-CEC is a bypass, not a lock.** PS5 One-Touch Play / HDMI Device Link can switch the TV back to the PS5 when a customer wakes the console with a controller (third-party guides; UNVERIFIED from Sony). Turn CEC off on each TV and test the wake scenario on every model.
5. **Customers sit in front of the TVs.** Any code or prompt shown on screen (Android TV Remote pairing code, Samsung 8002 allow/deny, ADB authorisation) can be read or accepted by a customer. TV control ports belong on a staff-only network.
6. **Firmware can change behaviour silently.** Pin each profile to the tested firmware and flag a station for re-test when the reported firmware changes.
7. **Blocking the display never stops the console.** PS Remote Play and controller headset audio continue. Ending the console session is a manual staff task; automating it would be PS5 control.

## Pre-adapter readiness checklist

Repository changes needed before **any** real adapter can be enabled. They come from code reading during this research (REPO). None of them enables an adapter by itself.

### Done in this slice (2026-10-25), per the slice plan

These were assigned to other agents working in parallel with disjoint file ownership. While this index was being written, work-in-progress code for them was visible in `apps/server/src/system.ts` and `apps/server/src/adapters.ts` (for example a 5 s default command timeout and a mock `switchInput` that shows the PS5). **This document did not run or verify that code.** The verified result, or its absence, is recorded in [`docs/agent/CURRENT_STATUS.md`](../agent/CURRENT_STATUS.md) and by `npm run verify`.

| Item | Why it is needed | Detail |
|---|---|---|
| Bounded adapter calls that yield `TIMEOUT` | A hung adapter call stalled its station's queue forever. Remote v2's reference library has no connect timeout; Samsung references suggest about 5 s for normal commands | [android-tv.md §4](android-tv.md#4-liveness-and-reconnect-feeds-timeout-and-device_offline-design), [samsung-tizen.md §10](samsung-tizen.md#10-reference-timeout-and-retry-values-feeds-the-phase-3-timeout-outcome) |
| Atomic `execute()` | `execute()` mutated the session in memory, awaited the adapter and then `getDeviceStatus()`, and only then called `persist()`. A throwing or hanging adapter left memory and SQLite out of step and an expired station stuck at `PENDING` | [android-tv.md §6.3](android-tv.md#63-repository-prerequisites-repo-findings-not-fixed-by-this-document), [samsung-tizen.md §13](samsung-tizen.md#131-risks) |
| Expiry re-check | A queued expiry LOCK should re-check that the session is still due when it runs, so time added just before it is not overridden | [display-locking.md §8](display-locking.md#8-code-findings-repo) |
| `UNSUPPORTED` mapped to `FAILED` | `UNSUPPORTED` was shown as `UNVERIFIED`, implying the block might have happened when the adapter said it cannot block | [display-locking.md §6.1](display-locking.md#61-rules-for-every-tier) |

### Still open

| Item | Why it is needed |
|---|---|
| Adapter factory keyed by `adapter_kind`, real kinds off by default | `RuntimeStation.adapter` is typed `MockTvAdapter` and every station is built as one whatever `adapter_kind` says. Real kinds must be enabled only per verified model profile. |
| `SimulationControls` interface | `SET_CONNECTION`, `SIMULATE_NEXT_FAILURE` and `SIMULATE_UNSUPPORTED` call mock-only methods on the generic action path. Expose them only on simulated stations and reject them (400) on real stations. |
| Nullable `DeviceState` with provenance, plus a `device_state_json` version migration | Real readback is partial: Remote v2 has no input readback; the Samsung WebSocket has only `PowerState`. Fields need an "unknown" value and provenance (`observedAt`, and a `source` of push, poll or assumed) so assumed state is never shown as verified. Persisted JSON needs a version through a new, append-only migration. |
| Per-dimension readback flags replacing `stateVerification` | One boolean cannot say "power and foreground app, but not input". Proposed: `powerReadback`, `volumeReadback`, `foregroundAppReadback`, `inputReadback`, `lockReadback`, `companionHeartbeat`. |
| Evidence level on `CommandResult` | `verified` alone drives `CONFIRMED`. Proposed levels: `NONE`, `ACKNOWLEDGED`, `DEVICE_REPORTED`, `OBSERVED`. |
| Periodic re-verification of the expired screen | Blocking is evaluated once, at LOCK. A customer can press Input, pair a phone or trigger CEC a second later. Needs a bounded verification tick plus push-driven checks; a mismatch becomes `FAILED` with a staff alert. |
| Re-applying the intended mode on reconnect | A TV that was offline at expiry stays on HDMI after reconnecting (operator-ux probe); LG's key lock clears on a mains power cycle. |
| `AbortSignal` for adapter calls | A timeout must cancel the underlying socket or request so a late reply cannot act after `TIMEOUT` was recorded. |
| A pairing action separate from `connect()` | A human must read a code off the TV (Remote v2) or accept a prompt (Samsung 8002, ADB). It belongs under Device Settings with about a 30 s bound. |
| Absolute power and mute semantics | `mute()` toggles. Propose `setMuted(boolean)`, and map `powerOn`/`powerOff` to absolute commands (Android `WAKEUP`/`SLEEP`, MDC `0x11`). |
| Blocking assurance tier and verified-at time | `blockAssurance` (`SIMULATED`, `SOFT`, `TV_LOCKED`, `HARDWARE_ROUTED`) and `blockVerifiedAt`, as a contract change plus migration ([display-locking.md §6](display-locking.md#6-proposed-staff-display-per-tier-future-migration)). |

## Decisions needed from the user

Only the user can make these. Until each is recorded, the default in the last column applies.

| Decision | Why it needs the user | Default until decided |
|---|---|---|
| Accept the reverse-engineered **Android TV Remote v2** protocol? | AGENTS.md requires documented commands; Google publishes only a 2017 pairing repo and a help page ([android-tv.md §2.4](android-tv.md#24-policy-conflict-the-user-must-resolve)) | Not used; no Remote v2 code written |
| Accept Samsung's **community-documented WebSocket remote**? | No Samsung documentation; keys only; cannot select HDMI1-4 ([samsung-tizen.md §2](samsung-tizen.md#2-consumer-tizen-websocket-remote-ports-80018002)) | Not used |
| Buy **MDC-capable commercial displays** and/or **controllable HDMI switches**? | Purchases need approval; Malaysian SKU lock features must be confirmed first ([display-locking.md §7](display-locking.md#7-rollout-recommendation-for-the-user)) | No purchase; consumer TVs treated as SOFT at best |
| Use **SmartThings** or **Google Cast**? | Cloud dependency, a Samsung account and OAuth registration (SmartThings); a paid, non-refundable US$5 registration (Cast). Both break LAN-first | Out of scope |
| **TV network isolation** (staff-only VLAN/SSID, ACL to control ports) | A network change; also required before any pairing-based protocol is safe | No network change made; real adapters stay disabled |

Other decisions raised in the documents: Samsung ExLink service-menu changes and Tizen developer mode or Partner registration ([samsung-tizen.md](samsung-tizen.md)); enabling ADB on a test unit ([android-tv.md §7.4](android-tv.md#74-policy)); keeping TV key locks on during gameplay or toggling them per mode ([samsung-tizen.md §5](samsung-tizen.md#5-proposed-samsungmdcadapter-mapping-and-outcome-rules)); and what PAUSE should do to the TV ([operator-ux.md §11](operator-ux.md#11-open-product-question-pause-leaves-the-tv-on-hdmi)).

## New rows for HARDWARE_LIMITATIONS.md (applied 2026-10-25)

These rows were proposed by this research and have since been added to the minimum test record in [`docs/HARDWARE_LIMITATIONS.md`](../HARDWARE_LIMITATIONS.md).

| Field | Required evidence |
|---|---|
| CEC wake after expiry | With the station expired and the expired screen up, wake the PS5 from rest with its controller. Record whether the TV switches back to the PS5 input with TV CEC (Anynet+, SIMPLINK, BRAVIA Sync) on and off, PS5 HDMI Device Link on and off, and with any key lock or switch routing applied. Pass: the expired screen stays and the next re-verification still matches. |
| Customer phone pairing | From a phone on the customer Wi-Fi, try to pair the vendor remote app (Google TV app, SmartThings, other vendor remote apps) during an expired session. Record whether the TV is discoverable, whether a pairing prompt or code appears over the expired screen, and whether any key or input change is accepted. Pass: the TV is not reachable from the customer network. |
| Mains power cycle | Unplug the TV at the wall during an expired session, wait at least 30 s, restore power. Record the power-on state and input, whether each key or remote lock survives, how long until the TV is reachable, and whether the server re-applies the expired mode and lock without staff action. |
| Firmware change | Record the firmware before and after any update, and whether automatic updates are on. After a change, re-run the full matrix before the profile is re-enabled; record how the server detects the change and that it flags the station for re-test. |

## Never

- PS5 control of any kind: power, rest, CEC standby, smart plugs on the console, or anything sent to the console.
- Continuous gameplay or screen capture, or cameras pointed at customers.
- Rooting, flashing or modifying TV firmware.
- ADB exposed publicly or to the customer network, or left enabled after testing without explicit user acceptance.
- Calling any tier, lock or expired screen "secure", "tamper-proof" or "locked" in staff-facing text.
- Reproducing default PINs, installer passwords or hidden service, hotel or developer menu key sequences in this repository.
- Enabling a real adapter, or setting a capability flag to `true`, from documentation alone.

## Physical verification checklist

A cross-cutting summary; each document ends with a detailed checklist. Nothing below has been tested. Record every row per manufacturer, exact model, region/SKU, OS and firmware, in the format of [docs/HARDWARE_LIMITATIONS.md](../HARDWARE_LIMITATIONS.md#minimum-test-record-per-model).

| Field | Required evidence |
|---|---|
| Identity | Manufacturer, exact model, local SKU, region, OS and firmware for every TV, display, switch and converter in the station |
| Policy | Recorded user decisions for any community-documented protocol, purchase, service registration or network change the profile relies on |
| Network | Control ports reachable from the staff subnet only and not from customer Wi-Fi; reconnect after a DHCP change |
| Pairing | On-screen steps, credential storage (encrypted), and the revocation path, including what a revoked pairing returns |
| Commands | Absolute power, volume, mute and each HDMI input, each with the readback that proves it; toggles identified and never retried |
| Outcomes | Each of `SUCCESS`, `FAILURE`, `UNSUPPORTED`, `TIMEOUT`, `UNVERIFIED` and `DEVICE_OFFLINE` produced on purpose and shown distinctly to staff |
| Modes | Idle advertising, gameplay transition and expiry transition, with measured p50/p99 latency |
| Re-verification | A deliberate input change after expiry is detected and becomes `FAILED` with an alert within the bounded interval |
| Bypass | Remote INPUT/SOURCE/HOME, panel buttons, phone apps, reboot, mains power cycle and PS5 controller wake, each during an expired session |
| PS5 signal path | 4K120, VRR, ALLM and HDCP through every device between the PS5 and the TV |
| Recovery | Standby, reboot, server restart, device offline at expiry then reconnect, authorisation revoked, firmware change |
| Wording | Staff text matches [display-locking.md §6.2](display-locking.md#62-exact-wording-per-tier); simulated results are labelled simulated |

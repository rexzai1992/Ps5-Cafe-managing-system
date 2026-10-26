# Operator Dashboard UX Research

Research date: 2026-10-25 (Asia/Kuala_Lumpur). All URLs below were accessed on that date unless a different date is given.
Audience: engineers building the Phase 2 operator dashboard ([IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md#phase-2--complete-operator-dashboard-next)), and the café owner reviewing how staff will see sessions and failures.

> **Status: research only. Nothing in this document is implemented or physically verified in this repository.**
> These are proposed, testable rules. Whether the Phase 2 slice implemented any of them is recorded in [`docs/agent/CURRENT_STATUS.md`](../agent/CURRENT_STATUS.md), not here. Code observations describe the tree as read on 2026-10-25 and line numbers move. A browser-rendered check of these rules on the simulated dashboard proves only the dashboard; it is **not** proof that a real TV showed anything (AGENTS.md keeps simulation, browser and hardware proof separate).

Evidence labels follow [README.md](README.md#evidence-legend). For this document: **OFFICIAL** includes standards (W3C WCAG, WAI-ARIA APG), platform docs (MDN, React, Socket.IO, Android) and vendors' own help or marketing pages; a vendor page shows that a precedent exists, not that it works well. **REPO (probe)** means a throwaway script ran the real `TvManagementSystem` against an in-memory database with `FakeClock`, outside the repository; the scripts were not committed and are not part of `npm run verify`.

## 1. Precedents and evidence quality

| Product | Relevant behaviour | Evidence quality |
|---|---|---|
| iCafeCloud | Per-console remaining time; configurable "minutes before end" warnings at several intervals, shown as an orange notification that stays until checkout; move session; states that locking offline clients is handled by other methods ([warnings](https://www.icafecloud.com/wiki-notification-before-console-end.htm), [auto checkout](https://www.icafecloud.com/wiki-how-auto-checkout-works.htm), [move session](https://icafecloud.com/wiki-move-session.htm)) | Vendor help wiki |
| HandyCafe | Consoles view sorted with least time left first; a minutes start with "No additional confirmation dialog"; Add Time accepts positive or negative minutes with a confirmation step; a grace period after stop ([consoles](https://handycafe.com/en/docs/consoles), [sessions](https://handycafe.com/en/docs/sessions), [console power](https://handycafe.com/en/docs/console-power)) | Vendor docs |
| ggCircuit / ggLeap | Console list view ([KB](https://ggcircuit.atlassian.net/wiki/spaces/GKB/pages/15863567/PC+list+-+Consoles+View)); no documentation found for session warnings or presets | Vendor knowledge base |
| SENET | "Smart notifications when a session is about to end"; "Instant alerts for any issues or disconnections" ([controllers](https://senet.cloud/controllers)) | Vendor marketing |
| Timeout Mobile | Role-based access; "modification of time added" in its changelog ([App Store](https://apps.apple.com/us/app/timeout-mobile/id6759071539)) | App Store listing |
| Samsung LYNK Cloud | Managers can "check errors in real time" ([HQ60A spec sheet](https://image-us.samsung.com/SamsungUS/samsungbusiness/tvs/hospitality/luxury/hq60a-series-43/HTV_HQ60A_SERIES.pdf)) | Official Samsung spec sheet |
| LG ConnectedCare | Dashboard "displays the overall connection status of the devices" ([LG](https://www.lg.com/sg/business/information-display/software-solutions/lg-business-cloud/lg-connectedcare/)) | Official LG page |
| Samsung MagicINFO / VXT | Device health shows "whether the device has any error/warning message"; connection history ([VXT docs](https://docs.samsungvx.com:443/docs/x/BwHVAg)) | Official Samsung docs |
| PlayStation | Shows "notifications ... to let them know their playtime is about to end" ([play time controls](https://www.playstation.com/en-us/support/account/play-time-controls-playstation/)) | Official Sony page |

Not found or not retrievable: Gizmo session-warning docs; a QTIME 10-minute warning (pages returned 403/404, UNVERIFIED).

## 2. Duration flow rules

### 2.1 Server defects the duration UI would expose (REPO, at time of writing)

These were confirmed by probe or by reading `apps/server/src/system.ts` and `apps/web/src/App.tsx` on 2026-10-25. They matter because adding five presets and a set-remaining dialog multiplies the chances of hitting them.

| Defect | Observed | Proposed rule | Fastify tests |
|---|---|---|---|
| START over a running session silently replaces it | Probe: START 2h, then START 15m -> `remainingMs` 900000; the customer loses 1h45m with a success response. The card shows "Start 1h" for every status | Server rejects START unless `session.status` is `NONE`, `ENDED` or `EXPIRED` (400 "Session already running; use Add time or Set remaining"). UI shows Start presets only for those statuses, and Add time / Set remaining for `ACTIVE`/`PAUSED` | START on `ACTIVE` -> 400 and `deadlineAt` unchanged; START on `PAUSED` -> 400; START on `EXPIRED` -> 200 |
| `SET_REMAINING` has no status guard | Probe: `NONE` -> session `ACTIVE`, mode `IDLE`, `startedAt` null, no gaming command. `ENDED` -> `ACTIVE` with mode `IDLE`. `EXPIRED` -> session `ACTIVE` while mode `EXPIRED` and block `CONFIRMED`, a 10:00 timer ticking on a "TIME EXPIRED" card. No test exercised `SET_REMAINING` | Reject unless `ACTIVE` or `PAUSED` (400 "No running session; use Start"). (The alternative, restoring gaming mode as `ADD_TIME` does, is discussed in [display-locking.md](display-locking.md#8-code-findings-repo); rejecting is simpler and keeps START the only way to begin a session) | `ACTIVE` -> `deadlineAt == now + d`, status `ACTIVE`; `PAUSED` -> stays `PAUSED`, `pausedRemainingMs == d`, `deadlineAt` null; `NONE`/`ENDED`/`EXPIRED` -> 400, state unchanged; 0 and > 24 h -> 400 (`requireDuration`) |
| `SHOW_ADVERTISING` on a running session leaves a session that never expires | Probe: `ACTIVE` 2h -> Advertising -> status `ACTIVE`, `deadlineAt` null, `remainingMs` 0; three hours later still `ACTIVE` (the tick skips null deadlines) and still pausable. `PAUSED` -> Advertising -> RESUME gives deadline = now. The card's Advertising button has no confirmation | Server rejects `SHOW_ADVERTISING` while `ACTIVE` or `PAUSED` ("End the session first"). UI offers "Show advertising" only for idle, ended or expired stations | Both rejections -> 400 with state unchanged |
| Double-click executes twice | `postCommand` generates a new `Idempotency-Key` inside every fetch and `act()` has no in-flight guard, so a double-tap on "+30m" sends two distinct keys and adds 60 minutes | See section 4 | Web unit test of the pending map (section 2.6) |

Changing these guards changes API behaviour. Responses stored for idempotency before the change will still replay their old outcome for up to 24 hours.

### 2.2 Start presets

- Exact values: 15m = 900_000, 30m = 1_800_000, 1h = 3_600_000, 2h = 7_200_000, 3h = 10_800_000 ms, plus "Custom...".
- **Source of the set:** the project plan ([IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)). No vendor source documenting 15/30/60/120/180 as an industry standard was found (UNVERIFIED as a convention).
- Shown only when `session.status` is `NONE`, `ENDED` or `EXPIRED`. Each sends `{ type: "START", durationMs }`.
- **No confirmation.** Starting is routine; HandyCafe's minutes start shows no extra dialog, and NN/g advises against confirming routine actions ([NN/g confirmation dialogs](https://www.nngroup.com/articles/confirmation-dialog/)).
- At 390 px, a 3-column grid with every target at least 24 x 24 CSS px ([WCAG 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)). Larger targets are preferable at a counter; that is a design judgement, not a requirement.
- Fastify test for each preset: START -> `deadlineAt == FakeClock.now + preset`.

### 2.3 Custom-duration dialog

- Native `<dialog>` opened with `showModal()`, which makes the rest of the page inert and closes on Esc through the `cancel` event ([MDN dialog](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog)). `autofocus` on the Hours field; focus returns to the "Custom..." button on close ([APG modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)).
- Hours and Minutes as `<input inputmode="numeric">`, **not** `type="number"`, which invites accidental increments and gives no feedback on non-numbers ([GOV.UK text input](https://design-system.service.gov.uk/components/text-input/)).
- Validation matches the server's `requireDuration`: whole minutes, total > 0 and <= 24 h. The Start button stays `aria-disabled` with an inline error until valid.
- Preview line: "Ends at 21:45", computed as `snapshot.serverTime + durationMs`. Append "(simulated clock +1h05m)" when `snapshot.acceleratedByMs > 0`, so staff never read accelerated time as wall time.
- The confirm button names the action, for example "Start 1h 20m on PS5-03".

### 2.4 Set-remaining dialog

- Shown only for `ACTIVE` or `PAUSED`. Absolute value, prefilled with the current remaining time rounded down to the minute (for example 0:47).
- Live delta: "-32m" or "+13m".
- **Reducing** is disruptive: the button reads "Reduce PS5-03 to 0:15" with a second line "Customer loses 32 minutes". **Increasing** has no extra step: "Set PS5-03 to 1:00". For `PAUSED`, show "Session stays paused".
- 0 is not allowed; point to "Expire now" instead.
- Precedent: HandyCafe's Add Time takes positive or negative minutes with a confirmation step; Timeout Mobile lists "modification of time added".

### 2.5 Fastify tests for the Next task

Using `FakeClock` and an in-memory database, with an `Idempotency-Key` on every request:

- Each preset's START sets `deadlineAt == now + preset`.
- `SET_REMAINING` on `ACTIVE` and on `PAUSED` as in 2.1; rejections on `NONE`, `ENDED`, `EXPIRED`; 0 and > 24 h rejected.
- A replayed key returns `idempotent-replayed: true` and does not change the deadline again.

### 2.6 Making the rules testable

Root `npm test` runs only the server workspace (REPO, `package.json`). Put dashboard decisions into pure functions (for example `apps/web/src/logic.ts`, or shared helpers in `@ps5-cafe/contracts`) and unit-test them with a fixed `serverTime`, satisfying the injected-clock rule:

- `presetMs`
- `parseCustomDuration(hours, minutes)` -> `durationMs` or an error (rejects 0, > 24 h, non-digits)
- `warningLevel(remainingMs, status)`
- `isDisruptive(action, station)`
- `bulkEligibility(action, station)` -> ok or a skip reason
- `toastFor(httpStatus, previousCommandId, view)`

## 3. Confirmations

- **Disruptive actions** (confirm): END, Expire now (LOCK), set remaining to a lower value, remote POWER.
- **Routine actions** (no confirmation): START presets, Add time, Resume, Pause, increasing remaining time.
- Confirmation dialogs use `role="alertdialog"` with `aria-modal`, `aria-labelledby` and `aria-describedby`, and initial focus on the **least destructive** button ([APG alert dialog](https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/)).
- Button labels name the action and the station, never Yes/No ([NN/g](https://www.nngroup.com/articles/confirmation-dialog/)). Example: "End session on PS5-02? 0:24:00 of remaining time will be discarded." with [Keep playing] [End session].
- Rename the card's "Lock" button to **"Expire now"** and the "Block" label to **"Expiry screen"**, following the AGENTS.md rule against implying tamper-proof locking.

## 4. Pending state and idempotency

- **One key per intent.** Create the `Idempotency-Key` once per click and store it with a pending entry keyed by `stationId` (or `${stationId}:${actionType}`). The server pattern is `[A-Za-z0-9_.:-]{8,128}` (REPO, `apps/server/src/validation.ts`).
- While pending, the button shows a spinner and a label such as "Adding...", sets `aria-disabled="true"`, and ignores clicks in JavaScript. Do **not** use native `disabled`, which drops focus from a keyboard or D-pad user ([MDN aria-disabled](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-disabled)).
- Clear the entry when the HTTP response arrives.
- Wrap the fetch in `AbortSignal.timeout(10_000)` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static)). On `TimeoutError`, show "No response - Retry"; Retry resends with the **same** key, so the server replays instead of re-executing.
- React 19 `useTransition`'s `isPending` works, but state updates after an `await` need an extra `startTransition` ([React docs](https://react.dev/reference/react/useTransition)).

**Toasts read the command outcome, not just HTTP 200.** `ADD_TIME`, `RESUME` or `START` on an offline TV returns HTTP 200 with `lastCommand.outcome` `DEVICE_OFFLINE`, because the session changed on the server but the TV did not.

| Response | Toast |
|---|---|
| 2xx with this action's outcome `SUCCESS` and `verified: true`, or an action with no adapter command | Green `role="status"` toast, auto-dismissing after about 5 s (Carbon's guidance as read), e.g. "PS5-03: +30m, ends 22:10" |
| 2xx with `UNVERIFIED`, `UNSUPPORTED`, `DEVICE_OFFLINE`, `TIMEOUT` or `FAILURE` | Amber toast that persists until dismissed, e.g. "Time added on server; TV did not confirm (DEVICE_OFFLINE)" |
| 4xx | Red persistent toast with the server's error text |
| Network timeout | Toast with a Retry action reusing the same key |

- Place toasts top-right, newest first ([Carbon notifications](https://carbondesignsystem.com/components/notification/usage/); [WCAG 4.1.3 Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)).
- `PAUSE` and `SET_REMAINING` produce no adapter command, so the returned `lastCommand` is a stale earlier one. Either compare `lastCommand.commandId` before and after the request, or extend the response with this action's own `CommandResult` (a contract change). Otherwise toasts will misreport.
- This replaces the single global error banner, which the next station's error overwrites.

## 5. Expiry warnings at 10, 5 and 1 minutes

- `ACTIVE` sessions only, using `remainingMs = deadlineAt - snapshot.serverTime`. `PAUSED` is excluded because paused time does not decrease (iCafeCloud likewise excludes count-up sessions).
- Levels: `<= 600_000` amber "Ends in 10m" badge with a clock icon; `<= 300_000` "5 min left" with a heavier border; `<= 60_000` red "Ending".
- **Not colour alone:** always text plus an icon ([WCAG 1.4.1 Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)).
- **No blinking** beyond 5 s; use a static style ([WCAG 2.2.2 Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)).
- **One announcement per crossing**, in a single page-level `role="status"` region, e.g. "PS5-03: 5 minutes left". Track per session and threshold; re-arm when `ADD_TIME` or `SET_REMAINING` lifts `remainingMs` back above the threshold.
- **Countdown semantics:** mark each timer `role="timer"` with `aria-label="PS5-03 time remaining"`; its implicit `aria-live` is off, so screen readers are not flooded every second ([MDN timer role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/timer_role)). Do not put `aria-live` on the station grid.
- Timing precision: warnings come from `serverTime` on a 1 s tick through 50 ms broadcast coalescing, so a badge can appear up to about 1 s late. Acceptable, but never presented as precise.
- These are dashboard warnings for staff. **On-TV customer warnings are not part of this** and must not be faked as delivered on real TVs (section 10).

## 6. Failed or unverified expired-screen alerts

**Key alerts on `blockingStatus`, never on `lastCommand`.**

Probe (REPO): a session expires while the TV is `OFFLINE`, giving `blockingStatus` `FAILED` and `lastCommand` "DEVICE_OFFLINE: Cannot enter expired mode". After `SET_CONNECTION ONLINE` plus a tick, `blockingStatus` is still `FAILED`, but `deviceState.displayedMode` is `PLAYING` on HDMI1 and `lastCommand` now reads "SUCCESS: Simulated TV connected". The card's success-looking command line hides the failure, and nothing re-applies the expired screen (reconnect reconciliation is Phase 3).

| `blockingStatus` | Card | Attention strip |
|---|---|---|
| `FAILED` | Persistent red banner "Expired screen NOT shown - TV did not confirm" with a "Retry expired screen" button (LOCK with a fresh key) | Yes, top severity |
| `UNVERIFIED` | Amber "Expired screen sent - this TV cannot confirm it" | Yes |
| `CONFIRMED` | "Expired screen shown (software only)"; on simulated stations "(simulated)" | No |
| `PENDING` | "Showing expired screen..." | No |

Wording rules:

- Never "Locked", "secure" or "tamper-proof", including in `CONFIRMED` states. Mock `CONFIRMED` results are simulation proof only.
- Tier-specific strings for real devices are in [display-locking.md](display-locking.md#62-exact-wording-per-tier).

**Simulated TV preview shows the desired mode, not the TV.** `TvPreview` picks its screen from `station.mode` (the server's desired mode). In the probe scenario it renders "TIME EXPIRED" while the mock's `deviceState.displayedMode` is `PLAYING` on HDMI1: a false success. Render the preview from `deviceState.displayedMode` and `deviceState.input`; when they differ from `station.mode` and the TV is `ONLINE`, overlay a red "Mismatch: TV shows PLAYING, expected EXPIRED". Keep the "SIMULATED TV" tag.

## 7. Offline and stale-data presentation

**Offline TV:**

- Grey screen, an "OFFLINE" badge with an icon (not colour alone).
- When the session is `ACTIVE`: amber note "TV offline - timer continues on server; expiry screen cannot be shown until it reconnects". Add the station to the attention strip.
- Commands stay allowed (the per-station queue isolates them), but their toasts follow the outcome rules in section 4.
- Precedent: SENET disconnection alerts, LG ConnectedCare connection status, MagicINFO device health.
- "Offline since HH:MM" needs a server-side timestamp and a migration (section 9).

**Stale live data (timers freeze silently when the socket drops):**

- The client handles only `snapshot` and `connect_error`; there is no `disconnect` handler (REPO). The server emits a snapshot on connect and on each 1 s tick.
- Record `lastSnapshotAt = Date.now()` on receipt. Use local receipt time, not `serverTime`, because the simulation clock can be accelerated.
- Every second, if `!socket.connected` or `Date.now() - lastSnapshotAt > 3000`, show a persistent banner "Live updates lost - reconnecting (attempt n). Times shown are from 14:02:11", and grey out every timer with a "STALE" tag. Clear on the next snapshot.
- Use the Manager `reconnect_attempt` event for n. If the disconnect reason is `io server disconnect`, which does not auto-reconnect, call `socket.connect()` ([Socket.IO client API](https://socket.io/docs/v4/client-api/)).

**Attention strip and summary:**

- A "Needs attention" summary tile beside Playing / Idle / Expired / Offline. Count = `FAILED` + `UNVERIFIED` + offline stations with an `ACTIVE` session + `ACTIVE` sessions with `remainingMs <= 300_000`.
- Above the grid, list those stations by severity: `FAILED`, offline with a session, `UNVERIFIED`, ending soon. Each entry links to and focuses the card.
- Keep the grid in station-number order by default so cards match physical seats and do not move under the cursor every second (a design judgement; HandyCafe sorts by least time left). An optional "Sort by time left" toggle covers that preference.

## 8. Accessibility

1. `:focus-visible { outline: 3px solid <high-contrast colour>; outline-offset: 3px }` on every interactive element, one consistent scheme ([WCAG 2.4.7 Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html); APG: "The visual focus indicator must always be visible" ([keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)); Android TV: "Use a uniform scheme for indicating focus" ([TV navigation](https://developer.android.com/training/tv/get-started/navigation))). At the time of research `apps/web/src/styles.css` had no `:focus` or `:focus-visible` rules, and the station card wrapper was a `<div onClick>` that cannot be focused (REPO).
2. Station grid as a roving-tabindex composite: arrow keys move between cards in row-major order using the computed column count; Home/End jump to the first/last station; Enter or Space opens the card's actions; Escape closes a dialog or clears the selection.
3. `scroll-padding-bottom` equal to any sticky bar height, and toasts kept out of the grid's path ([WCAG 2.4.11 Focus Not Obscured (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)).
4. No single-key global shortcuts for disruptive actions (APG: shortcuts enhance, not replace); the back key is never gated by a confirmation (Android TV guidance).
5. Contrast for badges and text meets WCAG AA; targets at least 24 x 24 CSS px (2.5.8).
6. **UNVERIFIED:** whether TV-browser D-pads map to arrow keys. Test with real arrow and Tab keys and do not report the result as D-pad proof.

## 9. Later work (outside the current Next task)

- **Multi-select:** a native checkbox per card ("Select PS5-03"), a select-all with checked/unchecked/indeterminate states, and a sticky "N selected" bar with Cancel; per-card buttons disabled in batch mode ([Carbon data table](https://carbondesignsystem.com/components/data-table/usage/)). Batch actions appear only when valid for at least one selected station; the confirmation lists skipped stations ("PS5-04 skipped: no session"). Disruptive batches use the alertdialog rules in section 3, e.g. "End sessions on PS5-02, PS5-05, PS5-09? 1:12:00 of remaining time will be discarded." [Keep playing] [End 3 sessions]. Non-disruptive batches ("Add 30m to 4 stations") need no dialog. Send N parallel POSTs with keys **`${clickKey}:${stationId}`** (36 + 1 + 6 = 43 characters, inside the server pattern), so a retried batch replays per station; summarise with `Promise.allSettled` ("3 of 4 done - PS5-07: DEVICE_OFFLINE"). No bulk endpoint is needed: the 50-station benchmark already shows a 50-request START storm finishing in 25-29 ms with per-station isolation (CURRENT_STATUS.md).
- **Hash routes for the five nav areas:** the nav items are buttons with no behaviour, and the server serves no web build yet (production hosting is Phase 5), so hash routes avoid an SPA fallback: `#/dashboard`, `#/remote/:stationId`, `#/media`, `#/devices`, `#/settings` ([HashRouter](https://reactrouter.com/api/declarative-routers/HashRouter); Vite's `spa` appType covers dev/preview only, [Vite](https://vite.dev/config/shared-options#apptype)). Nav entries as `<a href>` with `aria-current="page"` ([MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-current)). Move the virtual remote to `#/remote/:stationId`; move Disconnect/Reconnect, fast-forward and `SIMULATE_*` controls into a clearly labelled "Simulation" section in Device or System Settings; give Media Manager an honest "Not available in this phase" state. Phase 5 may switch to history routes, which would change URLs.
- **Configurable warning thresholds** in System Settings (a persisted setting and migration; iCafeCloud allows several intervals).
- **"Offline since HH:MM"** or last-seen time (server-side connection-changed timestamp, new migration; MagicINFO Connection History precedent).
- **Sound alert** for a `FAILED` expiry: Chrome creates an `AudioContext` suspended until a user gesture, so it needs an "Enable alert sound" click per page load ([Chrome autoplay](https://developer.chrome.com/blog/autoplay)).
- **Move a session** to another station (iCafeCloud Move Session); needs a new server action.
- **Post-END grace period** before switching to advertising (HandyCafe), for customers who pay and immediately extend.
- **Staff roles** (Timeout Mobile precedent); in Phase 2 but excluded from the current Next task.

## 10. Excluded features

Seen in the researched products and **not** to be copied ([AGENTS.md](../../AGENTS.md)):

- Billing and payment (HandyCafe's Stop opens a payment dialog, [sessions](https://handycafe.com/en/docs/sessions)).
- Member and guest logins (ggLeap "Add User" / "Add Guest", [KB](https://ggcircuit.atlassian.net/wiki/spaces/GKB/pages/15863567/PC+list+-+Consoles+View)).
- CRM, win-back campaigns and analytics (Timeout Mobile, [App Store](https://apps.apple.com/us/app/timeout-mobile/id6759071539)).
- Customer self-service QR start (SENET, [controllers](https://senet.cloud/controllers)).
- PS5 wake/rest control (HandyCafe pairs with the PS5, [blog](https://handycafe.com/en/blog/manage-playstation-consoles-from-your-computer)); PS5 control is forbidden.
- Smart-plug power cutting (iCafeCloud's Sonoff integration, [page](https://icafecloud.com/wiki-add-consoles-with-sonoff.htm)).
- HDMI-inline controller hardware (SENET); that is the future Level 4 hardware route only.
- On-TV customer warnings (SENET, PlayStation): these need a real adapter or companion overlay (Phase 3/4) and must not be faked as delivered on real TVs.

## 11. Open product question: PAUSE leaves the TV on HDMI

`PAUSE` sends no adapter command (REPO, `execute()`), so the TV stays on the PS5 input and a paused customer can keep playing while the timer is frozen. The user should choose one:

1. **Accept it:** PAUSE is a staff-side timer hold; staff tell the customer, and the dashboard labels it "Timer held - TV still on PS5".
2. **Show a paused screen on PAUSE:** needs an adapter command, verification, and probably a new display mode; subject to the same bypass limits as the expired screen.
3. **Rename it** to "Hold timer" so nobody assumes play stops.

Until decided, the UI should not imply that pausing stops play.

## 12. Sources (accessed 2026-10-25)

Standards and platform docs (OFFICIAL):

- WCAG 2.2 Understanding: https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html, https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html, https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html, https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html, https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html, https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- WAI-ARIA APG: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/, https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/, https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/
- MDN: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog, https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-disabled, https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/timer_role, https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-current, https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static
- React useTransition: https://react.dev/reference/react/useTransition
- Socket.IO client API: https://socket.io/docs/v4/client-api/
- React Router HashRouter: https://reactrouter.com/api/declarative-routers/HashRouter
- Vite appType: https://vite.dev/config/shared-options#apptype
- Chrome autoplay policy: https://developer.chrome.com/blog/autoplay
- Android TV navigation: https://developer.android.com/training/tv/get-started/navigation
- GOV.UK text input: https://design-system.service.gov.uk/components/text-input/
- Carbon notifications and data table: https://carbondesignsystem.com/components/notification/usage/, https://carbondesignsystem.com/components/data-table/usage/
- NN/g confirmation dialogs: https://www.nngroup.com/articles/confirmation-dialog/

Vendor pages (OFFICIAL for the vendor's own product; precedent only):

- iCafeCloud: https://www.icafecloud.com/wiki-notification-before-console-end.htm, https://www.icafecloud.com/wiki-how-auto-checkout-works.htm, https://icafecloud.com/wiki-move-session.htm, https://icafecloud.com/wiki-add-consoles-with-sonoff.htm
- HandyCafe: https://handycafe.com/en/docs/consoles, https://handycafe.com/en/docs/sessions, https://handycafe.com/en/docs/console-power, https://handycafe.com/en/blog/manage-playstation-consoles-from-your-computer
- ggCircuit KB: https://ggcircuit.atlassian.net/wiki/spaces/GKB/pages/15863567/PC+list+-+Consoles+View
- SENET: https://senet.cloud/controllers
- Timeout Mobile: https://apps.apple.com/us/app/timeout-mobile/id6759071539
- Samsung HQ60A (LYNK Cloud): https://image-us.samsung.com/SamsungUS/samsungbusiness/tvs/hospitality/luxury/hq60a-series-43/HTV_HQ60A_SERIES.pdf
- LG ConnectedCare: https://www.lg.com/sg/business/information-display/software-solutions/lg-business-cloud/lg-connectedcare/
- Samsung VXT / MagicINFO: https://docs.samsungvx.com:443/docs/x/BwHVAg
- PlayStation play time controls: https://www.playstation.com/en-us/support/account/play-time-controls-playstation/

## 13. Physical verification checklist

The dashboard rules are verified in a browser, not on TVs. Keep the three kinds of proof separate, as AGENTS.md requires: automated simulation proof (`npm run verify`), browser-rendered proof (this table), and physical-hardware proof (the matrices in [android-tv.md](android-tv.md#14-physical-verification-checklist), [samsung-tizen.md](samsung-tizen.md#14-physical-verification-checklist) and [display-locking.md](display-locking.md#10-physical-verification-checklist)). Nothing below has been run for this document.

| Field | Required evidence |
|---|---|
| Environment | Browser and version, OS, device, viewport and device-scale factor; server and Vite ports used (not 3000/5173 if occupied); throwaway database path |
| Desktop layout | 1440 x 900 or similar: no horizontal overflow; presets, custom dialog and set-remaining dialog render; screenshots inspected |
| Mobile layout | 390 x 844: no horizontal overflow (`scrollWidth == 390`); preset grid targets >= 24 x 24 CSS px; dialogs fit and scroll; screenshots inspected |
| Real phone | Touch on an actual phone over the LAN (plain http): idempotency key generated without `crypto.randomUUID`; double-tap adds time once |
| Idempotency | Network log shows one key per click; a forced timeout and Retry reuse the same key and get `idempotent-replayed: true` |
| Pending state | Button shows pending text and `aria-disabled` until the response; focus stays on the button |
| Durations | Each preset gives the expected `deadlineAt`; custom bounds (0, > 24 h, non-digits) rejected inline and by the server; end-time preview shows the simulated-clock note when accelerated |
| Set remaining | Increase without confirmation; reduce with the specific confirmation; paused session stays paused; rejected on idle/ended/expired stations |
| Warnings | 10/5/1-minute badges appear with text and icon, no blinking; exactly one status announcement per crossing, re-armed after adding time |
| Failure alerts | Offline-at-expiry scenario shows the red `FAILED` banner after reconnect even though `lastCommand` says SUCCESS; preview shows the mismatch |
| Stale data | Stopping the server shows the stale banner within ~3 s and greys timers; restarting clears it |
| Keyboard | Tab and arrow-key navigation through the grid, dialogs and nav; visible focus ring everywhere; Esc closes dialogs; focus returns to the opener |
| Screen reader | Timers not announced every second; threshold and toast announcements read once (VoiceOver or NVDA, recorded by name and version) |
| TV browser D-pad | Recorded separately and marked UNVERIFIED until tested on a named TV browser; never inferred from keyboard results |
| Wording | No screen says "Locked", "secure" or "tamper-proof"; simulated `CONFIRMED` is labelled simulated |

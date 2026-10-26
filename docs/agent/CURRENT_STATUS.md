# Current Status

Updated: 2026-10-26 (Asia/Kuala_Lumpur)

## Delivered so far

### Visual GitHub README (2026-10-26)

- Rebuilt `README.md` as a visual project page with badges, compact capability tables, GitHub callouts, a Mermaid system
  flow, quick-start/live-mode guides, privacy and safety boundaries, and the exact model-by-model TV support matrix.
- Added `docs/assets/readme-hero.svg`, a repository-native 1440×640 dashboard illustration showing playing, reserved, idle,
  expired, offline and paused stations. Rendered it through headless Chrome and visually inspected the result at full size.
- Kept physical proof separate from software proof: Hisense WE3FE / 75WE3FE remains partly supported; Prism and all other
  untested models remain explicitly unverified; remote delivery remains `UNVERIFIED`; the PC-on-HDMI test is not called a
  PS5 test or a tamper-proof lock.
- Check: `npm run verify` passed (server 217/217, dashboard 93/93, strict typechecks and production builds).
- Concrete next task remains the physical Prism/Hisense matrix in `docs/TV_TEST_PLAN.md`.

### README TV-support matrix (2026-10-26)

- Replaced the outdated blanket statement that no physical TV had been tested with a model-by-model support matrix in
  `README.md`. It names the Hisense WE3FE / 75WE3FE as the only partly supported, physically tested model; keeps Prism,
  other Android/Google TV devices, browser-only TVs, Samsung Tizen and VIDAA explicitly unverified; and separates mock-TV
  simulation from physical proof.
- Documented the Hisense evidence and limits: PC-on-HDMI rather than PS5, companion app/media/QR/timer/TIF switching,
  opt-in ADB remote and backlight control, Android-only screenshots, `UNVERIFIED` command outcomes, bypass paths, and the
  remaining reboot/game-mode/performance/security test gaps.
- Updated the live-mode summary so it no longer says the server "never sends a TV a command": manufacturer adapters remain
  disabled, while an explicitly paired Android device can use the separate bounded ADB remote channel.
- Check: `npm run verify` passed before the documentation edit (server 217/217, dashboard 93/93, all typechecks and builds).
- Concrete next task remains the physical Prism/Hisense matrix in `docs/TV_TEST_PLAN.md`; do not enable another model until
  its exact manufacturer/model/OS/firmware and command results are recorded in `docs/HARDWARE_LIMITATIONS.md`.

### Earlier slices (Phase 1, complete)

- **Foundation:** TypeScript workspace, shared contracts, SQLite persistence, server-authoritative sessions, persisted simulation clock, command log, per-station queues, `MockTvAdapter` only, 10 auto-seeded simulated TVs, responsive dashboard.
- **Reliability gate:** fixed a station queue that wedged after one rejected action; typed 400/404 errors; strict request validation; required `Idempotency-Key` on mutating requests (24 h persisted replay, 422 on key reuse); versioned migrations via `PRAGMA user_version` (v2 adds `idempotency_keys`); graceful SIGINT/SIGTERM; mobile overflow fix.
- **50-station benchmark:** `apps/server/src/load.test.ts` (ordering under latency, hung-TV isolation, one-tick expiry, 20-client Socket.IO storms). It found and fixed O(n²) broadcasts (now coalesced to one per 50 ms) and duplicate expiry LOCKs.

### Research + enhancement slice (Phase 2 start), via a 10-agent workflow

Six read-only agents researched Android/Google TV control, Samsung Tizen control, display-locking options, gaming-lounge operator UX, a server code audit, and a dashboard UX/accessibility audit. One planner verified the audit claims against the code and split the work. Three agents implemented it in parallel with strictly disjoint file ownership (no git history existed, so no worktrees).

**Server (`apps/server/src`), 6 items:**
- **S1 auth bypass closed (was high severity):** the old hook checked `request.url.startsWith("/api/")`, so `/%61pi/...` and absolute-form targets skipped the token. It is now default-deny on `request.routeOptions.url` (only `/health` public). One constant-time SHA-256 `timingSafeEqual` check is shared by HTTP and Socket.IO. Empty or whitespace tokens are refused at startup. CORS grants no origin. 5xx bodies are generic.
- **S2 session guards:** START is rejected on ACTIVE/PAUSED (it used to silently reset time). SHOW_ADVERTISING is rejected during a session (it used to wipe the deadline and leave an ACTIVE session that never expired). SET_REMAINING is only for ACTIVE/PAUSED. Durations must be whole ms from 60 000 to 86 400 000. `CONNECTING` cannot be requested.
- **S3:** the expiry tick queues `expireIfStillDue`, which re-checks the deadline at the head of the station queue, so a queued +30m/END/PAUSE wins over a stale LOCK.
- **S4:** shutdown no longer hangs with dashboards connected. A `preClose` disconnects sockets, then station queues and in-flight idempotent requests drain for up to 2 s, with a 10 s process backstop in `index.ts`.
- **S5:** every adapter call and readback is bounded (`PS5_CAFE_COMMAND_TIMEOUT_MS`, default 5000, range 100-60000). A timeout records `TIMEOUT` ("TV state unknown") and the late answer is discarded. `execute()` rolls back in-memory state on any throw and commits the log row plus the station/session rows in one transaction.
- **S6 honest evidence:** only a verified SUCCESS is `CONFIRMED`, and UNSUPPORTED/FAILURE/TIMEOUT/DEVICE_OFFLINE are `FAILED` (UNSUPPORTED used to be UNVERIFIED). The mock now models the remote-button bypass: switching to HDMI on an expired TV shows the console, and the evidence drops to `FAILED`. `UnverifiedTvAdapter.disconnect` no longer claims a verified success.

**Dashboard (`apps/web/src`), 6 items:** split into `api.ts`, `useCommands.ts`, `logic.ts`, and `components/` (StationCard, DurationDialog, ConfirmDialog, Modal, ActionButton, RemotePanel, SimulationControls, Icons).
- **W1:** one idempotency key per operator intent; a pending state (`aria-busy`, "Starting…"); double-clicks ignored; persistent per-station errors; retries reuse the key.
- **W2:** actions gated by session status. Presets 15m/30m/1h/2h/3h, a custom-duration dialog, "Set remaining…", and confirmations for disruptive actions (Lock renamed "Expire now"; starting on an offline TV asks first).
- **W3:** accessibility: `:focus-visible` rings, `<article aria-labelledby>` cards (no clickable div), labelled buttons, modal focus trap, contrast fixes.
- **W4:** 10/5/1-minute expiry warnings, each announced once via `role=status`; failed/unverified expired-screen alerts; the expired screen is labelled "software only".
- **W5:** "Live updates lost — reconnecting" banner and STALE timers after 3 s without a snapshot.
- **W6:** responsive `minmax(0,…)` fixes; simulation controls in their own section; Media Manager, Device Settings and System Settings marked "Soon" (all five areas kept).

**Docs:** `docs/research/` holds README, android-tv, samsung-tizen, display-locking and operator-ux, each with sources, evidence levels and a physical verification checklist. Four new rows were added to the `docs/HARDWARE_LIMITATIONS.md` test record: CEC wake, customer phone pairing, mains power cycle, firmware change.

**Orchestrator changes:** the root `npm test` now runs every workspace (`--workspaces --if-present`), so the dashboard tests are part of `npm run verify`. Also updated `.env.example`, README, ARCHITECTURE and IMPLEMENTATION_PLAN.

### Navigation slice (user request: "UI need more easy to navigate")

The problem, measured before the change: the phone page was 6957 px tall with 102 buttons. Each idle TV was a ~540 px card repeating 8 buttons, the remote and simulation controls sat below all 10 TVs, the menu scrolled away, and "TV Remote" was only an anchor while three nav items were dead.

- **Real pages for all five areas** via hash routes (`apps/web/src/navigation.ts`): `#/` Stations, `#/station/<id>` station panel, `#/remote/<id>`, `#/media`, `#/devices`, `#/settings`. Links, page titles and the browser/phone back button all work. Unknown or malformed hashes fall back to the dashboard.
- **Phones:** a fixed five-tab bottom bar (Stations, Remote, Media, Devices, System). Full names stay available to screen readers, and the header is compact.
- **Dashboard:** compact `StationTile`s show the name (it opens details), connection, timer, a plain status pill, the single most urgent chip (command error, failed/unverified expired screen, offline-while-running, ending soon), and only the common actions: presets when idle; +30m/Pause/End when playing; Resume/+30m/End when paused; +30m/End when expired. Every tile action is a subset of `allowedActions`, which is tested, and the same confirmations apply.
- **Filters:** All, Playing, Paused, Idle, Expired, Offline, Needs attention, each with a count. They are sticky and swipeable on phones, with an empty state offering "Show all".
- **Station panel** (`StationPanel`, native modal dialog): every action, the TV preview, evidence and errors, plus that TV's remote. It is a 500 px right-hand drawer on desktop and full screen on phones, and it closes with Esc, Close, or Back.
- **TV Remote page:** a TV picker with live status, a time-left/session/what-the-TV-shows strip, and a remote laid out like a physical one (system row, D-pad cross with a round OK, volume row, HDMI 1-4).
- **Device Settings:** a read-only inventory (adapter, connection, what the TV shows, volume, capability ticks including "Tamper-resistant lock ✕", last command), with Details/Remote links and a note that real adapters stay disabled.
- **System Settings:** live-update state, server clock and offset, mode, station count, a development-token warning, and the simulation controls (moved here from the bottom of the dashboard). Quick "+5 min / +1 hour" simulation buttons remain on the Stations header.
- **Media Manager:** an honest "not built yet" page describing Phase 3.

Evidence (2026-10-25): `npm run verify` passed with server 138/138 and dashboard **70/70** (24 new navigation tests: routes, five-area order, filter counts equal `summaryCounts`, tile actions ⊆ `allowedActions`). Headless-Chrome check on an isolated server :3101 and Vite :5175 with a throwaway DB (the user's live session on :5173 was left untouched): **39/39 PASS** at 390 px and 1440 px. That covers no overflow, 10 tiles, five nav areas with the bottom bar pinned, a tile 15m start, gated tile actions, filters and the empty state, End confirming from a tile, the panel opening from the tile name (full screen on phones, right drawer on desktop) and closing with Back and Esc, every page reachable from the nav, the remote picker, Volume + reaching PS5-03, every API command carrying an idempotency key, and no page errors. Page height on phones went from 6957 px to 2138 px; on desktop all 10 TVs fit in one 900 px screen (it was 2200 px). Screenshots inspected.

### QR booking slice (owner decisions 2026-10-25: reserve-then-staff-start, Malaysian mobile number with consent, rotating QR on each idle TV, AGENTS.md rule amended)

- **Server** (`apps/server/src/booking.ts`, `ratelimit.ts`, routes in `app.ts`, migration 3): per-TV screen key + QR secret; `GET /api/screen/:id?k=` (TV heartbeat + rotating HMAC code, 2-minute windows); public `GET /api/public/stations/:id/booking?c=`, `POST …/reservations`, `GET /api/public/reservations/:id?t=`, `POST …/cancel`; staff `GET /api/screens`, `POST /api/stations/:id/reservation/release`; START on a held TV marks it STARTED; 1 s tick expires holds (default 10 min, `PS5_CAFE_RESERVATION_HOLD_MINUTES`) and completes finished sessions. One open reservation per TV (service + partial unique index). Per-IP rate limits (trustProxy loopback only), 2 KB public body limit, generic 4xx texts, the full phone number never in a public response.
- **Privacy** (`docs/PRIVACY.md`): the number is nulled in the same statement that closes a reservation (release/cancel/expire/complete) plus a 24 h safety net; stored idempotent responses blank `phone`; `secure_delete = ON`; WAL checkpoint-truncate on close. **A real leak was found and fixed while testing:** the stored START response kept the number for 24 h in `idempotency_keys`.
- **Web**: `#/screen/<id>?k=` TV page (ad panel + QR card / Reserved / In session / TIME EXPIRED, QR hidden while reconnecting); `#/book/<id>?c=` phone page (durations, mobile, consent, booking ref + hold countdown, live status, cancel); staff: Reserved filter, "New QR reservations" strip with Start/Release, reserved tile chip + actions, reservation box with tap-to-call in the panel, announcements; Device Settings → TV screens with every TV's link, Open, Copy, ADB command and online state. The staff token is no longer compiled in: entered once per device (sign-in screen); dev builds still default to the dev token.
- QR images are drawn from the module grid as one SVG path (`qrcode-generator` 2.0.4, MIT, no dependencies) — no injected markup.

Evidence (2026-10-25): `npm run verify` — server **178/178** (40 new in `booking.test.ts`), dashboard **80/80** (10 new), builds green. Mutation checks (fresh helper, byte-identical restores): removing storage redaction, phone erasure on close, the consent check, the screen-key check, the code check on submit, or the WAL flush each fails a test; `secure_delete` alone is defence-in-depth not separately observable in that test. Production bundle: the only token-like string is the `=== "local-dev-token"` warning comparison; no fallback token is embedded. End-to-end headless Chrome on an isolated server :3101/Vite :5175 with a throwaway DB: **19/19 PASS** — 10 screen links on the LAN address, ADB commands, TV shows its QR and the drawn QR provably encodes that TV's booking URL, TV and phone pages never send the staff token, consent enforced, phone reserves 2h and gets a ref + 10:00 countdown, TV switches to Reserved showing only the last 4 digits, staff strip/tile/filter show it, Start 2h runs 02:00:00, the phone shows "Your session has started", the TV shows In session, a second phone is refused ("in use"), no page errors. The live dev database migrated to v3 with 10 screen rows.

### Visual redesign slice (user request: "looks AI-made, want a clean Apple-like look")

- Restyled to Apple Human Interface Guidelines conventions (style only, no Apple branding, logos or font files): platform system font stack (SF on Apple devices), 34 px bold large titles with tight tracking, sentence-case labels (all CAPS/letter-spaced "eyebrows" removed from the markup), neutral grouped backgrounds with white cards and soft shadows instead of borders, gray "tinted" buttons with one filled primary action, an iOS segmented control for filters and booking durations, Settings-style label/value lists, translucent sidebar and phone tab bar, an Apple-TV-style circular click pad on the remote, "Done" to close the panel, and automatic light/dark mode via `prefers-color-scheme`. Filled buttons use #0071e3 (4.6:1 with white) instead of #007aff (4.0:1) for WCAG AA; 44 px minimum targets kept. The TV screen page stays dark and minimal.
- Bugs found and fixed while checking: the phone tab bar rendered at the top because the sidebar's `backdrop-filter` made it the containing block of the fixed nav (caught by the "tab bar pinned" browser check); `.screen-idle`/`.screen-expired` were shared by the simulated-TV preview and the TV screen page and leaked layout into each other (now scoped; this predated the redesign); the booking "How long?" legend sat inside the duration grid.
- Phone shows live **time left** once staff start a booked session (`PublicReservation.session`, tested).
- Evidence: `npm run verify` server 178/178, dashboard 80/80, builds; isolated headless-Chrome runs after the redesign: navigation suite **39/39**, QR booking journey **19/19**, 16 views (4 pages × light/dark × desktop/390 px) with no horizontal overflow and no page errors; screenshots inspected.

### TV companion APK slice (user request: Prism + Hisense TV test tomorrow over wireless ADB; "timer at top right during PS5")

Built by one background agent limited to `android/**` and `docs/TV_TEST_PLAN.md` (its transcript was checked: no writes elsewhere), then reviewed and adjusted by the orchestrator.

- **`android/tv-companion`** (Kotlin, no AndroidX/analytics/Play services; Gradle 8.14.3 wrapper with pinned SHA-256, AGP 8.13.0, Kotlin 2.2.20, JDK 17): `com.ps5cafe.tvcompanion` 0.1.0, minSdk 23, target 35, debug-signed (v1+v2). `MainActivity` is a full-screen WebView of the TV's screen link, same-origin only, retry with capped backoff + jitter, 30 s load timeout, watchdog and renderer-crash recovery, page unloaded when hidden. Configured by ADB intent extras, a D-pad setup screen, or holding BACK ~3 s (not a security boundary). `DiagnosticsActivity` reports device/WebView/display/IPs/TV inputs (keys redacted, logcat tag `PS5CafeDiag`) and has public-intent "Try switch" input buttons. `BootReceiver` is best effort.
- **Timer box (`TimerOverlayService`)**: polls `/api/screen/<id>?k=…&overlay=1` every 5 s and draws a top-right time-left box over other apps (`TYPE_APPLICATION_OVERLAY`, never focusable/touchable) while the session is ACTIVE/PAUSED; amber ≤10 min, red ≤1 min; hidden on 403/404 or after 30 s without a good poll. The server stays the timer authority (the box extrapolates from `serverTime`/`remainingMs`). Needs `adb shell appops set com.ps5cafe.tvcompanion SYSTEM_ALERT_WINDOW allow`. Diagnostics has "Test overlay (10 s)"; `--ei overlay_test <s>` for longer.
- **Orchestrator fixes from the agent's hand-off notes:** (1) overlay polls refreshed the TV's `screenSeenAt`, so Device Settings would call a screen "online" while the PS5 was showing; `/api/screen` now skips the heartbeat for `overlay=1` (`booking.ts`, `app.ts`, new test) and the APK sends it. (2) the dashboard's ADB setup command reached the TV's shell unquoted; it is now `adb shell "am start … --es url '<URL>'"` with shell-special characters stripped (`reservations.ts`, test). (3) old TV WebViews could show a blank page when the code cannot parse; `index.html` now shows "The PS5 Cafe page could not start (<reason>). Browser: <user agent>" before the app mounts (also a `nomodule` path). `docs/TV_TEST_PLAN.md` and `docs/ARCHITECTURE.md` updated.
- **`docs/TV_TEST_PLAN.md`**: identify each TV (Android TV/Google TV vs VIDAA, browser-only path for VIDAA), pairing (legacy and Wireless debugging), `getprop`/`dumpsys` capture, install/configure, appops grant, Diagnostics and input switching, overlay tests (game mode/ALLM on and off, input changes, server lost, reboot, force-stop), recovery/bypass/security checks, a results table mirroring `docs/HARDWARE_LIMITATIONS.md`, and clean-up (ADB off afterwards).

Evidence (2026-10-25): `./gradlew clean assembleDebug testDebugUnitTest lint` BUILD SUCCESSFUL, **23/23** unit tests (config/URL validation, same-origin rule, backoff, status parsing, countdown rules, status URL incl. `overlay=1`), lint 0 errors / 1 warning (`OldTargetApi`, target fixed at 35). `dist/ps5-cafe-tv.apk` (git-ignored) 1,055,906 bytes, SHA-256 `5a591bf9ebe2f14079cf0a633df618b9a9448232763ace5d2b270fb1230759df`; `aapt2 dump badging` confirms the package, permissions (INTERNET, RECEIVE_BOOT_COMPLETED, SYSTEM_ALERT_WINDOW, FOREGROUND_SERVICE, FOREGROUND_SERVICE_SPECIAL_USE), launcher + leanback launcher activity; `overlay=1` present in the app dex. `npm run verify`: server **179/179**, dashboard **80/80**, builds. Isolated stack (:3101/:5175, throwaway DB): QR booking journey **19/19** with the new ADB command; startup-fallback check **4/4** (unparseable entry → message with SyntaxError and browser version; working page untouched; a later error does not wipe it); live overlay poll left `seenAt` null while a screen-page poll set it. **The APK has not run on any TV or emulator** (no device attached, no emulator installed): every Android behaviour above is unverified until tomorrow.

### TV thumbnail slice (2026-10-26, user request: "rather than the timer, show the thumbnail; if offline show offline")

- Dashboard tiles show a **thumbnail of what each TV shows** instead of the big `00:00:00`: Ads · QR code / Reserved / PS5 /
  Paused / Time expired ("No QR code until you end it", which explains why an expired TV cannot be booked) / Offline /
  Connecting. Status pill in its top-left corner; time left in the top-right while a session runs (amber ≤10 min, red ≤1 min,
  like the TV's timer box; `role=timer`); a bottom strip says whether the TV's screen page is open; mismatches stay red/amber.
  It is a drawing of reported state, never a capture of the TV picture. The detail panel uses the same component
  (`components/TvThumbnail.tsx`, `thumbnailFor`/`timeTone` in `logic.ts`), replacing the old preview.
- Server: `StationView.screenOnline` (screen page polled within 15 s), pushed to dashboards only on change (opened / went
  quiet via the 1 s reconcile), never per poll; overlay polls never count. Device Settings uses the same flag.
- Diagnosis of "opened the link on my phone, nothing happened for PS5-01": PS5-01 was EXPIRED (left from an earlier session),
  so its screen showed "Time expired" and no QR; End frees it. Confirmed from the server log and `/api/screen`.
- Evidence: `npm run verify` server 180/180, dashboard 86/86; isolated browser check **20/20** (all states, live push on
  open, back to not-open after 16 s, corner position/colours, panel, 390 px no overflow, no page errors); navigation 39/39,
  QR booking 19/19 re-run. A stale `tsx watch` from an earlier check had silently restarted an old server on :3101 (it showed
  a "fresh" DB with an old session); found, killed, and re-run on a truly fresh DB.

### Live mode slice — deployed on this Mac (2026-10-26, user request: "stop simulation, I want to deploy the real one")

- **`SIMULATION_MODE=false` now runs** (it used to throw). Stations are `screen-only` (new `AdapterKind`, `ScreenOnlyAdapter`):
  the server sends the TV nothing and makes no network calls; mode changes record `UNVERIFIED` ("switch the TV with its
  remote"), other commands `UNSUPPORTED`; simulation controls and time acceleration are refused; live time ignores any
  stored offset. Simulated and live stations never share a database (startup refuses a mix and leaves the file untouched);
  live mode defaults to `data/ps5-cafe-live.sqlite`. Live mode refuses the dev token and tokens under 16 characters.
- **Real signals only** (`booking.ts`): connection ONLINE while the TV's screen page or the companion app's timer overlay
  polled within 15 s; the screen page polls only while visible (`ScreenPage.tsx`, Page Visibility); the expired screen is
  CONFIRMED only while the screen page itself polls after expiry, PENDING for 20 s, then FAILED (red "NOT shown, go to the
  station"). Live thumbnails: "Switch to the PS5" (page still showing the session), "PS5 · TV on another input · app running",
  "Time expired · TV is on another input", "Offline · Screen link not open on this TV". Pages never invent input/volume for a
  screen-only TV ("Not reported" / "Not controlled"); sidebar, System Settings and Device Settings say Live.
- **One address:** in production the server serves the built web app itself (`/`, `/assets/:file`, public, plain names
  only, traversal/dotfiles 404, API still default-deny), so phones hit the per-IP rate limits with their own IP (through the
  Vite dev proxy every customer shared one bucket).
- **`npm run start:live`** (`scripts/start-live.sh`): first run writes `.env.live` (mode 600, git-ignored via `.env.*`) with a
  32-character staff token, builds, and runs `NODE_ENV=production SIMULATION_MODE=false` on `0.0.0.0:8080` under `caffeinate`.
- **Companion APK:** at expiry the box turns red "Time's up" instead of hiding; when a session expires or is ended, the app
  brings its screen page to the front once (allowed by the overlay grant; software only); the box hides while the app's own
  page is visible. `dist/ps5-cafe-tv.apk` 1,057,026 bytes, SHA-256 `b9a73d54053f8d38a80e585ede365fb46fecfc19f2cf27e05a6a1fb36e454ba8`,
  **25/25** unit tests, lint 0 errors / 1 known warning. Still never run on a TV.
- **Deployment (with the owner's explicit request):** simulation dev servers (:3100/:5173) stopped; live server running on
  this Mac at `http://192.168.100.65:8080` (detached, log `data/live.log`); 10 screen-only TVs, all OFFLINE until each opens
  its screen link; macOS firewall is off, so LAN devices can reach it. Stop it with `pkill -f "apps/server/dist/index.js"`;
  start again with `npm run start:live`. It does not survive a reboot (no launchd service was installed).
- Evidence: `npm run verify` server **191/191** (11 new in `live.test.ts`: seeding, UNVERIFIED commands, refused simulation
  controls, poll-derived connection and evidence incl. grace, DB-kind isolation, no live offset, token rule, static serving and
  traversal, HTTP live run), dashboard **91/91**; production build in live mode on an isolated port with a throwaway DB, headless
  Chrome **21/21** (staff sign-in required, Live labels, Offline → Online + screen open pushed live, Start → "Switch to the PS5",
  UNVERIFIED command, PS5 via overlay polls only, a real 1-minute expiry PENDING → FAILED after 20 s → CONFIRMED when the screen
  page returns, a phone books through the live server, no staff token from TV/phone pages, live banner, links on :8080-style
  port, no page errors). Deployed server smoke-checked from its LAN address: page 200, API 401 without the token, snapshot with it
  shows `simulationMode: false`, offset 0, 10 × screen-only/OFFLINE. No physical TV has connected yet.

### Live view slice (2026-10-26, user request: "press the thumbnail → go to the display, live, so we can see and control it")

- The tile's thumbnail is a link to the TV's panel (`#/station/<id>`, same as the name). The panel's top is now
  `components/LiveScreen.tsx`: the TV's own screen page in a 16:9 frame (it scales itself), labelled by `liveScreenLabel`:
  "● Live: this is on the TV now" only while the TV's screen page polls; otherwise "Not on the TV right now …" (on the PS5:
  "the game itself is never shown here"). The frame uses `&preview=1` (`ScreenPollSource` "preview" in `booking.ts`): no
  heartbeat, not "app alive". Controls below are the session actions (which change what the page shows). For screen-only TVs
  the remote section is a plain note (use the TV's own remote) instead of disabled keys.
- Evidence: `npm run verify` server **192/192**, dashboard **92/92**; isolated live production server + headless Chrome
  **13/13** (thumbnail is a link; panel opens with the frame on `…&preview=1`; frame shows the real QR page; label honest;
  no dead remote keys; 20 s of watching left the TV OFFLINE with no `screenSeenAt`; label flips to Live when the TV opens its
  page; Start 15m in the panel → frame and TV show "In session"; End → back to ads + QR; 390 px full-screen fit; no errors).
  The first run also proved the hidden-tab rule (a hidden dashboard's frame stops polling). Deployed: live server restarted
  idle (no sessions, bookings or TVs online) at 01:5x on :8080; served bundle contains the change.
- **2026-10-26 ~02:00: the live server was stopped at the owner's request ("close port")**: graceful shutdown logged, :8080
  closed and unreachable from the LAN. Its data (`data/ps5-cafe-live.sqlite`, TV links/keys, `.env.live`) is kept; start it
  again with `npm run start:live`.

### Physical test, TV 1 = PS5-01 (2026-10-26 morning, in progress, owner at the TV)

- **Device:** Hisense **WE3FE** "VisionBoard" (an interactive touch panel built by CVTE, not a Google TV): Android **14**
  (API 34, patch 2025-06-01, build `UP1A.231005.007.A1/20250911`), MediaTek mt9679 / mt5896, `ro.build.characteristics=tv`
  but **no `android.software.leanback`**, touchscreen, 3840×2160 at density 480 (1280×720 CSS px), Google Play and Chrome
  installed, WebView `com.google.android.webview` **155.0.8059.43**. TV inputs via TIF: `com.mediatek.external/.HdmiInputService`
  HW2–HW5 (HDMI ports 1–4, cable status "unknown") and a composite input HW6. Raw captures kept outside the repo.
- **Wireless debugging:** paired with the owner's code (`adb pair` OK), auto-connected over mDNS (`_adb-tls-connect`, port 43499).
- **Verified on the device:** `adb install -r dist/ps5-cafe-tv.apk` → Success (SHA-256 `b9a73d54…4ba8`); `appops set … SYSTEM_ALERT_WINDOW
  allow` → allow; configured as PS5-01 by the ADB intent; MainActivity top-resumed; **the screen page loads and renders**
  (screenshot: ads panel + "Scan to book PS5-01" QR); the server shows PS5-01 **ONLINE, screen open**; the timer service polls OK.
  The panel's own UI (a "Broadcast" casting bar at the top and edge side-menu handles) stays on top of the page and is touchable.
- **Found:** the Mac's DHCP address changed overnight (192.168.100.65 → **.244**), so the first configuration failed with
  `ERR_ADDRESS_UNREACHABLE` ("Cannot reach the PS5 Cafe server", seen by the owner) until the TV was re-pointed at .244.
  The TV resolves `Craves-MacBook-Air.local` (mDNS) — an option for TV links; QR links must stay on the IP for phones.
  Owner action: reserve the Mac's address in the router.
- **Tested later that morning (ADB, owner present):** HDMI switching by the server is **not possible with documented
  routes** on this panel (passthrough intent unhandled; HDMI/INPUT key codes ignored); Sleep/Power key codes ignored. A real
  1-minute session with the TV on another screen (Home, standing in for HDMI): timer box shown top-right over it (red, ≤1 min);
  at expiry the app brought "Time expired" to the front by itself and the server marked the expired screen CONFIRMED;
  Add time 1 min → ACTIVE again, box back when switched away; End → app brought ads + QR back. Owner: pressing the panel's
  power button blanks the screen but Android stays awake, so the dashboard still shows it Online/screen open; power-on needs
  two presses. Full record: `docs/HARDWARE_LIMITATIONS.md` → Tested models.
- **Not yet tested:** timer box over a real HDMI/PS5 picture (with/without game mode), QR booking from a phone on this TV,
  reboot/boot launch, touch bypass, Prism TV. The TV then left the network (owner moved); it is still configured for the old
  address 192.168.100.244 and must be re-pointed once to the name-based link (below).

- **Afternoon (TV back on the network; the Mac was .244 again):** PS5-01 re-pointed to its name-based link
  (`http://craves-macbook-air.local:8080/…`) by ADB; the screen page loaded; the sample ads play on the panel (PNG/JPEG, and
  the H.264 video plays muted — checked through WebView remote debugging); its QR code sends phones to the current IP.
  Live server restarted with the TV idle: the app recovered on its own 2 s after the server returned (18 s outage).
  mDNS also showed two other Android devices with legacy ADB open on port 5555 (192.168.100.247 and .171); not touched,
  owner to identify them (one may be the Prism).

- **With the owner's PC on HDMI 1 (afternoon):** the Input key opens the panel's touch source menu; a tap on HDMI 1 switches
  (the HDMI picture is an Android activity, `com.cvte.tv.setting/.TifPlayerActivity`), so the app's box draws over it and the
  app can come in front of it. Verified: box over HDMI (red in the last minute), **expiry from HDMI brings "Time expired"
  back by itself** (server CONFIRMED), Add time, End → ads + QR. Details in `docs/HARDWARE_LIMITATIONS.md`.

### Screen on/off fix (2026-10-26, owner: "power off works but cannot power on")

- Cause (panel log): the Hisense maps Android sleep/wake to its backlight and stays interactive, so every POWER press is
  "go to sleep" — off only. `KEYCODE_WAKEUP` (224) turns it back on, `KEYCODE_SLEEP` (223) off. Added `WAKEUP`/`SLEEP` remote
  keys; live TVs show **Screen on / Screen off** instead of Power. Verified through the live server on the panel.
- Found while testing: the TV stopped announcing wireless debugging (mDNS) and was connected only by address, so commands to
  its service name failed ("not announcing"). The server now keeps each TV's last address (migration 5,
  `station_remotes.last_address`), finds a silent TV among address connections by its serial number (`adb-<ro.serialno>-…`,
  read with `getprop ro.serialno`), and Device Settings reports assigned TVs as reachable when they are. 217/217 server tests
  (new: silent TV found by serial number, address remembered), dashboard 93/93.

### Full remote slice (2026-10-26, owner: "I need full remote")

- The live remote is now a full remote: Power, Home, Back, Sources, D-pad + OK, Volume −/Mute/+, Menu, Settings, Play,
  Pause (Android key codes over the opt-in ADB channel), plus inputs **PS5 Cafe screen, HDMI 1-4**: `SWITCH_INPUT` (now also
  `APP`) on a remote-controlled live TV runs `am start … --es show_input HDMI<n>|APP`, and the companion app shows that input
  itself through TIF `TvView` (input found by label, else id order) or returns to its page. Recorded UNVERIFIED. The
  screenshot refreshes after every key or input.
- Verified on the Hisense WE3FE through the live server: Settings opened Android Settings, D-pad/Back moved inside it, Home →
  launcher, PS5 Cafe screen → page, HDMI 1 → PC picture ("picture available"), HDMI 2 → tuned (no source, no picture),
  HDMI 1 → PC again, PS5 Cafe screen → page. Power turns the screen off only (see the screen on/off fix above). Server 216/216, dashboard 93/93,
  app 27/27 unit tests; layout checked at 1440 px and 390 px.

### Automatic PS5 switching slice (2026-10-26, owner: "after pressing time it does not go to the other source")

- The companion app shows the PS5's HDMI input **inside itself** with Android's documented TV Input Framework (`TvView`,
  `TvContract.buildChannelUriForPassthroughInput`), so Start switches the TV to the game with no TV commands and no menu
  taps. Opt-in per TV: `adb shell "am start -n com.ps5cafe.tvcompanion/.MainActivity --es ps5_input auto"` (`auto` = the HDMI
  input with a connected source; or a TIF input id; `off` disables). `TimerOverlayService` asks for the PS5 when a session
  becomes ACTIVE (`SessionCountdown.ps5ShouldShow`) and for the page on expiry/end (as before); `MainActivity` applies the
  request in `onResume`, unloads the page while the PS5 shows (so the server never counts it as the screen page), keeps the
  timer box on top, releases the input when someone leaves the app, and falls back to the page if the input cannot connect.
  Software only: the panel's own Sources menu can still switch away.
- **Verified on the Hisense WE3FE with a PC on HDMI 1** (live server): app installed (`77a6ba0c…e5ea`, 26/26 unit tests,
  lint 1 known warning), `ps5_input=auto` saved; with a session already running the app switched to
  `com.mediatek.external/.HdmiInputService/HW2` and logged "picture available", timer box shown, server: ONLINE, screen page
  not showing; End → page with ads + QR; Start → PS5 picture within ~9 s; 1 minute left → at 0:00 "Time expired" brought back,
  server CONFIRMED; End → idle. Owner to confirm by eye that the picture and the box are visible (HDMI is not capturable).
- Also fixed (owner: "the UI has a bug"): in the station panel the 7 remote keys were squeezed into one row with labels broken
  mid-word, and the TV Remote page put the explanation in a narrow column; the live remote now stacks and its keys wrap.

### Remote control slice (2026-10-26, owner: "I want to remote and see the screen")

- **Opt-in remote control of live TVs over ADB wireless debugging, documented tools only** (`adb.ts`, `remote.ts`, migration 4
  `station_remotes`): `input keyevent` (Android KeyEvent codes), `input tap` (fractions → the TV's pixels via `wm size`),
  `exec-out screencap -p`, `pair`, `connect`. `execFile` with argument lists (no shell), validated device names/addresses/
  codes, bounded time. A TV is controlled only after staff assign a paired device to it (Device Settings → Remote control,
  with a pairing form); stored by the wireless-debugging **service name** and re-connected before each command (the link
  dropped once while idle; ports change). `ScreenOnlyAdapter` routes `REMOTE_KEY` and the new `REMOTE_TAP` action to it and
  records them **UNVERIFIED** (sent, effect not read back); without a device they stay UNSUPPORTED. Simulated TVs refuse it.
- **Screenshots on demand only** (`GET /api/stations/:id/screenshot`, staff, `no-store`, ≤1/s per TV, never stored or polled
  by the server). Dashboard `RemoteScreen` (station panel + TV Remote page): the latest screenshot (click it to touch the TV
  there), Home/Back/Sources/Volume/Mute, refreshes after each key or touch; says the PS5/HDMI picture shows black and is never
  captured. Found and fixed while testing: the route set `image/png` before the screenshot finished, so a failure became a
  500; a request with no remote set up used up the 1 s allowance; the panel gave up on a 429 instead of retrying.
- Evidence: `npm run verify` server **214/214** (12 remote tests with a fake adb: device listing, reconnect by service name,
  injection-proof names, pairing input checks, keys/taps in TV pixels, UNVERIFIED/UNSUPPORTED/FAILURE, screenshot + 1/s limit +
  502, assignment rules, restart), dashboard **93/93**. **Against the live server and the real panel: 9/9** (4K screenshot in
  the panel, verified keys only, Sources refreshes the picture, clicking HDMI 1 on the screenshot switched the panel to the PC,
  Sources → Android brought PS5-01's screen back, UNVERIFIED logged, Device Settings shows "Remote connected" + pairing form,
  phone TV Remote page fits, no errors).

### Ads + stable address slice (2026-10-26, owner: "put any video or image so show ads is working"; the Mac changed address twice)

- **Media Manager is real** (`media.ts`, routes in `app.ts`, `pages/MediaPage.tsx`, `components/AdPlayer.tsx`): staff upload
  JPEG/PNG/GIF/WebP images and MP4/WebM videos (raw body + `X-File-Name`, idempotent, ≤100 MB). The type comes from the file's
  own bytes (a renamed HTML/SVG is refused, 415); files get server-made safe names and are written atomically under
  `data/media/` (`PS5_CAFE_MEDIA_DIR`). Public `GET /media/:name` (safe names only, `nosniff`, byte ranges for video).
  `ScreenView.ads` carries the playlist; idle TV screens play it beside the QR code (images 8 s, videos muted to their end,
  looping; video paused while the page is hidden); deletes reach every TV within a poll. The "Soon" badge is gone.
  No per-TV playlists, scheduling or FFmpeg derivatives yet (Phase 3 remainder).
- **Stable address:** `/api/screens` returns `hostName` (`Craves-MacBook-Air.local`); Device Settings links and ADB commands
  use it (`tvLinkOrigin`), so DHCP changes no longer cut TVs off. QR codes use `ScreenView.bookingOrigin`, the server's current
  LAN address (phones cannot all resolve `.local`); a TV that loaded by IP keeps that IP (`network.ts`).
- Deployed: live server restarted idle on :8080 and three clearly labelled **sample** ads uploaded (two 1920×1080 slides and
  a 6 s 1280×720 H.264 video; no prices or offers invented). Owner can delete them in Media Manager.
- Evidence: `npm run verify` server **203/203** (8 media tests: signatures, refusals, idempotent replay, 413, serving + ranges +
  traversal, playlist order + delete; 3 network tests), dashboard **93/93**; isolated live server + headless Chrome **12/12**
  (upload through the page's file input, TV shows image 1 beside its QR, image 2 after 8 s, the video playing muted at 1280 px,
  loop back, live view plays ads, delete reaches the TV, disguised file refused with a clear message, phone fits, no errors);
  host-name check: TV links `http://craves-macbook-air.local:…`, QR origin = current IP for name/localhost hosts, kept for IP hosts.

## Verification evidence (research + enhancement slice)

- `npm run verify` passed on 2026-10-25, run by the orchestrator after all agents finished: all typechecks, **server 138/138 tests in 6 files** (was 47), **dashboard 46/46 in 2 files**, both builds (Vite: 56 modules). The original 47 tests pass with unchanged assertions.
- **Independent auth probe** (orchestrator, `app.inject`): `/api/snapshot`, `/%61pi/snapshot`, `/API/snapshot`, `/api//snapshot`, `/./api/snapshot`, `http://evil/api/snapshot`, `/api/%73napshot`, unknown routes, an unauthenticated `POST /%61pi/.../actions`, and a wrong short token all return 401, and the station stayed `IDLE/NONE`. `/health` and the correct token return 200.
- The server agent ran 12 mutation checks (all caught, files restored byte-identical by SHA-256) and the suite passed 4 consecutive runs.
- **Browser proof, orchestrator** (headless Chrome 155 via CDP, live source on :3100 with a throwaway DB, Vite :5174): no horizontal overflow at 390 px or 1440 px, 10 cards, all five nav labels, simulation labelled. Clicking **15m** sent START 900000 with a fresh key, and the card went to `PLAYING/ACTIVE/00:15:00` with presets replaced by Pause / +30m / Set remaining / End / Expire now. After a 15 m advance the card showed `EXPIRED`, expired screen "Shown", "(simulated · software only)". Screenshots inspected.
- **Browser proof, dashboard agent:** 44/44 flow checks at 1440 px and at 390 px, 32/32 warning checks per width, 8/8 reconnect checks per width (a real SIGTERM), 38/38 keyboard/ARIA checks (Tab reaches all 101 controls). This was run against `apps/server/dist` built at 21:27.
- Simulation and browser proof only. No physical TV was contacted; keyboard proof is not TV D-pad proof.

## Known gaps

- Real TV adapters remain disabled and physically unverified. Research says no consumer TV can prove from the network what it is showing. A tamper-resistant lock needs an IP-controlled HDMI switch with routing readback, or commercial/hospitality displays (`docs/research/display-locking.md`).
- The bearer token is prototype security: no staff login or roles, staff routes have no rate limits (only the public QR routes do), and idempotency keys are not scoped per user.
- Live mode has no TV control: inputs are switched with the TV remote; the expired screen depends on the companion app
  bringing its page forward (unverified) and is software only. It runs as a detached process on this Mac with no restart on
  reboot, and the Mac's DHCP address (192.168.100.65) may change, which would break every TV link and QR code (reserve it in the router).
- Remote control relies on ADB wireless debugging: anyone who can pair (it needs the code shown on the TV) gets full control
  of that TV, and the TV turns Wireless debugging off on reboot. Two other devices on the café LAN advertise legacy ADB on
  port 5555 (192.168.100.247, .171), owner to identify. Automatic PS5 switching (`ps5_input`) is verified only on the
  Hisense WE3FE; other models must pass the same test before it is turned on for them.
- The companion APK is a debug build that has never run on a TV. Whether overlays show over HDMI or in game mode, whether input switching works, and whether launch-after-boot works are all unknown per model. The web app targets recent browsers (Vite 8 defaults), so an old built-in WebView may refuse it; the page now says so instead of staying blank.
- Timeouts discard late mock answers, but a real adapter will need an `AbortSignal` to cancel the network call (Phase 4).
- The idempotency read ignores the 24 h retention until the next write prunes it, so storage is bounded only by write traffic.
- Multi-select actions, staff auth, and per-capability simulation controls are not done. Media Manager is a placeholder page.
- The CDP browser-check scripts live outside the repo, and browser checks are not part of `npm run verify`.
- The repository has no commits; nothing in these slices was committed.
- **Process note:** run only one coding agent per working tree. The first workflow attempt was interrupted when a session ended, and it left an orphaned audit server, a `vite preview` on :5199 and a headless Chrome running. These were found and stopped on 2026-10-25.

## Decisions needed from the user

1. **PAUSE behaviour:** pausing leaves the TV on HDMI, so a paused customer can keep playing. Should PAUSE switch to the advertising screen?
2. Whether to accept reverse-engineered protocols (Android TV Remote v2; Samsung's WebSocket remote). AGENTS.md currently forbids undocumented commands.
3. Hardware: buy MDC-capable commercial displays and/or IP-controllable HDMI switches, and isolate TVs on a staff-only network.
4. Approve a first git commit, so later parallel agents can use isolated worktrees and there is a rollback point.

## Next task

PS5-01 (Hisense) now runs on the name-based link with ads. Continue the physical test on the Prism and Hisense TVs against the **live server** (`http://Craves-MacBook-Air.local:8080`, links from Device Settings), then record it: follow `docs/TV_TEST_PLAN.md` on each TV (including step 10: Time's up box and the screen page coming back at expiry/end), starting with its OS (Android TV/Google TV vs VIDAA). Copy the filled results tables into `docs/HARDWARE_LIMITATIONS.md` by manufacturer, model, OS/firmware, WebView version, command and result, and note here which behaviours worked (screen page, timer box over HDMI with game mode on/off, input switching, boot launch). Fix only what the test shows is broken in the APK or screen page; do not enable a real TV adapter in this slice. If the TVs are not available, the next coding task is Phase 2 multi-station actions (multi-select with batch Start/+30m/End/Expire now, one confirmation listing each station, per-station idempotency keys and results).

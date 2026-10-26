# PS5 Cafe TV Manager

LAN-first TV and session management for a PS5 gaming centre. The server owns session time and state, persists them in SQLite, serializes commands per station, pushes real-time updates, and serves a responsive staff dashboard plus per-TV advertising and QR-booking screens.

> One exact display model—the Hisense WE3FE / 75WE3FE interactive Android panel—has partial physical verification. Other Android/Google TV models, Prism TVs, Samsung Tizen, VIDAA, and HDMI-control hardware are not verified. Software input switching is not tamper-proof access control.

## Quick start

Requirements: Node.js 24 or newer and npm 11 or newer.

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. In development, the server and web app use `local-dev-token` when no token is configured. Set `PS5_CAFE_API_TOKEN` before allowing other LAN clients to connect.

Useful commands:

```bash
npm run verify          # typecheck, server + dashboard tests, production builds
npm run dev             # server :3000 and dashboard :5173
npm run start           # run the compiled server
npm run handoff:claude  # continue interactively in Claude Code
```

## What works now

- Ten simulated TVs are created automatically.
- Start, pause, resume, extend, end, advertise, and lock actions.
- Authoritative server deadlines persisted in SQLite.
- Restart restoration without resetting active or paused time.
- Deterministic simulation time acceleration.
- Offline, reconnect, next-command failure, and unsupported-capability simulation at the domain layer.
- Per-device promise queues prevent overlapping commands.
- Socket.IO state updates and responsive station grid.
- Virtual remote and HDMI buttons routed through the selected adapter.
- Explicit connection, session, mode, and blocking states.
- Strict request validation and an `Idempotency-Key` header required on every mutating API call, so client retries are never executed twice.
- Versioned SQLite migrations and graceful SIGINT/SIGTERM shutdown.

## TV support right now

There are three different levels of TV integration. Do not treat a browser page loading as proof that remote control, HDMI switching, or expiry enforcement works on that model.

| TV or platform | Current status | What works now | Important limits |
|---|---|---|---|
| **Hisense WE3FE / 75WE3FE VisionBoard** (Android 14, CVTE interactive panel) | **Partly supported and physically tested** | Companion app installation; ads and rotating booking QR; server heartbeat; timer box over another Android activity; automatic switch to the connected HDMI input through Android TV Input Framework; return to the expiry/idle page; opt-in ADB remote keys, touch, Android-layer screenshots, and separate screen-on/screen-off commands | Tested with a PC on HDMI 1, not a PS5. HDMI video is not visible in screenshots. Touch/system UI can bypass the app. Wireless debugging is required for remote control and may turn off after reboot. Backlight state cannot be read, so a dark panel may still report Online. No tamper-proof lock. |
| **Any other Android TV / Google TV / Android panel** | **Not yet supported as a verified model** | The screen page and companion APK are available for testing | Compatibility depends on the exact manufacturer, model, Android/firmware version, WebView, overlay policy, TV Input Framework, and ADB behavior. Keep automatic HDMI switching and remote assignment off until that exact model passes `docs/TV_TEST_PLAN.md`. |
| **TV with a modern browser only** | **Screen-only candidate; unverified per model** | May display ads, QR booking, session, and expiry pages | No automatic input switching, remote control, power control, or verified screen state. Staff/customer must use the physical remote. Old browsers may not run the web app. |
| **Prism TV** | **Not tested** | None claimed | Identify the exact model and OS first; do not assume it behaves like Android TV. |
| **Samsung Tizen / Hisense VIDAA / other vendor platforms** | **Not tested and no real adapter enabled** | None claimed beyond a possible browser page | No manufacturer control commands are enabled. |
| **Mock TVs in simulation mode** | **Supported for development and automated tests** | All session flows, remote/input controls, failures, offline states, and deterministic time acceleration | Simulation is software proof only and says nothing about a physical TV. |

The only model-specific physical record is in [`docs/HARDWARE_LIMITATIONS.md`](docs/HARDWARE_LIMITATIONS.md). Before calling another TV supported, record its manufacturer, exact model, OS/firmware, pairing and recovery behavior, every command result, HDMI behavior, media playback, and what the system can actually verify.

### Hisense WE3FE functions verified so far

- The companion app opens the café screen and plays tested PNG/JPEG advertising plus muted H.264 MP4 video.
- Starting a session can show the connected HDMI input inside the app; ending or expiring the session returns to the café page. The HDMI test source was a PC, not a PS5.
- The top-right timer box was exercised over the HDMI player path, and the expiry page returned at zero.
- With Wireless debugging explicitly paired, staff can send supported Android keys, tap the Android screenshot, open Settings/Sources, select the café screen or HDMI 1–4, and turn the panel backlight on or off.
- Remote actions remain `UNVERIFIED`: sending a command successfully is not proof of the final picture. On-demand screenshots show Android layers only; protected/hardware HDMI video appears black.
- The panel is not locked down: its touchscreen, source menu, physical controls, reboot behavior, and customer-accessible UI remain bypass paths. Reboot/boot-launch, PS5 game mode, long-run performance, and the full security/recovery matrix still need testing.

If port 3000 is taken, run the two halves separately:

```bash
PORT=3100 HOST=127.0.0.1 npm run dev -w @ps5-cafe/server
cd apps/web && VITE_API_TARGET=http://127.0.0.1:3100 npm run dev
```

## QR booking on real TVs and phones

Each TV shows its own screen page (ads + a QR code that changes every 2 minutes). A customer scans it, picks a time, enters
a Malaysian mobile number with consent, and the TV is **held** for 10 minutes. Staff see it on the dashboard and press
**Start** once paid, or **Release**. See `docs/PRIVACY.md` for how the number is handled.

## Run it for real in the café (live mode)

```bash
npm run start:live      # = bash scripts/start-live.sh
```

The first run creates `.env.live` (git-ignored, owner-only) with a new staff password (`PS5_CAFE_API_TOKEN`), builds
everything, and serves the dashboard, TV screens and booking pages from one address, `http://<this-Mac's-LAN-IP>:8080`,
with `caffeinate` keeping the Mac awake. Live mode (`SIMULATION_MODE=false`):

- TVs default to **screen-only**: each shows its screen page in a TV browser or the companion app. Manufacturer control
  adapters remain disabled. An explicitly paired Android device may use the separate ADB remote channel; every action is
  bounded by a timeout and recorded as `UNVERIFIED`, not as confirmed screen state.
- What the dashboard knows comes from the TV's own polls: **Online** = its page or app checked in within 15 s; **Screen
  open** = the page is visible; an expired session counts as shown only once the screen page checks in while expired
  (otherwise "NOT shown" after 20 s). Software only: the customer can switch back with the remote.
- Time is real (no acceleration), the data lives in its own file (`data/ps5-cafe-live.sqlite`; the server refuses to open
  a simulation database in live mode or the reverse), and the staff password must be 16+ characters, never the dev token.

Add advertising images and videos in **Media Manager**; every idle TV plays them beside its QR code. TV links use this
Mac's `.local` name, so they survive DHCP address changes (QR codes give phones the current address).
Optional automatic switching: with `--es ps5_input auto` (see `docs/TV_TEST_PLAN.md`), a TV's app shows the PS5's HDMI
input itself when a session starts and returns to the screen page at expiry/end (verified on the Hisense WE3FE).
Optional remote control: pair a TV's Wireless debugging in **Device Settings → Remote control**, then its panel and the TV
Remote page show a screenshot you can click to touch the TV, plus Home/Back/Sources/Volume (the HDMI picture shows black).
Press a TV's thumbnail on the dashboard to open it: its screen page live (exactly what the TV shows while that page is
open; the PS5 picture is never captured) with every session control. Then: sign in once on each staff device with the password from `.env.live`, open **Device Settings → TV screens and QR
booking**, and open each TV's link on that TV (companion app: `docs/TV_TEST_PLAN.md`; or the TV's browser).

For development with simulated TVs, run the server and Vite separately instead:
`PORT=3100 HOST=127.0.0.1 npm run dev -w @ps5-cafe/server` and `cd apps/web && VITE_API_TARGET=http://127.0.0.1:3100 npm run dev`.

## Repository map

```text
apps/server/                 Fastify API, Socket.IO, SQLite, timers, adapters
apps/web/                    React/Vite responsive dashboard
packages/contracts/          Shared API and device contracts
docs/ARCHITECTURE.md         System boundaries and design decisions
docs/IMPLEMENTATION_PLAN.md  Phased backlog and acceptance gates
docs/HARDWARE_LIMITATIONS.md Honest compatibility/verification boundary
docs/research/               TV control and display-locking research (nothing implemented)
docs/PRIVACY.md              What the QR booking collects, who sees it, and when it is erased
docs/TV_TEST_PLAN.md         Step-by-step physical TV test with the companion APK
android/tv-companion/        Android TV companion app (shows a TV's screen page full-screen)
docs/agent/CURRENT_STATUS.md Live continuation record for coding agents
AGENTS.md                    Repository-wide engineering instructions
CLAUDE.md                    Claude Code entrypoint
```

## Security note

This first slice uses a single bearer token suitable for a controlled local prototype. Production preparation still requires role-based staff sessions, rate limiting, secret rotation, restricted network binding/firewall rules, and security test coverage. Never expose ADB, Tizen control ports, the API, or the dashboard directly to the public internet.

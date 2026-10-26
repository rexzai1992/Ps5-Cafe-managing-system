# Implementation Plan

## Phase 1 — Foundation (complete)

- [x] npm workspace with server, web, and shared contracts.
- [x] SQLite station/session/command persistence.
- [x] Ten auto-seeded mock TVs.
- [x] Server-owned start, pause, resume, extend, end, advertise, and expire transitions.
- [x] Per-device command serialization and explicit outcomes.
- [x] Socket.IO dashboard updates and basic responsive UI.
- [x] Fault, offline, unsupported, and accelerated-clock simulation primitives.
- [x] Initial unit tests and production build gate.
- [x] Add HTTP integration/auth tests and idempotency keys.
- [x] Add a restart integration test using a temporary file and process boundary.
- [x] Add 50-station/reconnect-storm benchmarks.

## Phase 2 — Complete operator dashboard (in progress)

- [ ] Add authenticated login and staff/admin roles.
- [x] Add 15m, 30m, 1h, 2h, 3h, custom-duration dialog and set-remaining flow.
- [ ] Add multi-select actions with disruptive-action confirmation. (Single-station confirmations are done.)
- [x] Separate page routes for the five allowed navigation sections (hash routes, phone bottom tab bar, station detail panel). Media Manager is a placeholder until Phase 3.
- [x] Add command pending states, per-station errors, keyboard accessibility, and mobile QA. (TV D-pad not verified.)
- [x] Expiry warnings (10/5/1 min), failed/unverified expired-screen alerts, stale live-data banner.
- [ ] Add full simulation controls for next timeout and per-capability failure.

Acceptance: a nontechnical staff tester completes the timer and recovery scenarios without command-line access; accessibility and responsive checks pass.

## Phase 3 — Media and transition reliability

- Add filesystem storage abstraction, MIME/signature validation, configurable limits, and safe filenames.
- Add metadata probe service (server-side FFmpeg/ffprobe only), image/video preview, playlists, ordering, assignment, and safe deletion.
- Add full-screen advertising and exact expired message simulation clients.
- Add idempotent transition jobs, bounded retries, timeouts, and backoff.
- Add startup/device-reconnect reconciliation and operator alerts.

Acceptance: media cannot escape configured storage; malicious/unsupported uploads are rejected; failed or unverified expiry is clearly amber/red and never reported as locked.

## Phase 4 — Physical adapters

Work one manufacturer/model at a time. Implement only after recording official method, pairing flow, observed capabilities, timeout/reconnect behavior, power-from-standby behavior, and screen-state verification limits.

1. Android/Google TV discovery and explicitly authorized ADB test harness.
2. Decide from measured reliability whether a minimal Kotlin companion is justified.
3. Samsung Tizen supported pairing/local-control test harness.
4. Generic remote only for a documented protocol.
5. Maintain a capability matrix; never infer support from brand alone.

Acceptance: every enabled command has a physical test record. Unknown models default to unsupported/unverified. No physical test means no production enablement.

## Phase 5 — Deployment preparation

- Windows service wrapper and Linux systemd unit.
- Backup/restore and migration runbook.
- LAN/firewall/TLS setup, secret rotation, least-privilege OS user.
- Health checks, bounded logs, startup recovery demonstration, and graceful shutdown.
- Operator pairing and troubleshooting guide.

Acceptance: clean-machine install and restart drill pass on both OS families; customer deployment still requires explicit approval.


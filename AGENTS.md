# Repository Working Agreement

## Start here

1. Read `README.md`.
2. Read `docs/ARCHITECTURE.md` and `docs/HARDWARE_LIMITATIONS.md`.
3. Read `docs/agent/CURRENT_STATUS.md` for verified current state and the next task.
4. Run `git status --short` and `npm run verify` before broad changes.

## Non-negotiable boundaries

- The server is authoritative for time and mode transitions. Never move timer ownership into the browser or TV.
- Keep simulation and real transports isolated. Simulated addresses must never create LAN traffic.
- Do not send a manufacturer command unless it is documented, capability-gated, bounded by a timeout, and tested on the target physical model.
- A successful command is not a verified screen state. Preserve `SUCCESS`, `FAILURE`, `UNSUPPORTED`, `TIMEOUT`, `UNVERIFIED`, and `DEVICE_OFFLINE` as distinct outcomes.
- Never describe software-only HDMI switching or an APK foreground screen as tamper-proof locking.
- Do not add payment, customer accounts, membership, CRM, analytics, marketing, or PS5-control features.
- Exception approved by the owner on 2026-10-25: per-TV QR reservations may collect a Malaysian mobile number with explicit consent, used only to contact that customer about that booking, erased when the reservation closes and never kept longer than 24 hours. Keep `docs/PRIVACY.md` accurate whenever this changes. A reservation only holds a TV; staff start every session.
- Do not root, flash, modify TV firmware, expose ADB publicly, capture gameplay continuously, or inject commands into PS5.
- Preserve the five navigation areas: Dashboard, TV Remote, Media Manager, Device Settings, System Settings.
- Keep real adapter implementations disabled by default until physical verification is recorded by manufacturer, model, OS/firmware, command, and result.
- Do not deploy, commit, push, register paid services, or alter real network/device credentials without explicit user approval.

## Engineering rules

- Use TypeScript strict mode and shared contracts from `@ps5-cafe/contracts`.
- Add migrations; do not silently rewrite persisted data.
- Queue commands per station. One failed/offline TV must not block another.
- Use bounded retries with backoff only for idempotent operations.
- Keep tests deterministic by injecting a clock; never wait for real minutes.
- Update `docs/agent/CURRENT_STATUS.md` after material work with exact files, checks, limitations, and one concrete next task.
- Keep automated simulation proof separate from browser-rendered proof and physical-hardware proof.

## Verification gate

Run `npm run verify`. For UI changes, also run the application and inspect the rendered desktop and narrow/mobile layouts. For persistence changes, perform a real stop/start test against a temporary SQLite file. Hardware claims require the physical test matrix in `docs/HARDWARE_LIMITATIONS.md`.


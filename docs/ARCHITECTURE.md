# System Architecture

## Outcome

The management server is the system of record. TVs are replaceable controlled devices, and the dashboard is a disposable client. Closing or reloading the dashboard cannot stop, reset, or extend a session.

```text
Staff browser(s)
  React dashboard
       |  HTTPS/REST commands + Socket.IO snapshots
       v
Local management server
  Auth boundary -> action validation -> station service
                                    -> per-TV command queue
  Authoritative clock -> timer reconciler -> mode controller
  SQLite repository                         |
                                             v
                                   TV adapter capability contract
                           +----------+----------+----------+---------+
                           | Mock     | Android  | Google   | Tizen   |
                           | enabled  | gated    | shares   | gated   |
                           | now      | unverified| Android | unverified
                           +----------+----------+----------+---------+
                                                       Future HDMI hardware
```

## Workspace boundaries

| Area | Owns | Must not own |
|---|---|---|
| `apps/server` | deadlines, persistence, state transitions, auth, queues, adapters, media metadata | browser-only timers, PS5 commands |
| `apps/web` | presentation, staff input, local previews | authoritative time/state, direct TV connections |
| `packages/contracts` | transport-neutral enums and DTOs | device protocol implementation |
| `android/tv-companion` (debug APK, not yet run on a physical TV) | showing the TV's screen page full-screen; a best-effort time-left box drawn over other apps from server-reported time | session authority, continuous capture, HDMI overlay promises (TVs may hide overlays on HDMI or in game mode) |

## State model

Three dimensions remain separate:

- Connection: `ONLINE`, `OFFLINE`, `CONNECTING`.
- Session: `NONE`, `ACTIVE`, `PAUSED`, `EXPIRED`, `ENDED`.
- Display mode: `IDLE`, `PLAYING`, `EXPIRED`.
- Blocking evidence: `NOT_APPLICABLE`, `PENDING`, `CONFIRMED`, `FAILED`, `UNVERIFIED`.

For example, an expired session can have an offline connection and a failed block. Compressing those into one `status` would hide the operator action required.

## Authoritative timing and restart recovery

Active sessions persist an absolute server deadline. Paused sessions persist remaining milliseconds and no deadline. On each tick and startup reconciliation:

1. Load persisted station/session state.
2. Compare active deadlines with the injected server clock.
3. Expire overdue sessions idempotently.
4. Queue the adapter transition to the expired screen.
5. Record the command result separately from blocking verification.

Simulation uses a persisted clock offset so accelerated sessions survive a process restart. Production never exposes time acceleration.

## Command execution

Each station has its own promise queue. Commands for one TV remain ordered; different TVs can progress concurrently. Adapter results are explicit and carry `verified`. Later retry support must be bounded, add jitter/backoff, and retry only idempotent operations. A rejected action (invalid state or arguments) is returned to the caller and never stalls the station queue. The expiry tick tracks stations with a LOCK already queued, so overlapping ticks never queue a second LOCK.

Every adapter call (commands and the state readback) is bounded by `PS5_CAFE_COMMAND_TIMEOUT_MS` (default 5 s). A call that exceeds it is recorded as `TIMEOUT` with "TV state unknown", and a late answer is discarded. A transition's in-memory changes are rolled back if anything throws, and the command-log row and station/session rows commit in one SQLite transaction. The expiry tick only *queues* an expiry check; when it reaches the head of the station queue it locks only if the deadline is still due, so an operator's +30m or END queued ahead of it wins. Only a verified success shows `CONFIRMED`; after any later command on an expired TV the evidence follows the readback, so pressing an HDMI input (the remote-button bypass) downgrades it to `FAILED`. Shutdown disconnects dashboards and drains station queues for up to 2 s before closing SQLite, with a 10 s process backstop.

Dashboard broadcasts are coalesced: at most one full snapshot per 50 ms, built when it is sent so it always carries the latest state. Without this, every command pushed a full snapshot to every client, which is O(stations²) work per client during a storm. `apps/server/src/load.test.ts` holds this and the ordering/isolation guarantees as a 50-station benchmark.

Every mutating API request must carry an `Idempotency-Key` header (8-128 characters of `A-Za-z0-9_.:-`). The server fingerprints method, URL, and body; the first execution's 2xx/4xx response is persisted for 24 hours and replayed (`idempotent-replayed: true`) on retry, including across restarts. Concurrent duplicates share one execution. Reusing a key for a different request returns 422. Unexpected 5xx errors are not stored, so the client may retry. The dashboard generates one key per operator click.

## Adapter contract

Every adapter implements connection, capabilities, status, power, volume, mute, remote keys, input switching, app launch, and the three display-mode transitions. Unsupported functionality returns `UNSUPPORTED`; it is never faked.

- `MockTvAdapter`: simulation mode. Mutates local virtual state and supports deterministic fault injection.
- `ScreenOnlyAdapter` (`screen-only`): live mode (`SIMULATION_MODE=false`). Sends the TV nothing and makes no network calls; mode changes return `UNVERIFIED` ("switch the TV with its remote"), everything else `UNSUPPORTED`, and status readback is unavailable. In live mode the station's connection and expired-screen evidence are derived in `booking.ts` from the TV's own polls: connection ONLINE while the screen page or the companion app's timer overlay polled within 15 s; the expired screen is CONFIRMED only while the screen page itself polls (it polls only while visible), PENDING for 20 s after expiry, then FAILED. Simulated and live stations never share a database file (the server refuses to start on a mix), and live time ignores any simulation offset. In production the server also serves the built web app (`/` and `/assets/*`, public, plain file names only), so phones reach the per-IP rate limits with their own address.
- Remote control of a live (`screen-only`) TV is an opt-in channel, not a separate adapter: staff pair the TV's ADB
  wireless debugging with the server and assign that device to the station (`remote.ts`, table `station_remotes`). Only
  documented platform tools are used (`input keyevent`, `input tap`, `wm size`, `screencap`), through `execFile` argument
  lists with validated inputs and a time limit; keys and taps are recorded `UNVERIFIED`; screenshots are on demand only
  (≤1/s per TV, never stored). The HDMI picture is a hardware video layer and is not captured.
- `AndroidTVAdapter`: planned. ADB is a development/debug interface requiring explicit on-device authorization, not a universal consumer-control guarantee.
- `GoogleTVAdapter`: planned as an Android specialization/profile, not duplicated logic.
- `SamsungTizenAdapter`: planned after supported local-control pairing and model behavior are physically verified.
- `GenericRemoteAdapter`: reserved for a configured and documented vendor protocol.
- `FutureHDMIHardwareAdapter`: the only planned Level 4 route for hardware-enforced display control.

Official Android documentation says wireless debugging requires same-network setup and explicit pairing, with TV version requirements varying by Android release. Android TV quality guidance also says video should pause when users switch away and apps should avoid disproportionate decoder/resource use. Samsung's official TV documentation confirms WebSocket support for Tizen TV web applications and model/version differences, but it does not by itself validate the commonly used undocumented consumer remote-control endpoint. Therefore no Samsung command endpoint is encoded in this foundation.

References:

- [Android Debug Bridge — wireless pairing](https://developer.android.com/tools/adb)
- [Android TV app quality](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [Samsung TV web-engine specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html)
- [Samsung TV remote-control application API](https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html)

## QR reservations

`apps/server/src/booking.ts`. Every station has a **screen key** (authorises that TV's screen page) and a **QR secret**. The
screen page polls `GET /api/screen/:id?k=` every 2 s (this is also the TV's heartbeat, `screenSeenAt`). The companion app's
timer overlay polls the same route with `&overlay=1` while the PS5 picture is showing, which is not counted as a heartbeat
(in live mode it does show the TV is on). The dashboard's live view embeds the screen page with `&preview=1`, which counts as
neither: watching a TV never makes it look online. A hidden screen page does not poll at all. While the TV is idle
and unreserved, the response includes a QR code = HMAC(secret, station, 2-minute window): it cannot be guessed and a photo
stops working. Scanning (`GET /api/public/stations/:id/booking?c=`) accepts the current or previous code; submitting accepts
codes up to ~10 minutes old so customers can type. A reservation **holds** the TV (default 10 minutes); it never starts a
session. Staff START on a held TV marks it STARTED; a STARTED reservation completes when the session ends. One open
reservation per TV is enforced by the service and a partial unique index. Public routes need no staff token, are per-IP
rate limited (Fastify trusts `X-Forwarded-For` from loopback only, i.e. the Vite proxy), have a 2 KB body limit, and never
return the full phone number. Phone numbers: see `docs/PRIVACY.md`.

The browser routes `#/screen/<id>?k=` and `#/book/<id>?c=` render outside the staff app and never use the staff token, which
is entered once per staff device (production builds embed none).

## Persistence

SQLite runs in WAL mode with foreign keys enabled. Current tables are:

- `stations`: identity, adapter, mode, connection, block evidence, last virtual device state.
- `sessions`: active/paused deadline representation.
- `command_log`: append-only command outcome evidence.
- `settings`: simulation offset and future system configuration.
- `idempotency_keys`: stored responses for client retries (24-hour retention, pruned on write; phone fields blanked).
- `station_screens` (migration 3): screen key, QR secret, last screen heartbeat per TV.
- `reservations` (migration 3): QR holds; `phone` is nulled when a reservation closes.

Schema changes are ordered, append-only migrations in `apps/server/src/database.ts`, tracked with `PRAGMA user_version` (currently 3). SQLite runs with `secure_delete = ON`. Migration 1 uses `IF NOT EXISTS` so databases created before versioning upgrade without rewriting data. Never edit a released migration; add a new one.

Media metadata, playlists, users/sessions, device credentials, and setup tests are later migrations. Credentials must use OS-backed or encrypted storage, not plaintext rows.

## LAN and security boundary

Normal operation is local-only, but a LAN is not trusted automatically. The prototype rejects API and socket calls without a bearer token. Authentication is default-deny on the *matched route* (only `/health` is public), never on the raw URL, so percent-encoded or absolute-form targets cannot skip it. HTTP and Socket.IO share one constant-time token check, an empty token is refused at startup, CORS grants no foreign origin (the dashboard is same-origin), and 5xx responses never echo internal error text. Before deployment add short-lived authenticated staff sessions, roles, CSRF protections where applicable, rate limits, audit events, input/IP allow-list validation, upload quarantine/validation, TLS or a trusted reverse proxy, and firewall guidance. TV control ports remain private and never bind to WAN interfaces.

## Media path

Implemented now (`apps/server/src/media.ts`): one library folder (`data/media/`, `PS5_CAFE_MEDIA_DIR`) of uploaded originals.
An upload's type is decided from its first bytes (JPEG, PNG, GIF, WebP, MP4, WebM only; never from the name or Content-Type),
stored under a server-made safe name with an atomic rename, ≤100 MB; staff list/upload/delete through `/api/media`
(idempotent), and files are public at `/media/:name` (safe names only, `nosniff`, byte ranges). Every TV's screen view
carries the playlist (`ads`), which idle screens play beside the QR code. Still future: per-TV playlists, scheduling, and
FFmpeg-made derivatives.

The full media manager stores originals and validated derivatives on the server. Validation happens before playlist eligibility. The initial compatibility derivative is MP4/H.264/AAC; actual decode support is recorded per TV model. The TV player must release its decoder before switching to HDMI and expiry transitions must not wait indefinitely for playback shutdown.

## Scale expectation

Ten stations are the initial target and 50 simulated stations are the first stress gate. SQLite and a single service are deliberate at this scale. Split services, brokers, cloud databases, and TV-side processing are rejected until measurements show a need.


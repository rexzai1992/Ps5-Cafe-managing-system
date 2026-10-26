import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { io as connect } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicBookingInfo, ReservationCreated, ScreenLinks, ScreenView, StationView, SystemSnapshot } from "@ps5-cafe/contracts";
import { buildApp } from "./app.js";
import { normalizeMalaysianMobile, qrCode, QR_WINDOW_MS, SCREEN_ONLINE_MS } from "./booking.js";
import { FakeClock } from "./clock.js";

const TOKEN = "booking-test-token";
const staff = { authorization: `Bearer ${TOKEN}` };
const MINUTE = 60_000;
let keySeq = 0;
const key = () => `booking-key-${String(++keySeq).padStart(4, "0")}`;

describe("normalizeMalaysianMobile", () => {
  it.each([
    ["012-345 6789", "+60123456789"],
    ["0123456789", "+60123456789"],
    ["011-2345 6789", "+601123456789"],
    ["60123456789", "+60123456789"],
    ["+60 12-345 6789", "+60123456789"],
    ["(012) 345-6789", "+60123456789"],
  ])("accepts %s", (input, expected) => expect(normalizeMalaysianMobile(input)).toBe(expected));

  it.each(["03-1234 5678", "+65 9123 4567", "12345", "0123", "012345678901234", "abc", "", "012-345 6789; DROP TABLE", "+0123456789"])(
    "rejects %s", (input) => expect(normalizeMalaysianMobile(input)).toBeNull(),
  );
});

describe("qrCode", () => {
  it("is 8 unambiguous characters, stable per TV and window, and different across TVs and windows", () => {
    const a = qrCode("secret", "ps5-01", 100);
    expect(a).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(qrCode("secret", "ps5-01", 100)).toBe(a);
    expect(qrCode("secret", "ps5-02", 100)).not.toBe(a);
    expect(qrCode("secret", "ps5-01", 101)).not.toBe(a);
    expect(qrCode("other", "ps5-01", 100)).not.toBe(a);
  });
});

describe("QR reservations over HTTP", () => {
  let app: FastifyInstance;
  let clock: FakeClock;
  let screens: ScreenLinks;

  beforeEach(async () => {
    clock = new FakeClock(1_800_000_000_000);
    app = await buildApp({ databasePath: ":memory:", apiToken: TOKEN, simulationMode: true, stationCount: 3, clock });
    screens = (await app.inject({ method: "GET", url: "/api/screens", headers: staff })).json<ScreenLinks>();
  });
  afterEach(async () => { await app.close(); });

  const keyOf = (id: string) => screens.screens.find((screen) => screen.stationId === id)!.key;
  const screen = (id: string, k = keyOf(id)) => app.inject({ method: "GET", url: `/api/screen/${id}?k=${encodeURIComponent(k)}` });
  const currentCode = async (id: string) => (await screen(id)).json<ScreenView>().qr!.code;
  const info = (id: string, code: string, ip = "10.0.0.1") => app.inject({ method: "GET", url: `/api/public/stations/${id}/booking?c=${code}`, remoteAddress: ip });
  const reserve = (id: string, body: Record<string, unknown>, ip = "10.0.0.1") =>
    app.inject({ method: "POST", url: `/api/public/stations/${id}/reservations`, payload: body, remoteAddress: ip });
  const snapshot = async () => (await app.inject({ method: "GET", url: "/api/snapshot", headers: staff })).json<SystemSnapshot>();
  const stationOf = async (id: string) => (await snapshot()).stations.find((station) => station.id === id)!;
  const act = (id: string, body: unknown) => app.inject({ method: "POST", url: `/api/stations/${id}/actions`, headers: { ...staff, "idempotency-key": key() }, payload: body as object });
  const advance = (durationMs: number) => app.inject({ method: "POST", url: "/api/simulation/advance", headers: { ...staff, "idempotency-key": key() }, payload: { durationMs } });
  const validBooking = async (id = "ps5-01") => ({ code: await currentCode(id), durationMs: 60 * MINUTE, phone: "012-345 6789", consent: true });

  describe("access control", () => {
    it("keeps staff routes behind the token", async () => {
      expect((await app.inject({ method: "GET", url: "/api/screens" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/stations/ps5-01/reservation/release", headers: { "idempotency-key": key() } })).statusCode).toBe(401);
    });

    it("gives every TV its own screen key and refuses a missing or wrong key", async () => {
      expect(new Set(screens.screens.map((s) => s.key)).size).toBe(3);
      expect((await app.inject({ method: "GET", url: "/api/screen/ps5-01" })).statusCode).toBe(403);
      expect((await screen("ps5-01", "wrong")).statusCode).toBe(403);
      expect((await screen("ps5-01", keyOf("ps5-02"))).statusCode).toBe(403);
      expect((await screen("ps5-99", "x")).statusCode).toBe(404);
      const view = (await screen("ps5-01")).json<ScreenView>();
      expect(view.station.name).toBe("PS5-01");
      expect(view.qr?.code).toMatch(/^[A-Z2-9]{8}$/);
    });

    it("needs no staff token for the customer booking page, but needs the TV's current code", async () => {
      expect((await info("ps5-01", "AAAAAAAA")).statusCode).toBe(403);
      expect((await info("ps5-01", "not-a-code")).statusCode).toBe(403);
      // A code belongs to its own TV only.
      expect((await info("ps5-02", await currentCode("ps5-01"))).statusCode).toBe(403);
      const ok = await info("ps5-01", await currentCode("ps5-01"));
      expect(ok.statusCode).toBe(200);
      expect(ok.json<PublicBookingInfo>()).toMatchObject({ station: { id: "ps5-01", name: "PS5-01" }, available: true, reason: null, holdMs: 10 * MINUTE });
    });

    it("stops accepting an old code: scanning needs a fresh one, submitting allows time to type", async () => {
      const code = await currentCode("ps5-01");
      clock.advance(2 * QR_WINDOW_MS);
      expect((await screen("ps5-01")).json<ScreenView>().qr!.code).not.toBe(code);
      expect((await info("ps5-01", code)).statusCode).toBe(403);
      // Submitting with the same code a few minutes later still works (time to type the phone number).
      const late = await reserve("ps5-01", { code, durationMs: 60 * MINUTE, phone: "0123456789", consent: true });
      expect(late.statusCode).toBe(201);
      // ...but not 14 minutes later.
      const stale = await currentCode("ps5-03");
      clock.advance(7 * QR_WINDOW_MS);
      expect((await reserve("ps5-03", { code: stale, durationMs: 60 * MINUTE, phone: "0123456789", consent: true })).statusCode).toBe(403);
    });
  });

  describe("reserving", () => {
    it("holds the TV, shows it to staff with the phone number, and hides the QR code", async () => {
      const response = await reserve("ps5-01", await validBooking());
      expect(response.statusCode).toBe(201);
      const created = response.json<ReservationCreated>();
      expect(created).toMatchObject({ status: "HELD", durationMs: 60 * MINUTE, station: { id: "ps5-01" }, holdUntil: clock.now() + 10 * MINUTE });
      expect(created.ref).toMatch(/^[A-Z2-9]{6}$/);
      expect(created.token.length).toBeGreaterThan(20);

      const view = await stationOf("ps5-01");
      expect(view.reservation).toMatchObject({ status: "HELD", phone: "+60123456789", ref: created.ref });
      const tv = (await screen("ps5-01")).json<ScreenView>();
      expect(tv.qr).toBeNull();
      expect(tv.reservation).toMatchObject({ status: "HELD", phoneLast4: "6789", ref: created.ref });
    });

    it("never puts the full phone number in a public response", async () => {
      const created = (await reserve("ps5-01", await validBooking())).json<ReservationCreated>();
      const status = await app.inject({ method: "GET", url: `/api/public/reservations/${created.id}?t=${created.token}` });
      for (const body of [JSON.stringify(created), status.body, (await screen("ps5-01")).body]) expect(body).not.toContain("12345");
    });

    it("allows only one reservation per TV", async () => {
      const booking = await validBooking();
      const [first, second] = await Promise.all([reserve("ps5-01", booking, "10.0.0.1"), reserve("ps5-01", booking, "10.0.0.2")]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
      const again = await info("ps5-01", booking.code);
      expect(again.json<PublicBookingInfo>()).toMatchObject({ available: false, reason: "This TV is already reserved." });
    });

    it("refuses a TV that is in use", async () => {
      const code = await currentCode("ps5-01");
      expect((await act("ps5-01", { type: "START", durationMs: 30 * MINUTE })).statusCode).toBe(200);
      expect((await screen("ps5-01")).json<ScreenView>().qr).toBeNull();
      expect((await info("ps5-01", code)).json<PublicBookingInfo>()).toMatchObject({ available: false, reason: "This TV is in use right now." });
      expect((await reserve("ps5-01", { code, durationMs: 60 * MINUTE, phone: "0123456789", consent: true })).statusCode).toBe(409);
    });

    it.each([
      ["no consent", { consent: false }, 400],
      ["consent as a string", { consent: "true" }, 400],
      ["landline", { phone: "03-1234 5678" }, 400],
      ["foreign number", { phone: "+65 9123 4567" }, 400],
      ["unlisted duration", { durationMs: 45 * MINUTE }, 400],
      ["duration as a string", { durationMs: "3600000" }, 400],
    ])("refuses %s", async (_label, change, status) => {
      expect((await reserve("ps5-01", { ...(await validBooking()), ...change })).statusCode).toBe(status);
      expect((await stationOf("ps5-01")).reservation).toBeNull();
    });

    it("rate limits reservation attempts per phone address", async () => {
      const bad = { code: await currentCode("ps5-01"), durationMs: 60 * MINUTE, phone: "bad", consent: true };
      for (let attempt = 0; attempt < 5; attempt += 1) expect((await reserve("ps5-01", bad, "10.9.9.9")).statusCode).toBe(400);
      const limited = await reserve("ps5-01", bad, "10.9.9.9");
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      // Another phone is unaffected.
      expect((await reserve("ps5-01", await validBooking(), "10.9.9.10")).statusCode).toBe(201);
    });

    it("refuses oversized request bodies", async () => {
      const response = await reserve("ps5-01", { ...(await validBooking()), padding: "x".repeat(5_000) });
      expect(response.statusCode).toBe(413);
    });
  });

  describe("after reserving", () => {
    it("expires an unpaid hold and erases the phone number", async () => {
      const created = (await reserve("ps5-01", await validBooking())).json<ReservationCreated>();
      await advance(10 * MINUTE);
      expect((await stationOf("ps5-01")).reservation).toBeNull();
      const status = await app.inject({ method: "GET", url: `/api/public/reservations/${created.id}?t=${created.token}` });
      expect(status.json()).toMatchObject({ status: "EXPIRED" });
      expect((await screen("ps5-01")).json<ScreenView>().qr).not.toBeNull();
    });

    it("links a staff start to the reservation, then completes it and erases the phone when the session ends", async () => {
      const created = (await reserve("ps5-01", await validBooking())).json<ReservationCreated>();
      const started = await act("ps5-01", { type: "START", durationMs: 60 * MINUTE });
      expect(started.json<StationView>().reservation).toMatchObject({ status: "STARTED", phone: "+60123456789" });
      const statusUrl = `/api/public/reservations/${created.id}?t=${created.token}`;
      expect((await app.inject({ method: "GET", url: statusUrl })).json()).toMatchObject({ status: "STARTED", session: { status: "ACTIVE", remainingMs: 60 * MINUTE } });
      // The hold time no longer matters once started.
      await advance(15 * MINUTE);
      expect((await stationOf("ps5-01")).reservation).toMatchObject({ status: "STARTED" });
      await act("ps5-01", { type: "END" });
      await advance(MINUTE);
      expect((await stationOf("ps5-01")).reservation).toBeNull();
      expect((await app.inject({ method: "GET", url: statusUrl })).json()).toMatchObject({ status: "COMPLETED" });
    });

    it("lets staff release a hold, once", async () => {
      await reserve("ps5-01", await validBooking());
      const release = () => app.inject({ method: "POST", url: "/api/stations/ps5-01/reservation/release", headers: { ...staff, "idempotency-key": key() } });
      const released = await release();
      expect(released.statusCode).toBe(200);
      expect(released.json<StationView>().reservation).toBeNull();
      expect((await release()).statusCode).toBe(409);
    });

    it("refuses to release a started session", async () => {
      await reserve("ps5-01", await validBooking());
      await act("ps5-01", { type: "START", durationMs: 60 * MINUTE });
      const response = await app.inject({ method: "POST", url: "/api/stations/ps5-01/reservation/release", headers: { ...staff, "idempotency-key": key() } });
      expect(response.statusCode).toBe(409);
    });

    it("lets only the reserving phone check or cancel", async () => {
      const created = (await reserve("ps5-01", await validBooking())).json<ReservationCreated>();
      expect((await app.inject({ method: "GET", url: `/api/public/reservations/${created.id}?t=wrong` })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/public/reservations/nope?t=${created.token}` })).statusCode).toBe(404);
      const cancel = (token: string) => app.inject({ method: "POST", url: `/api/public/reservations/${created.id}/cancel`, payload: { token } });
      expect((await cancel("wrong")).statusCode).toBe(404);
      const cancelled = await cancel(created.token);
      expect(cancelled.json()).toMatchObject({ status: "CANCELLED" });
      expect((await stationOf("ps5-01")).reservation).toBeNull();
      expect((await cancel(created.token)).statusCode).toBe(409);
    });

    it("records when each TV's screen last checked in", async () => {
      expect((await stationOf("ps5-01")).screenSeenAt).toBeNull();
      await screen("ps5-01");
      expect((await stationOf("ps5-01")).screenSeenAt).toBe(clock.now());
      expect((await stationOf("ps5-02")).screenSeenAt).toBeNull();
    });

    it("does not count the timer overlay's polls as the screen being seen", async () => {
      const overlay = await app.inject({ method: "GET", url: `/api/screen/ps5-01?k=${encodeURIComponent(keyOf("ps5-01"))}&overlay=1` });
      expect(overlay.statusCode).toBe(200);
      expect(overlay.json<ScreenView>().station.id).toBe("ps5-01");
      expect((await stationOf("ps5-01")).screenSeenAt).toBeNull();
      expect((await app.inject({ method: "GET", url: "/api/screen/ps5-01?k=wrong&overlay=1" })).statusCode).toBe(403);
    });
  });
});

describe("phone numbers in storage", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps5-cafe-pdpa-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("keeps the number only while the reservation is open, then erases it on every way it can close", async () => {
    const file = path.join(dir, "cafe.sqlite");
    const clock = new FakeClock(1_800_000_000_000);
    const app = await buildApp({ databasePath: file, apiToken: TOKEN, simulationMode: true, stationCount: 4, clock });
    const keys = (await app.inject({ method: "GET", url: "/api/screens", headers: staff })).json<ScreenLinks>();
    const book = async (id: string, phone: string) => {
      const k = keys.screens.find((s) => s.stationId === id)!.key;
      const code = (await app.inject({ method: "GET", url: `/api/screen/${id}?k=${k}` })).json<ScreenView>().qr!.code;
      return (await app.inject({ method: "POST", url: `/api/public/stations/${id}/reservations`, payload: { code, durationMs: 60 * MINUTE, phone, consent: true } })).json<ReservationCreated>();
    };
    const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: { ...staff, "idempotency-key": key() }, payload });
    const stored = () => {
      const db = new Database(file, { readonly: true });
      try { return db.prepare("SELECT station_id, status, phone, phone_last4 FROM reservations ORDER BY station_id").all(); }
      finally { db.close(); }
    };

    const released = await book("ps5-01", "0121111111");
    const cancelled = await book("ps5-02", "0122222222");
    await book("ps5-03", "0123333333");
    await book("ps5-04", "0124444444");
    expect(stored().every((row) => (row as { phone: string | null }).phone !== null)).toBe(true);

    await post("/api/stations/ps5-01/reservation/release");
    await app.inject({ method: "POST", url: `/api/public/reservations/${cancelled.id}/cancel`, payload: { token: cancelled.token } });
    await post("/api/stations/ps5-03/actions", { type: "START", durationMs: 30 * MINUTE });
    expect(stored()).toContainEqual({ station_id: "ps5-03", status: "STARTED", phone: "+60123333333", phone_last4: "3333" });
    await post("/api/stations/ps5-03/actions", { type: "END" });
    await post("/api/simulation/advance", { durationMs: 10 * MINUTE }); // completes ps5-03, expires ps5-04's hold

    expect(stored()).toEqual([
      { station_id: "ps5-01", status: "RELEASED", phone: null, phone_last4: null },
      { station_id: "ps5-02", status: "CANCELLED", phone: null, phone_last4: null },
      { station_id: "ps5-03", status: "COMPLETED", phone: null, phone_last4: null },
      { station_id: "ps5-04", status: "EXPIRED", phone: null, phone_last4: null },
    ]);
    expect(released.ref).toBeTruthy();
    // While the server keeps running (the normal case), neither the database nor its write-ahead log may hold them.
    const onDisk = () => fs.readFileSync(file).toString("latin1") + (fs.existsSync(`${file}-wal`) ? fs.readFileSync(`${file}-wal`).toString("latin1") : "");
    for (const digits of ["121111111", "122222222", "123333333", "124444444"]) expect(onDisk().includes(digits), `running: ${digits}`).toBe(false);
    await app.close();
    // Nothing in the database file still contains any of the numbers, in any table.
    const raw = fs.readFileSync(file).toString("latin1") + (fs.existsSync(`${file}-wal`) ? fs.readFileSync(`${file}-wal`).toString("latin1") : "");
    for (const digits of ["121111111", "122222222", "123333333", "124444444"]) expect(raw.includes(digits), digits).toBe(false);
  });
});

describe("screen keys survive a restart", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps5-cafe-booking-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("keeps each TV's screen link valid across server restarts", async () => {
    const file = path.join(dir, "cafe.sqlite");
    const options = { databasePath: file, apiToken: TOKEN, simulationMode: true, stationCount: 2, clock: new FakeClock(1_800_000_000_000) };
    const first = await buildApp(options);
    const before = (await first.inject({ method: "GET", url: "/api/screens", headers: staff })).json<ScreenLinks>();
    await first.close();
    const second = await buildApp(options);
    const after = (await second.inject({ method: "GET", url: "/api/screens", headers: staff })).json<ScreenLinks>();
    await second.close();
    expect(after.screens.map((s) => s.key)).toEqual(before.screens.map((s) => s.key));
  });
});

describe("screen presence on the dashboard", () => {
  it("pushes a snapshot when a TV's screen page opens and when it goes quiet, never for overlay polls", async () => {
    const clock = new FakeClock(1_800_000_000_000);
    const app = await buildApp({ databasePath: ":memory:", apiToken: TOKEN, simulationMode: true, stationCount: 2, clock });
    const snapshots: SystemSnapshot[] = [];
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = connect(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
      { path: "/socket.io", auth: { token: TOKEN }, transports: ["websocket"], reconnection: false, forceNew: true });
    try {
      socket.on("snapshot", (snapshot: SystemSnapshot) => snapshots.push(snapshot));
      await vi.waitFor(() => expect(snapshots.length).toBe(1));
      const online = (id: string) => snapshots.at(-1)!.stations.find((station) => station.id === id)!.screenOnline;
      const k = (await app.inject({ method: "GET", url: "/api/screens", headers: staff })).json<ScreenLinks>().screens[0]!.key;
      const poll = (extra = "") => app.inject({ method: "GET", url: `/api/screen/ps5-01?k=${encodeURIComponent(k)}${extra}` });
      const settle = () => new Promise((resolve) => setTimeout(resolve, 150)); // > the 50 ms broadcast coalescing
      expect(online("ps5-01")).toBe(false);

      await poll("&overlay=1");
      await settle();
      expect(snapshots).toHaveLength(1);

      await poll();
      await vi.waitFor(() => expect(online("ps5-01")).toBe(true));
      expect(online("ps5-02")).toBe(false);

      // Still polling: no broadcast per poll.
      const count = snapshots.length;
      clock.advance(2_000);
      await poll();
      await settle();
      expect(snapshots).toHaveLength(count);

      // Quiet for 15 s (only overlay polls): offline, pushed to the dashboard.
      clock.advance(SCREEN_ONLINE_MS);
      await poll("&overlay=1");
      await app.inject({ method: "POST", url: "/api/simulation/advance", headers: { ...staff, "idempotency-key": key() }, payload: { durationMs: 1 } });
      await vi.waitFor(() => expect(online("ps5-01")).toBe(false));
    } finally {
      socket.close();
      await app.close();
    }
  });
});

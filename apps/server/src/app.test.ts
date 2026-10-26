import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult, StationView, SystemSnapshot } from "@ps5-cafe/contracts";
import { MockTvAdapter } from "./adapters.js";
import { buildApp } from "./app.js";
import { FakeClock } from "./clock.js";

const TOKEN = "test-token-for-integration";
const auth = { authorization: `Bearer ${TOKEN}` };
let keyCounter = 0;
const freshKey = () => `test-key-${String(++keyCounter).padStart(4, "0")}`;

describe("HTTP API", () => {
  let app: FastifyInstance;
  let clock: FakeClock;

  beforeEach(async () => {
    clock = new FakeClock(1_800_000_000_000);
    app = await buildApp({ databasePath: ":memory:", apiToken: TOKEN, simulationMode: true, stationCount: 10, clock });
  });
  afterEach(async () => { await app.close(); });

  const act = (stationId: string, body: unknown, key: string | null = freshKey()) => app.inject({
    method: "POST",
    url: `/api/stations/${stationId}/actions`,
    headers: { ...auth, ...(key === null ? {} : { "idempotency-key": key }) },
    payload: body as object,
  });
  const snapshot = async () => (await app.inject({ method: "GET", url: "/api/snapshot", headers: auth })).json<SystemSnapshot>();
  const station = async (id = "ps5-01") => (await snapshot()).stations.find((candidate) => candidate.id === id)!;
  const advance = (durationMs: unknown) => app.inject({
    method: "POST", url: "/api/simulation/advance",
    headers: { ...auth, "idempotency-key": freshKey() }, payload: { durationMs },
  });

  describe("authentication", () => {
    it("rejects API requests without a token", async () => {
      const response = await app.inject({ method: "GET", url: "/api/snapshot" });
      expect(response.statusCode).toBe(401);
    });

    it("rejects API requests with a wrong token", async () => {
      const response = await app.inject({ method: "GET", url: "/api/snapshot", headers: { authorization: "Bearer wrong" } });
      expect(response.statusCode).toBe(401);
    });

    it("rejects an unauthenticated mutation before it executes", async () => {
      const response = await app.inject({
        method: "POST", url: "/api/stations/ps5-01/actions",
        headers: { "idempotency-key": freshKey() }, payload: { type: "START", durationMs: 60_000 },
      });
      expect(response.statusCode).toBe(401);
      const snapshot = (await app.inject({ method: "GET", url: "/api/snapshot", headers: auth })).json<SystemSnapshot>();
      expect(snapshot.stations[0]!.session.status).toBe("NONE");
    });

    it("serves the snapshot with a valid token", async () => {
      const response = await app.inject({ method: "GET", url: "/api/snapshot", headers: auth });
      expect(response.statusCode).toBe(200);
      const snapshot = response.json<SystemSnapshot>();
      expect(snapshot.stations).toHaveLength(10);
      expect(snapshot.serverTime).toBe(clock.now());
    });

    it("keeps the health probe public", async () => {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, simulationMode: true });
    });

    it("denies percent-encoded API paths without a token, and the mutation does not execute", async () => {
      expect((await app.inject({ method: "GET", url: "/%61pi/snapshot" })).statusCode).toBe(401);
      const start = await app.inject({
        method: "POST", url: "/%61pi/stations/ps5-01/actions",
        headers: { "idempotency-key": freshKey() }, payload: { type: "START", durationMs: 60 * 60_000 },
      });
      expect(start.statusCode).toBe(401);
      expect((await station()).session.status).toBe("NONE");
    });

    it("denies unknown routes without a token and returns 404 with one", async () => {
      expect((await app.inject({ method: "GET", url: "/no-such-route" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/no-such-route", headers: auth })).statusCode).toBe(404);
    });

    it.each([
      ["a prefix of the token", `Bearer ${TOKEN.slice(0, -1)}`],
      ["the token plus a suffix", `Bearer ${TOKEN}x`],
      ["a lower-case scheme", `bearer ${TOKEN}`],
      ["the bare token", TOKEN],
      ["an empty bearer", "Bearer "],
    ])("rejects an authorization header with %s", async (_label, authorization) => {
      expect((await app.inject({ method: "GET", url: "/api/snapshot", headers: { authorization } })).statusCode).toBe(401);
    });

    it("grants no CORS access to a foreign origin", async () => {
      const preflight = await app.inject({
        method: "OPTIONS", url: "/api/stations/ps5-01/actions",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,idempotency-key" },
      });
      expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
      const read = await app.inject({ method: "GET", url: "/api/snapshot", headers: { ...auth, origin: "https://evil.example" } });
      expect(read.statusCode).toBe(200);
      expect(read.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it.each(["", "   ", "\t\n"])("refuses to build with a blank API token (%j)", async (apiToken) => {
      await expect(buildApp({ databasePath: ":memory:", apiToken, simulationMode: true, stationCount: 1, clock })).rejects.toThrow(/apiToken/);
    });
  });

  describe("error responses", () => {
    it("returns a generic 500 body that does not echo the error message", async () => {
      app.get("/api/test-only/explode", async () => { throw new Error("SQLITE_CORRUPT at /secret/path/cafe.sqlite"); });
      const response = await app.inject({ method: "GET", url: "/api/test-only/explode", headers: auth });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "Internal Server Error" });
      expect(response.body).not.toContain("SQLITE_CORRUPT");
      expect(response.body).not.toContain("/secret/path");
    });

    it("leaves Fastify's 4xx error format unchanged", async () => {
      const response = await app.inject({
        method: "POST", url: "/api/stations/ps5-01/actions",
        headers: { ...auth, "idempotency-key": freshKey(), "content-type": "application/json" }, payload: "{not json",
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ statusCode: 400, code: "FST_ERR_CTP_INVALID_JSON_BODY", error: "Bad Request" });
    });
  });

  describe("duration presets and session-state guards", () => {
    const MINUTE = 60_000;

    it.each([
      ["15m", 900_000],
      ["30m", 1_800_000],
      ["1h", 3_600_000],
      ["2h", 7_200_000],
      ["3h", 10_800_000],
    ])("starts the %s preset with deadlineAt = now + preset", async (_label, presetMs) => {
      const response = await act("ps5-01", { type: "START", durationMs: presetMs });
      expect(response.statusCode).toBe(200);
      const view = response.json<StationView>();
      expect(view.session.status).toBe("ACTIVE");
      expect(view.session.deadlineAt).toBe(clock.now() + presetMs);
      expect(view.session.remainingMs).toBe(presetMs);
    });

    it("rejects START on an active session and leaves its deadline alone", async () => {
      await act("ps5-01", { type: "START", durationMs: 180 * MINUTE });
      const before = await station();
      const response = await act("ps5-01", { type: "START", durationMs: 15 * MINUTE });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("Session already running; use ADD_TIME or SET_REMAINING");
      expect(await station()).toEqual(before);
      expect(before.session.deadlineAt).toBe(clock.now() + 180 * MINUTE);
    });

    it("rejects START on a paused session and leaves its remaining time alone", async () => {
      await act("ps5-01", { type: "START", durationMs: 60 * MINUTE });
      clock.advance(10 * MINUTE);
      await act("ps5-01", { type: "PAUSE" });
      const before = await station();
      expect((await act("ps5-01", { type: "START", durationMs: 15 * MINUTE })).statusCode).toBe(400);
      const after = await station();
      expect(after).toEqual(before);
      expect(after.session).toMatchObject({ status: "PAUSED", pausedRemainingMs: 50 * MINUTE, deadlineAt: null });
    });

    it("allows START again after END and after an expiry", async () => {
      await act("ps5-01", { type: "START", durationMs: 30 * MINUTE });
      expect((await act("ps5-01", { type: "END" })).statusCode).toBe(200);
      const afterEnd = await act("ps5-01", { type: "START", durationMs: 15 * MINUTE });
      expect(afterEnd.statusCode).toBe(200);
      expect(afterEnd.json<StationView>().session.deadlineAt).toBe(clock.now() + 15 * MINUTE);

      expect((await advance(15 * MINUTE)).statusCode).toBe(200);
      expect((await station()).session.status).toBe("EXPIRED");
      const afterExpiry = await act("ps5-01", { type: "START", durationMs: 60 * MINUTE });
      expect(afterExpiry.statusCode).toBe(200);
      const view = afterExpiry.json<StationView>();
      expect(view.session.status).toBe("ACTIVE");
      expect(view.mode).toBe("PLAYING");
      expect(view.session.deadlineAt).toBe((await snapshot()).serverTime + 60 * MINUTE);
    });

    it("raises and lowers the remaining time of an active session without touching the TV", async () => {
      const started = (await act("ps5-01", { type: "START", durationMs: 60 * MINUTE })).json<StationView>();
      clock.advance(5 * MINUTE);
      const raised = await act("ps5-01", { type: "SET_REMAINING", durationMs: 120 * MINUTE });
      expect(raised.statusCode).toBe(200);
      const up = raised.json<StationView>();
      expect(up.session.status).toBe("ACTIVE");
      expect(up.session.deadlineAt).toBe(clock.now() + 120 * MINUTE);
      expect(up.mode).toBe(started.mode);
      expect(up.blockingStatus).toBe(started.blockingStatus);
      // No adapter command ran: the last command is still the START's.
      expect(up.lastCommand).toEqual(started.lastCommand);

      const lowered = (await act("ps5-01", { type: "SET_REMAINING", durationMs: 15 * MINUTE })).json<StationView>();
      expect(lowered.session.deadlineAt).toBe(clock.now() + 15 * MINUTE);
      expect(lowered.session.remainingMs).toBe(15 * MINUTE);
      expect(lowered.lastCommand).toEqual(started.lastCommand);
    });

    it("sets the remaining time of a paused session, and RESUME uses it", async () => {
      await act("ps5-01", { type: "START", durationMs: 60 * MINUTE });
      clock.advance(10 * MINUTE);
      await act("ps5-01", { type: "PAUSE" });
      const response = await act("ps5-01", { type: "SET_REMAINING", durationMs: 20 * MINUTE });
      expect(response.statusCode).toBe(200);
      expect(response.json<StationView>().session).toMatchObject({
        status: "PAUSED", pausedRemainingMs: 20 * MINUTE, deadlineAt: null, remainingMs: 20 * MINUTE,
      });
      clock.advance(30 * MINUTE);
      const resumed = (await act("ps5-01", { type: "RESUME" })).json<StationView>();
      expect(resumed.session.deadlineAt).toBe(clock.now() + 20 * MINUTE);
    });

    it.each([
      ["NONE", async () => {}],
      ["ENDED", async () => {
        await act("ps5-01", { type: "START", durationMs: 30 * MINUTE });
        await act("ps5-01", { type: "END" });
      }],
      ["EXPIRED", async () => {
        await act("ps5-01", { type: "START", durationMs: 15 * MINUTE });
        await advance(15 * MINUTE);
      }],
    ])("rejects SET_REMAINING on a %s session with state unchanged", async (status, arrange) => {
      await arrange();
      const before = await station();
      expect(before.session.status).toBe(status);
      const response = await act("ps5-01", { type: "SET_REMAINING", durationMs: 30 * MINUTE });
      expect(response.statusCode).toBe(400);
      expect(await station()).toEqual(before);
    });

    it.each(["ACTIVE", "PAUSED"])("rejects SHOW_ADVERTISING on a %s session with state unchanged", async (status) => {
      await act("ps5-01", { type: "START", durationMs: 60 * MINUTE });
      if (status === "PAUSED") await act("ps5-01", { type: "PAUSE" });
      const before = await station();
      expect(before.session.status).toBe(status);
      const response = await act("ps5-01", { type: "SHOW_ADVERTISING" });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("End the session before showing advertising");
      expect(await station()).toEqual(before);
    });

    it("still shows advertising on idle, ended and expired stations", async () => {
      expect((await act("ps5-01", { type: "SHOW_ADVERTISING" })).statusCode).toBe(200);
      await act("ps5-02", { type: "START", durationMs: 30 * MINUTE });
      await act("ps5-02", { type: "END" });
      expect((await act("ps5-02", { type: "SHOW_ADVERTISING" })).statusCode).toBe(200);
      await act("ps5-03", { type: "START", durationMs: 15 * MINUTE });
      await advance(15 * MINUTE);
      const expired = await act("ps5-03", { type: "SHOW_ADVERTISING" });
      expect(expired.statusCode).toBe(200);
      expect(expired.json<StationView>()).toMatchObject({ mode: "IDLE", session: { status: "EXPIRED" } });
    });

    it("applies the one-minute minimum to START, ADD_TIME and SET_REMAINING", async () => {
      expect((await act("ps5-01", { type: "START", durationMs: 59_999 })).statusCode).toBe(400);
      expect((await act("ps5-01", { type: "START", durationMs: 60_000 })).statusCode).toBe(200);
      const before = await station();
      expect((await act("ps5-01", { type: "ADD_TIME", durationMs: 59_999 })).statusCode).toBe(400);
      expect((await act("ps5-01", { type: "SET_REMAINING", durationMs: 59_999 })).statusCode).toBe(400);
      expect(await station()).toEqual(before);
    });

    it.each([
      ["1.5 ms START", { type: "START", durationMs: 1.5 }],
      ["1e-300 ms START", { type: "START", durationMs: 1e-300 }],
      ["fractional ADD_TIME", { type: "ADD_TIME", durationMs: 60_000.5 }],
      ["fractional SET_REMAINING", { type: "SET_REMAINING", durationMs: 1_800_000.25 }],
      ["unsafe-integer START", { type: "START", durationMs: 2 ** 53 }],
    ])("rejects a non-integer duration in validation (%s)", async (_label, body) => {
      await act("ps5-02", { type: "START", durationMs: 60 * MINUTE });
      const target = body.type === "START" ? "ps5-01" : "ps5-02";
      const before = await station(target);
      const response = await act(target, body);
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("durationMs must be a whole number of milliseconds");
      expect(await station(target)).toEqual(before);
    });

    it("requires a whole simulation advance of at least 1 ms", async () => {
      expect((await advance(1.5)).statusCode).toBe(400);
      expect((await advance(0)).statusCode).toBe(400);
      expect((await snapshot()).acceleratedByMs).toBe(0);
      expect((await advance(1)).statusCode).toBe(200);
      expect((await snapshot()).acceleratedByMs).toBe(1);
    });
  });

  describe("simulated connection control", () => {
    it("rejects SET_CONNECTION CONNECTING, which an operator cannot request", async () => {
      const response = await act("ps5-01", { type: "SET_CONNECTION", connection: "CONNECTING" });
      expect(response.statusCode).toBe(400);
      expect((await station()).connection).toBe("ONLINE");
    });
  });

  describe("station actions", () => {
    it("starts a session through the API", async () => {
      const response = await act("ps5-01", { type: "START", durationMs: 60 * 60_000 });
      expect(response.statusCode).toBe(200);
      const station = response.json<StationView>();
      expect(station.session.status).toBe("ACTIVE");
      expect(station.session.deadlineAt).toBe(clock.now() + 60 * 60_000);
    });

    it("returns 404 for an unknown station", async () => {
      const response = await act("ps5-99", { type: "LOCK" });
      expect(response.statusCode).toBe(404);
    });

    it.each([
      ["unknown type", { type: "SELF_DESTRUCT" }],
      ["missing body fields", { type: "START" }],
      ["string duration", { type: "START", durationMs: "60000" }],
      ["extra fields", { type: "LOCK", force: true }],
      ["invalid remote key", { type: "REMOTE_KEY", key: "FORMAT_DISK" }],
      ["invalid input", { type: "SWITCH_INPUT", input: "USB" }],
      ["array body", [{ type: "LOCK" }]],
    ])("returns 400 for a malformed action (%s)", async (_label, body) => {
      const response = await act("ps5-01", body);
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBeTruthy();
    });

    it.each([
      ["zero duration", { type: "START", durationMs: 0 }],
      ["over 24 hours", { type: "START", durationMs: 25 * 60 * 60_000 }],
      ["pause without session", { type: "PAUSE" }],
      ["resume without pause", { type: "RESUME" }],
      ["extend without session", { type: "ADD_TIME", durationMs: 60_000 }],
    ])("returns 400 for an action rejected by the domain (%s)", async (_label, body) => {
      const response = await act("ps5-01", body);
      expect(response.statusCode).toBe(400);
    });

    it("keeps a station's command queue working after a rejected action", async () => {
      expect((await act("ps5-01", { type: "PAUSE" })).statusCode).toBe(400);
      const response = await act("ps5-01", { type: "START", durationMs: 60_000 });
      expect(response.statusCode).toBe(200);
      expect(response.json<StationView>().session.status).toBe("ACTIVE");
    });

    it("rejects a negative simulation advance", async () => {
      const response = await app.inject({
        method: "POST", url: "/api/simulation/advance",
        headers: { ...auth, "idempotency-key": freshKey() }, payload: { durationMs: -1 },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("idempotency keys", () => {
    it("requires a key on mutating requests", async () => {
      const response = await act("ps5-01", { type: "START", durationMs: 60_000 }, null);
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toMatch(/Idempotency-Key/);
    });

    it("rejects a malformed key", async () => {
      expect((await act("ps5-01", { type: "LOCK" }, "short")).statusCode).toBe(400);
      expect((await act("ps5-01", { type: "LOCK" }, "has spaces in it")).statusCode).toBe(400);
    });

    it("replays a retried request instead of executing it twice", async () => {
      const key = freshKey();
      await act("ps5-01", { type: "START", durationMs: 60 * 60_000 });
      const first = await act("ps5-01", { type: "ADD_TIME", durationMs: 30 * 60_000 }, key);
      clock.advance(1_000);
      const retry = await act("ps5-01", { type: "ADD_TIME", durationMs: 30 * 60_000 }, key);
      expect(retry.statusCode).toBe(200);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect(retry.json()).toEqual(first.json());
      const snapshot = (await app.inject({ method: "GET", url: "/api/snapshot", headers: auth })).json<SystemSnapshot>();
      expect(snapshot.stations[0]!.session.deadlineAt).toBe(1_800_000_000_000 + 90 * 60_000);
    });

    it("executes concurrent duplicates once", async () => {
      const key = freshKey();
      await act("ps5-01", { type: "START", durationMs: 60 * 60_000 });
      const [a, b] = await Promise.all([
        act("ps5-01", { type: "ADD_TIME", durationMs: 30 * 60_000 }, key),
        act("ps5-01", { type: "ADD_TIME", durationMs: 30 * 60_000 }, key),
      ]);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(a.json()).toEqual(b.json());
      expect(a.json<StationView>().session.deadlineAt).toBe(1_800_000_000_000 + 90 * 60_000);
    });

    it("replays a rejected outcome without re-executing", async () => {
      const key = freshKey();
      expect((await act("ps5-01", { type: "PAUSE" }, key)).statusCode).toBe(400);
      await act("ps5-01", { type: "START", durationMs: 60_000 });
      const retry = await act("ps5-01", { type: "PAUSE" }, key);
      expect(retry.statusCode).toBe(400);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      const snapshot = (await app.inject({ method: "GET", url: "/api/snapshot", headers: auth })).json<SystemSnapshot>();
      expect(snapshot.stations[0]!.session.status).toBe("ACTIVE");
    });

    it("returns 422 when a key is reused for a different request", async () => {
      const key = freshKey();
      expect((await act("ps5-01", { type: "START", durationMs: 60_000 }, key)).statusCode).toBe(200);
      expect((await act("ps5-01", { type: "START", durationMs: 120_000 }, key)).statusCode).toBe(422);
      expect((await act("ps5-02", { type: "START", durationMs: 60_000 }, key)).statusCode).toBe(422);
    });

    it("applies to simulation time acceleration", async () => {
      const key = freshKey();
      const advance = () => app.inject({
        method: "POST", url: "/api/simulation/advance",
        headers: { ...auth, "idempotency-key": key }, payload: { durationMs: 5 * 60_000 },
      });
      expect((await advance()).json<SystemSnapshot>().acceleratedByMs).toBe(5 * 60_000);
      expect((await advance()).json<SystemSnapshot>().acceleratedByMs).toBe(5 * 60_000);
      const snapshot = (await app.inject({ method: "GET", url: "/api/snapshot", headers: auth })).json<SystemSnapshot>();
      expect(snapshot.acceleratedByMs).toBe(5 * 60_000);
    });
  });
});

describe("auth boundary on a real listener", () => {
  // A numeric-looking token makes the "numeric token" handshake case meaningful: 1234567890 must not match "1234567890".
  const DIGIT_TOKEN = "1234567890";
  let app: FastifyInstance;
  let port: number;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    app = await buildApp({ databasePath: ":memory:", apiToken: DIGIT_TOKEN, simulationMode: true, stationCount: 2, clock: new FakeClock(1_800_000_000_000) });
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await app.close();
  });

  /** Sends a hand-written HTTP/1.1 request over a raw TCP socket and returns the whole response text. */
  const rawRequest = (request: string) => new Promise<string>((resolve, reject) => {
    let response = "";
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.on("close", () => resolve(response));
    socket.on("error", reject);
  });
  const statusLine = (response: string) => response.split("\r\n")[0];

  it("denies an absolute-form request target without a token", async () => {
    const response = await rawRequest("GET http://x/api/snapshot HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(statusLine(response)).toBe("HTTP/1.1 401 Unauthorized");
    expect(response).not.toContain("stations");
  });

  it("routes the same absolute-form target to the snapshot when the token is present", async () => {
    const response = await rawRequest(`GET http://x/api/snapshot HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${DIGIT_TOKEN}\r\nConnection: close\r\n\r\n`);
    expect(statusLine(response)).toBe("HTTP/1.1 200 OK");
    expect(response).toContain("stations");
  });

  it("keeps /health public on the listener", async () => {
    const response = await rawRequest("GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(statusLine(response)).toBe("HTTP/1.1 200 OK");
  });

  const handshake = (auth: Record<string, unknown>) => new Promise<"snapshot" | "connect_error">((resolve) => {
    const socket = connect(`http://127.0.0.1:${port}`, { path: "/socket.io", auth, transports: ["websocket"], reconnection: false, forceNew: true });
    sockets.push(socket);
    socket.once("snapshot", () => resolve("snapshot"));
    socket.once("connect_error", () => resolve("connect_error"));
  });

  it.each([
    ["a wrong token", { token: "0987654321" }],
    ["a numeric token", { token: 1234567890 }],
    ["a missing token", {}],
  ])("refuses a Socket.IO handshake with %s", async (_label, auth) => {
    expect(await handshake(auth)).toBe("connect_error");
  });

  it("sends a snapshot to a Socket.IO handshake with the correct token", async () => {
    expect(await handshake({ token: DIGIT_TOKEN })).toBe("snapshot");
  });
});

describe("graceful shutdown", () => {
  const options = { apiToken: TOKEN, simulationMode: true, stationCount: 2 } as const;
  afterEach(() => { vi.restoreAllMocks(); });

  it("closes within 2 s while a dashboard websocket is still open, and the dashboard is disconnected", async () => {
    const app = await buildApp({ ...options, databasePath: ":memory:", clock: new FakeClock(1_800_000_000_000) });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = connect(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, {
      path: "/socket.io", auth: { token: TOKEN }, transports: ["websocket"], reconnection: false, forceNew: true,
    });
    try {
      await new Promise<void>((resolve, reject) => { socket.once("snapshot", () => resolve()); socket.once("connect_error", reject); });
      const disconnected = new Promise<string>((resolve) => socket.once("disconnect", resolve));
      const started = performance.now();
      let timer: NodeJS.Timeout | undefined;
      const closed = await Promise.race([
        app.close().then(() => "closed"),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still open after 2 s"), 2_000); }),
      ]);
      clearTimeout(timer);
      expect(closed).toBe("closed");
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(await disconnected).toBe("io server disconnect");
    } finally {
      socket.close();
    }
  });

  it("lets a LOCK that is already running finish and persist before the database closes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps5-cafe-shutdown-"));
    try {
      const databasePath = path.join(dir, "cafe.sqlite");
      const app = await buildApp({ ...options, databasePath, clock: new FakeClock(1_800_000_000_000) });
      const original = MockTvAdapter.prototype.enterExpiredMode;
      let markStarted!: () => void;
      const lockStarted = new Promise<void>((resolve) => { markStarted = resolve; });
      vi.spyOn(MockTvAdapter.prototype, "enterExpiredMode").mockImplementation(async function (this: MockTvAdapter): Promise<CommandResult> {
        markStarted();
        await new Promise((resolve) => setTimeout(resolve, 150));
        return original.call(this);
      });

      const lock = app.inject({
        method: "POST", url: "/api/stations/ps5-01/actions",
        headers: { ...auth, "idempotency-key": "shutdown-lock-0001" }, payload: { type: "LOCK" },
      });
      await lockStarted;
      const closing = app.close();
      const response = await lock;
      await closing;

      expect(response.statusCode).toBe(200);
      expect(response.json<StationView>()).toMatchObject({ mode: "EXPIRED", blockingStatus: "CONFIRMED", session: { status: "EXPIRED" } });
      const file = new Database(databasePath, { readonly: true });
      try {
        expect(file.prepare("SELECT status FROM sessions WHERE station_id = 'ps5-01'").get()).toEqual({ status: "EXPIRED" });
        expect(file.prepare("SELECT mode, blocking_status FROM stations WHERE id = 'ps5-01'").get()).toEqual({ mode: "EXPIRED", blocking_status: "CONFIRMED" });
        expect(file.prepare("SELECT command_type, outcome FROM command_log WHERE station_id = 'ps5-01'").all())
          .toEqual([{ command_type: "LOCK", outcome: "SUCCESS" }]);
        expect(file.prepare("SELECT status_code FROM idempotency_keys WHERE key = 'shutdown-lock-0001'").get()).toEqual({ status_code: 200 });
      } finally {
        file.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("configuration", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("treats a blank PS5_CAFE_API_TOKEN as unset outside production", async () => {
    vi.stubEnv("PS5_CAFE_API_TOKEN", "");
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.apiToken).toBe("local-dev-token");
  });

  it("refuses a blank or whitespace PS5_CAFE_API_TOKEN in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const token of ["", "   "]) {
      vi.stubEnv("PS5_CAFE_API_TOKEN", token);
      vi.resetModules();
      await expect(import("./config.js")).rejects.toThrow(/PS5_CAFE_API_TOKEN is required in production/);
    }
  });
});

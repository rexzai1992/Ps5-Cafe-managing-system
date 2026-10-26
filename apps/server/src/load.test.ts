import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult, StationAction, SystemSnapshot } from "@ps5-cafe/contracts";
import { MockTvAdapter } from "./adapters.js";
import { buildApp } from "./app.js";
import { FakeClock } from "./clock.js";
import { AppDatabase } from "./database.js";
import { createSystem, type TvManagementSystem } from "./system.js";

/**
 * 50-station capacity and reconnect-storm benchmark. Time is a FakeClock, so nothing waits for real minutes.
 * Latency bounds are deliberately generous so the gate is stable; measured numbers are printed for the status record.
 */

const STATIONS = 50;
const CLIENTS = 20;
const HOUR = 60 * 60_000;
const ids = Array.from({ length: STATIONS }, (_, index) => `ps5-${String(index + 1).padStart(2, "0")}`);
const metrics: Record<string, number | string> = {};

const elapsed = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
  const started = performance.now();
  const value = await work();
  return [value, Math.round((performance.now() - started) * 10) / 10];
};
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! * 10) / 10;
};
async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterAll(() => { console.log(`[load-benchmark] ${JSON.stringify(metrics)}`); });

describe(`${STATIONS}-station domain behaviour`, () => {
  let db: AppDatabase;
  let clock: FakeClock;
  let system: TvManagementSystem;

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    clock = new FakeClock(1_800_000_000_000);
    // An explicit long command timeout: the isolation test holds one TV's call open and must not see it time out.
    system = createSystem(db, true, STATIONS, clock, { commandTimeoutMs: 60_000 });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  const commandLog = (stationId: string) => db.raw
    .prepare("SELECT command_type, outcome FROM command_log WHERE station_id = ? ORDER BY rowid")
    .all(stationId) as { command_type: string; outcome: string }[];

  it("keeps every station's commands in submission order during a connectivity storm", async () => {
    // Real TVs answer with varying latency; make the earlier input switch the slower one so only the queue keeps order.
    const original = MockTvAdapter.prototype.switchInput;
    vi.spyOn(MockTvAdapter.prototype, "switchInput").mockImplementation(async function (this: MockTvAdapter, input: string): Promise<CommandResult> {
      await new Promise((resolve) => setTimeout(resolve, input === "HDMI2" ? 15 : 1));
      return original.call(this, input);
    });
    const sequence: StationAction[] = [
      { type: "SET_CONNECTION", connection: "OFFLINE" },
      { type: "SWITCH_INPUT", input: "HDMI2" },
      { type: "SET_CONNECTION", connection: "ONLINE" },
      { type: "SWITCH_INPUT", input: "HDMI3" },
    ];
    // All 200 commands are enqueued synchronously before any of them runs.
    const pending = ids.flatMap((id) => sequence.map((action) => system.action(id, action)));
    await Promise.all(pending);

    for (const id of ids) {
      // Any reordering would either leave the TV offline or turn one of the outcomes into DEVICE_OFFLINE/SUCCESS.
      expect(commandLog(id)).toEqual([
        { command_type: "SET_CONNECTION", outcome: "SUCCESS" },
        { command_type: "SWITCH_INPUT", outcome: "DEVICE_OFFLINE" },
        { command_type: "SET_CONNECTION", outcome: "SUCCESS" },
        { command_type: "SWITCH_INPUT", outcome: "SUCCESS" },
      ]);
    }
    const snapshot = system.snapshot();
    expect(snapshot.stations.every((station) => station.connection === "ONLINE" && station.deviceState.input === "HDMI3")).toBe(true);
  });

  it("does not let one hung TV block the other stations", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = MockTvAdapter.prototype.switchInput;
    vi.spyOn(MockTvAdapter.prototype, "switchInput").mockImplementation(async function (this: MockTvAdapter, input: string): Promise<CommandResult> {
      if (input === "HDMI4") await gate;
      return original.call(this, input);
    });

    let hungSettled = false;
    const hung = Promise.all([
      system.action("ps5-01", { type: "SWITCH_INPUT", input: "HDMI4" }),
      system.action("ps5-01", { type: "START", durationMs: HOUR }),
    ]).finally(() => { hungSettled = true; });

    const others = ids.slice(1);
    const [, othersMs] = await elapsed(() => Promise.all(others.map(async (id) => {
      await system.action(id, { type: "START", durationMs: HOUR });
      await system.action(id, { type: "LOCK" });
    })));
    metrics.isolationOthersMs = othersMs;

    expect(hungSettled).toBe(false);
    const during = system.snapshot();
    expect(during.stations[0]!.session.status).toBe("NONE");
    expect(during.stations.slice(1).every((station) => station.mode === "EXPIRED" && station.blockingStatus === "CONFIRMED")).toBe(true);

    release();
    await hung;
    expect(commandLog("ps5-01").map((row) => row.command_type)).toEqual(["SWITCH_INPUT", "START"]);
    expect(system.snapshot().stations[0]!.session.status).toBe("ACTIVE");
  });

  it(`expires all ${STATIONS} stations in one tick, and overlapping ticks lock each station once`, async () => {
    await Promise.all(ids.map((id) => system.action(id, { type: "START", durationMs: HOUR })));
    clock.advance(HOUR);
    const [, tickMs] = await elapsed(() => Promise.all([system.reconcileExpired(), system.reconcileExpired()]));
    metrics.domainExpiryTickMs = tickMs;

    const snapshot = system.snapshot();
    expect(snapshot.stations.every((station) => station.mode === "EXPIRED" && station.blockingStatus === "CONFIRMED")).toBe(true);
    const locks = db.raw.prepare("SELECT COUNT(*) AS count FROM command_log WHERE command_type = 'LOCK'").get() as { count: number };
    expect(locks.count).toBe(STATIONS);
    expect(tickMs).toBeLessThan(1_000);
  });
});

describe(`${STATIONS}-station HTTP and ${CLIENTS}-client Socket.IO storm`, { timeout: 60_000 }, () => {
  const TOKEN = "load-test-token";
  let app: FastifyInstance;
  let baseUrl: string;
  let clients: Socket[] = [];
  const latest = new Map<Socket, SystemSnapshot>();
  const received = new Map<Socket, number>();
  let keySeq = 0;

  const post = async (url: string, body: unknown) => {
    const started = performance.now();
    const response = await fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": `load-${++keySeq}-key` },
      body: JSON.stringify(body),
    });
    const ms = performance.now() - started;
    return { status: response.status, json: await response.json() as unknown, ms };
  };

  const connectClient = () => new Promise<Socket>((resolve, reject) => {
    const socket = connect(baseUrl, { path: "/socket.io", auth: { token: TOKEN }, transports: ["websocket"], reconnection: false, forceNew: true });
    socket.on("snapshot", (snapshot: SystemSnapshot) => {
      latest.set(socket, snapshot);
      received.set(socket, (received.get(socket) ?? 0) + 1);
      resolve(socket);
    });
    socket.on("connect_error", reject);
  });

  beforeAll(async () => {
    app = await buildApp({ databasePath: ":memory:", apiToken: TOKEN, simulationMode: true, stationCount: STATIONS, clock: new FakeClock(1_800_000_000_000) });
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const [connected, connectMs] = await elapsed(() => Promise.all(Array.from({ length: CLIENTS }, connectClient)));
    clients = connected;
    metrics.initialConnectMs = connectMs;
  });
  afterAll(async () => {
    for (const socket of clients) socket.close();
    await app.close();
  });

  const everyClientSees = (predicate: (snapshot: SystemSnapshot) => boolean) =>
    clients.every((socket) => { const snapshot = latest.get(socket); return snapshot !== undefined && predicate(snapshot); });

  it("serves the 50-station snapshot quickly", async () => {
    const samples: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      const response = await fetch(`${baseUrl}/api/snapshot`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const snapshot = await response.json() as SystemSnapshot;
      samples.push(performance.now() - started);
      expect(snapshot.stations).toHaveLength(STATIONS);
    }
    metrics.snapshotP50Ms = percentile(samples, 50);
    metrics.snapshotP95Ms = percentile(samples, 95);
    expect(metrics.snapshotP95Ms).toBeLessThan(100);
  });

  it("starts every station concurrently and pushes the result to every client", async () => {
    const [results, totalMs] = await elapsed(() => Promise.all(ids.map((id) => post(`/api/stations/${id}/actions`, { type: "START", durationMs: HOUR }))));
    expect(results.every((result) => result.status === 200)).toBe(true);
    metrics.startStormTotalMs = totalMs;
    metrics.startRequestP95Ms = percentile(results.map((result) => result.ms), 95);
    await waitFor(() => everyClientSees((snapshot) => snapshot.stations.every((station) => station.session.status === "ACTIVE")), 5_000, "ACTIVE fan-out");
    expect(totalMs).toBeLessThan(5_000);
  });

  it("expires every station in one advance and pushes the expired screens", async () => {
    const [result, advanceMs] = await elapsed(() => post("/api/simulation/advance", { durationMs: HOUR }));
    expect(result.status).toBe(200);
    const snapshot = result.json as SystemSnapshot;
    expect(snapshot.stations.every((station) => station.mode === "EXPIRED" && station.blockingStatus === "CONFIRMED")).toBe(true);
    metrics.httpExpiryAdvanceMs = advanceMs;
    await waitFor(() => everyClientSees((next) => next.stations.every((station) => station.mode === "EXPIRED")), 5_000, "EXPIRED fan-out");
    expect(advanceMs).toBeLessThan(2_000);
  });

  it("survives every TV dropping and reconnecting at once", async () => {
    const before = clients.map((socket) => received.get(socket) ?? 0);
    const [results, stormMs] = await elapsed(() => Promise.all(ids.map(async (id) => {
      const offline = await post(`/api/stations/${id}/actions`, { type: "SET_CONNECTION", connection: "OFFLINE" });
      const online = await post(`/api/stations/${id}/actions`, { type: "SET_CONNECTION", connection: "ONLINE" });
      return [offline, online];
    })));
    expect(results.flat().every((result) => result.status === 200)).toBe(true);
    // Stations were ONLINE before the storm too, so require a snapshot broadcast after the last request completed.
    const afterStorm = clients.map((socket) => received.get(socket) ?? 0);
    await waitFor(() => clients.every((socket, index) => (received.get(socket) ?? 0) > afterStorm[index]!)
      && everyClientSees((snapshot) => snapshot.stations.every((station) => station.connection === "ONLINE")), 5_000, "post-storm ONLINE fan-out");
    metrics.tvReconnectStormMs = stormMs;
    metrics.tvReconnectRequestP95Ms = percentile(results.flat().map((result) => result.ms), 95);
    const perClient = clients.map((socket, index) => (received.get(socket) ?? 0) - before[index]!);
    metrics.snapshotsPerClientDuringTvStorm = Math.max(...perClient);
    expect(stormMs).toBeLessThan(5_000);
    // 100 state changes must be coalesced: roughly one broadcast per 50 ms window, never one per command.
    expect(Math.max(...perClient)).toBeLessThanOrEqual(Math.ceil(stormMs / 50) + 3);
  });

  it(`reconnects all ${CLIENTS} dashboards at once with a full snapshot each`, async () => {
    for (const socket of clients) socket.close();
    latest.clear();
    const [reconnected, reconnectMs] = await elapsed(() => Promise.all(Array.from({ length: CLIENTS }, connectClient)));
    clients = reconnected;
    metrics.dashboardReconnectStormMs = reconnectMs;
    expect(everyClientSees((snapshot) => snapshot.stations.length === STATIONS && snapshot.stations.every((station) => station.mode === "EXPIRED"))).toBe(true);
    expect(reconnectMs).toBeLessThan(5_000);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult, DeviceState, StationView, SystemSnapshot } from "@ps5-cafe/contracts";
import { MockTvAdapter } from "./adapters.js";
import { buildApp } from "./app.js";
import { FakeClock } from "./clock.js";
import { parseCommandTimeoutMs } from "./config.js";
import { AppDatabase } from "./database.js";
import { createSystem, DEFAULT_COMMAND_TIMEOUT_MS } from "./system.js";

/**
 * Bounded adapter calls. Domain time is a FakeClock; the per-call bound is wall-clock, so these tests either use
 * vitest fake timers for the 5 s default or inject a timeout of a few tens of milliseconds.
 */

const HOUR = 60 * 60_000;
const START_AT = 1_800_000_000_000;
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe("bounded adapter calls in the domain", () => {
  let db: AppDatabase;
  let clock: FakeClock;

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    clock = new FakeClock(START_AT);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    db.close();
  });

  const commandLog = (stationId = "ps5-01") => db.raw
    .prepare("SELECT command_type, outcome FROM command_log WHERE station_id = ? ORDER BY rowid")
    .all(stationId) as { command_type: string; outcome: string }[];

  it("(a) records TIMEOUT for a hung SWITCH_INPUT at the 5 s default, runs the END queued behind it, and discards the late answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const system = createSystem(db, true, 2, clock);
    await system.action("ps5-01", { type: "START", durationMs: HOUR });

    let answerLate!: () => void;
    const original = MockTvAdapter.prototype.switchInput;
    vi.spyOn(MockTvAdapter.prototype, "switchInput").mockImplementationOnce(async function (this: MockTvAdapter, input: string): Promise<CommandResult> {
      await new Promise<void>((resolve) => { answerLate = resolve; });
      return original.call(this, input);
    });

    let switchSettled = false;
    const switching = system.action("ps5-01", { type: "SWITCH_INPUT", input: "HDMI2" }).finally(() => { switchSettled = true; });
    const ending = system.action("ps5-01", { type: "END" });
    await vi.advanceTimersByTimeAsync(DEFAULT_COMMAND_TIMEOUT_MS - 1);
    expect(switchSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const [switched, ended] = await Promise.all([switching, ending]);
    expect(switched.lastCommand).toMatchObject({ outcome: "TIMEOUT", verified: false });
    expect(ended.session.status).toBe("ENDED");
    expect(ended.mode).toBe("IDLE");
    expect(ended.lastCommand?.outcome).toBe("SUCCESS");

    // The TV answers after the bound: the answer is not logged and does not replace the last command.
    answerLate();
    await vi.advanceTimersByTimeAsync(0);
    expect(commandLog()).toEqual([
      { command_type: "START", outcome: "SUCCESS" },
      { command_type: "SWITCH_INPUT", outcome: "TIMEOUT" },
      { command_type: "END", outcome: "SUCCESS" },
    ]);
    expect(system.snapshot().stations[0]!.lastCommand).toEqual(ended.lastCommand);
  });

  it("(b) a LOCK whose expired screen never answers leaves EXPIRED + FAILED, and SQLite holds the same", async () => {
    const system = createSystem(db, true, 2, clock, { commandTimeoutMs: 25 });
    await system.action("ps5-01", { type: "START", durationMs: 15 * 60_000 });
    vi.spyOn(MockTvAdapter.prototype, "enterExpiredMode").mockImplementation(() => never<CommandResult>());
    system.advanceSimulation(15 * 60_000);
    await system.reconcileExpired();

    const live = system.snapshot().stations[0]!;
    expect(live.session.status).toBe("EXPIRED");
    expect(live.mode).toBe("EXPIRED");
    expect(live.blockingStatus).toBe("FAILED");
    expect(live.lastCommand).toMatchObject({ outcome: "TIMEOUT", verified: false });

    const reloaded = createSystem(db, true, 2, clock).snapshot().stations[0]!;
    expect(reloaded.session.status).toBe("EXPIRED");
    expect(reloaded.blockingStatus).toBe("FAILED");
    expect(reloaded.lastCommand).toEqual(live.lastCommand);
  });

  it("turns a thrown adapter error into an unverified FAILURE with a bounded message", async () => {
    const system = createSystem(db, true, 2, clock, { commandTimeoutMs: 1_000 });
    vi.spyOn(MockTvAdapter.prototype, "switchInput").mockImplementation(() => { throw new Error(`socket hang up ${"x".repeat(5_000)}`); });
    const view = await system.action("ps5-01", { type: "SWITCH_INPUT", input: "HDMI3" });
    expect(view.lastCommand).toMatchObject({ outcome: "FAILURE", verified: false });
    expect(view.lastCommand!.message).toMatch(/^Cannot switch input: socket hang up x+\.\.\.$/);
    expect(view.lastCommand!.message.length).toBeLessThanOrEqual(200);
    expect(commandLog()).toEqual([{ command_type: "SWITCH_INPUT", outcome: "FAILURE" }]);
  });

  it.each<[string, () => Promise<DeviceState>]>([
    ["throws", () => Promise.reject(new Error("status endpoint down"))],
    ["never answers", () => never<DeviceState>()],
  ])("(d) persists the transition and keeps the previous device state when the readback %s", async (_label, readback) => {
    const system = createSystem(db, true, 2, clock, { commandTimeoutMs: 25 });
    const before = system.snapshot().stations[0]!.deviceState;
    vi.spyOn(MockTvAdapter.prototype, "getDeviceStatus").mockImplementation(readback);

    const view = await system.action("ps5-01", { type: "START", durationMs: HOUR });
    expect(view.session.status).toBe("ACTIVE");
    expect(view.lastCommand?.outcome).toBe("SUCCESS");
    expect(view.deviceState).toEqual(before);

    vi.restoreAllMocks();
    const reloaded = createSystem(db, true, 2, clock).snapshot().stations[0]!;
    expect(reloaded.session).toEqual(view.session);
    expect(reloaded.deviceState).toEqual(before);
  });

  it("restores memory to match SQLite when the commit itself fails, and the station keeps working", async () => {
    const system = createSystem(db, true, 2, clock);
    await system.action("ps5-01", { type: "START", durationMs: HOUR });
    const before = system.snapshot().stations[0]!;
    const persisted = () => db.raw.prepare(`
      SELECT s.status, s.deadline_at, st.mode, st.last_command_json FROM sessions s JOIN stations st ON st.id = s.station_id WHERE s.station_id = 'ps5-01'
    `).get();
    const persistedBefore = persisted();

    db.raw.exec("CREATE TRIGGER test_fail_command_log BEFORE INSERT ON command_log BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END");
    await expect(system.action("ps5-01", { type: "ADD_TIME", durationMs: 30 * 60_000 })).rejects.toThrow(/simulated disk failure/);
    expect(system.snapshot().stations[0]).toEqual(before);
    expect(persisted()).toEqual(persistedBefore);

    db.raw.exec("DROP TRIGGER test_fail_command_log");
    const extended = await system.action("ps5-01", { type: "ADD_TIME", durationMs: 30 * 60_000 });
    expect(extended.session.deadlineAt).toBe(before.session.deadlineAt! + 30 * 60_000);
  });

  it("rejects a non-positive injected command timeout", () => {
    expect(() => createSystem(db, true, 1, clock, { commandTimeoutMs: 0 })).toThrow(/commandTimeoutMs/);
    expect(() => createSystem(db, true, 1, clock, { commandTimeoutMs: 1.5 })).toThrow(/commandTimeoutMs/);
  });
});

describe("bounded adapter calls over HTTP", () => {
  const TOKEN = "timeout-test-token";
  const auth = { authorization: `Bearer ${TOKEN}` };
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps5-cafe-timeout-")); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(c) a throwing enterGamingMode during ADD_TIME returns 200 FAILURE, memory matches SQLite, and a same-key retry replays", async () => {
    const databasePath = path.join(dir, "cafe.sqlite");
    const clock = new FakeClock(START_AT);
    const app = await buildApp({ databasePath, apiToken: TOKEN, simulationMode: true, stationCount: 2, clock });
    try {
      const post = (body: object, key: string) => app.inject({
        method: "POST", url: "/api/stations/ps5-01/actions", headers: { ...auth, "idempotency-key": key }, payload: body,
      });
      const memory = async () => (await app.inject({ method: "GET", url: "/api/snapshot", headers: auth })).json<SystemSnapshot>().stations[0]!;
      expect((await post({ type: "START", durationMs: HOUR }, "timeout-start-0001")).statusCode).toBe(200);

      vi.spyOn(MockTvAdapter.prototype, "enterGamingMode").mockRejectedValueOnce(new Error("adapter exploded"));
      const extend = await post({ type: "ADD_TIME", durationMs: 30 * 60_000 }, "timeout-extend-0001");
      expect(extend.statusCode).toBe(200);
      const view = extend.json<StationView>();
      expect(view.lastCommand).toMatchObject({ outcome: "FAILURE", verified: false });
      expect(view.lastCommand!.message).toContain("adapter exploded");
      const expectedDeadline = START_AT + 90 * 60_000;
      expect(view.session.deadlineAt).toBe(expectedDeadline);

      const file = new Database(databasePath, { readonly: true });
      try {
        expect(file.prepare("SELECT deadline_at FROM sessions WHERE station_id = 'ps5-01'").get()).toEqual({ deadline_at: (await memory()).session.deadlineAt });
        expect(file.prepare("SELECT command_type, outcome FROM command_log WHERE station_id = 'ps5-01' ORDER BY rowid").all()).toEqual([
          { command_type: "START", outcome: "SUCCESS" },
          { command_type: "ADD_TIME", outcome: "FAILURE" },
        ]);
      } finally {
        file.close();
      }

      clock.advance(1_000);
      const retry = await post({ type: "ADD_TIME", durationMs: 30 * 60_000 }, "timeout-extend-0001");
      expect(retry.statusCode).toBe(200);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect(retry.json()).toEqual(extend.json());
      expect((await memory()).session.deadlineAt).toBe(expectedDeadline);
    } finally {
      await app.close();
    }
  });

  it("(e) a simulation advance with one hung TV answers within the timeout plus slack and locks the other stations", async () => {
    const COMMAND_TIMEOUT_MS = 100;
    const app = await buildApp({
      databasePath: ":memory:", apiToken: TOKEN, simulationMode: true, stationCount: 10, clock: new FakeClock(START_AT), commandTimeoutMs: COMMAND_TIMEOUT_MS,
    });
    try {
      for (let number = 1; number <= 10; number += 1) {
        const response = await app.inject({
          method: "POST", url: `/api/stations/ps5-${String(number).padStart(2, "0")}/actions`,
          headers: { ...auth, "idempotency-key": `timeout-start-${number}-key` }, payload: { type: "START", durationMs: HOUR },
        });
        expect(response.statusCode).toBe(200);
      }
      const original = MockTvAdapter.prototype.enterExpiredMode;
      let calls = 0;
      vi.spyOn(MockTvAdapter.prototype, "enterExpiredMode").mockImplementation(function (this: MockTvAdapter): Promise<CommandResult> {
        calls += 1;
        return calls === 1 ? never<CommandResult>() : original.call(this);
      });

      const started = performance.now();
      const response = await app.inject({
        method: "POST", url: "/api/simulation/advance", headers: { ...auth, "idempotency-key": "timeout-advance-0001" }, payload: { durationMs: HOUR },
      });
      const elapsedMs = performance.now() - started;
      expect(response.statusCode).toBe(200);
      expect(elapsedMs).toBeGreaterThanOrEqual(COMMAND_TIMEOUT_MS - 5);
      expect(elapsedMs).toBeLessThan(COMMAND_TIMEOUT_MS + 1_500);

      const stations = response.json<SystemSnapshot>().stations;
      expect(stations.every((station) => station.session.status === "EXPIRED" && station.mode === "EXPIRED")).toBe(true);
      const hung = stations.filter((station) => station.lastCommand?.outcome === "TIMEOUT");
      expect(hung).toHaveLength(1);
      expect(hung[0]!.blockingStatus).toBe("FAILED");
      expect(stations.filter((station) => station.blockingStatus === "CONFIRMED")).toHaveLength(9);
    } finally {
      await app.close();
    }
  });
});

describe("PS5_CAFE_COMMAND_TIMEOUT_MS", () => {
  it.each<[string | undefined, number | undefined]>([
    [undefined, undefined],
    ["", undefined],
    ["   ", undefined],
    ["100", 100],
    ["5000", 5_000],
    ["60000", 60_000],
  ])("parses %j as %j", (raw, expected) => {
    expect(parseCommandTimeoutMs(raw)).toBe(expected);
  });

  it.each(["99", "60001", "0", "-5", "1.5", "1e3", "abc", "5000ms"])("rejects %j", (raw) => {
    expect(() => parseCommandTimeoutMs(raw)).toThrow(/PS5_CAFE_COMMAND_TIMEOUT_MS/);
  });
});

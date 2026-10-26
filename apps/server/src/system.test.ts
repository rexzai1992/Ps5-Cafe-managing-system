import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockingStatus, CommandOutcome, CommandResult, StationAction } from "@ps5-cafe/contracts";
import { MockTvAdapter, UnverifiedTvAdapter } from "./adapters.js";
import { AppDatabase } from "./database.js";
import { ActionRejectedError, createSystem, StationNotFoundError, TvManagementSystem } from "./system.js";
import { FakeClock } from "./clock.js";

describe("server-authoritative simulation", () => {
  let db: AppDatabase;
  let system: TvManagementSystem;
  let clock: FakeClock;

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    clock = new FakeClock(1_800_000_000_000);
    system = createSystem(db, true, 10, clock);
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  const station = (id = "ps5-01") => system.snapshot().stations.find((candidate) => candidate.id === id)!;
  const commandLog = (id = "ps5-01") => db.raw
    .prepare("SELECT command_type, outcome FROM command_log WHERE station_id = ? ORDER BY rowid")
    .all(id) as { command_type: string; outcome: string }[];
  const lockRows = () => (db.raw.prepare("SELECT COUNT(*) AS count FROM command_log WHERE command_type = 'LOCK'").get() as { count: number }).count;
  const isExpiring = (id: string) => (system as unknown as { expiring: Set<string> }).expiring.has(id);

  /** Holds every switchInput call until released, so later commands queue behind it deterministically. */
  function holdSwitchInput(): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = MockTvAdapter.prototype.switchInput;
    vi.spyOn(MockTvAdapter.prototype, "switchInput").mockImplementation(async function (this: MockTvAdapter, input: string): Promise<CommandResult> {
      await gate;
      return original.call(this, input);
    });
    return release;
  }

  it("creates ten isolated virtual stations", () => {
    const snapshot = system.snapshot();
    expect(snapshot.stations).toHaveLength(10);
    expect(snapshot.stations.every((station) => station.simulated && station.mode === "IDLE")).toBe(true);
  });

  it("starts, pauses, resumes, and extends a session", async () => {
    await system.action("ps5-01", { type: "START", durationMs: 60 * 60_000 });
    system.advanceSimulation(10 * 60_000);
    await system.action("ps5-01", { type: "PAUSE" });
    const paused = system.snapshot().stations[0]!;
    expect(paused.session.status).toBe("PAUSED");
    expect(paused.session.remainingMs).toBe(50 * 60_000);
    await system.action("ps5-01", { type: "ADD_TIME", durationMs: 30 * 60_000 });
    await system.action("ps5-01", { type: "RESUME" });
    expect(system.snapshot().stations[0]!.session.remainingMs).toBe(80 * 60_000);
  });

  it("expires and verifies the simulated expired screen", async () => {
    await system.action("ps5-01", { type: "START", durationMs: 15 * 60_000 });
    system.advanceSimulation(15 * 60_000);
    await system.reconcileExpired();
    const station = system.snapshot().stations[0]!;
    expect(station.mode).toBe("EXPIRED");
    expect(station.blockingStatus).toBe("CONFIRMED");
    expect(station.deviceState.displayedMode).toBe("EXPIRED");
  });

  it("reports a failed block when the TV is offline", async () => {
    await system.action("ps5-01", { type: "SET_CONNECTION", connection: "OFFLINE" });
    await system.action("ps5-01", { type: "LOCK" });
    expect(system.snapshot().stations[0]!.blockingStatus).toBe("FAILED");
  });

  it("keeps another station responsive when one station fails", async () => {
    await system.action("ps5-01", { type: "SIMULATE_NEXT_FAILURE" });
    await Promise.all([
      system.action("ps5-01", { type: "START", durationMs: 60_000 }),
      system.action("ps5-02", { type: "START", durationMs: 60_000 }),
    ]);
    const [first, second] = system.snapshot().stations;
    expect(first!.lastCommand?.outcome).toBe("FAILURE");
    expect(second!.lastCommand?.outcome).toBe("SUCCESS");
  });

  it("rejects an invalid action to the caller and keeps the station queue draining", async () => {
    await expect(system.action("ps5-01", { type: "PAUSE" })).rejects.toBeInstanceOf(ActionRejectedError);
    await expect(system.action("ps5-99", { type: "LOCK" })).rejects.toBeInstanceOf(StationNotFoundError);
    const started = await system.action("ps5-01", { type: "START", durationMs: 60_000 });
    expect(started.session.status).toBe("ACTIVE");
  });

  it("restores persisted active sessions after reconstruction", async () => {
    await system.action("ps5-01", { type: "START", durationMs: 60 * 60_000 });
    system.advanceSimulation(5 * 60_000);
    const restored = createSystem(db, true, 10, clock);
    const station = restored.snapshot().stations[0]!;
    expect(station.session.status).toBe("ACTIVE");
    expect(station.session.remainingMs).toBeGreaterThan(54 * 60_000);
    expect(station.session.remainingMs).toBeLessThanOrEqual(55 * 60_000);
  });

  it("changes SET_REMAINING without any adapter command or command-log row", async () => {
    await system.action("ps5-01", { type: "START", durationMs: 60 * 60_000 });
    const before = station();
    const logBefore = commandLog();
    const deviceCalls = (["enterGamingMode", "enterIdleMode", "enterExpiredMode", "switchInput", "sendRemoteKey", "connect", "disconnect"] as const)
      .map((method) => vi.spyOn(MockTvAdapter.prototype, method));
    clock.advance(60_000);
    const after = await system.action("ps5-01", { type: "SET_REMAINING", durationMs: 2 * 60 * 60_000 });
    expect(deviceCalls.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(commandLog()).toEqual(logBefore);
    expect(after.session.deadlineAt).toBe(clock.now() + 2 * 60 * 60_000);
    expect(after).toMatchObject({ mode: before.mode, blockingStatus: before.blockingStatus, lastCommand: before.lastCommand });
  });

  describe("expiry re-checks the deadline when its LOCK reaches the head of the queue", () => {
    /** START 1m, let it run out, queue a slow SWITCH_INPUT and `queued` behind it, then tick before either runs. */
    async function tickBehind(queued: StationAction | null): Promise<void> {
      await system.action("ps5-01", { type: "START", durationMs: 60_000 });
      clock.advance(60_000);
      const release = holdSwitchInput();
      const work = [system.action("ps5-01", { type: "SWITCH_INPUT", input: "HDMI2" })];
      if (queued) work.push(system.action("ps5-01", queued));
      const tick = system.reconcileExpired();
      // The tick saw an overdue ACTIVE session and queued an expiry task behind the commands above.
      expect(isExpiring("ps5-01")).toBe(true);
      release();
      await Promise.all([...work, tick]);
      expect(isExpiring("ps5-01")).toBe(false);
    }

    it("keeps a paid extension queued ahead of the tick", async () => {
      await tickBehind({ type: "ADD_TIME", durationMs: 30 * 60_000 });
      const view = station();
      expect(view.session.status).toBe("ACTIVE");
      expect(view.mode).toBe("PLAYING");
      expect(view.session.remainingMs).toBe(30 * 60_000);
      expect(lockRows()).toBe(0);
    });

    it("keeps a SET_REMAINING queued ahead of the tick", async () => {
      await tickBehind({ type: "SET_REMAINING", durationMs: 10 * 60_000 });
      expect(station().session).toMatchObject({ status: "ACTIVE", remainingMs: 10 * 60_000 });
      expect(lockRows()).toBe(0);
    });

    it("does not lock a session ended ahead of the tick", async () => {
      await tickBehind({ type: "END" });
      expect(station()).toMatchObject({ mode: "IDLE", session: { status: "ENDED" } });
      expect(lockRows()).toBe(0);
    });

    it("does not lock a session paused ahead of the tick", async () => {
      await tickBehind({ type: "PAUSE" });
      expect(station().session.status).toBe("PAUSED");
      expect(lockRows()).toBe(0);
    });

    it("still locks when nothing queued ahead changed the deadline", async () => {
      await tickBehind(null);
      expect(station()).toMatchObject({ mode: "EXPIRED", blockingStatus: "CONFIRMED", session: { status: "EXPIRED" } });
      expect(lockRows()).toBe(1);
    });

    it("keeps an operator LOCK unconditional", async () => {
      await system.action("ps5-01", { type: "START", durationMs: 60 * 60_000 });
      await system.action("ps5-01", { type: "LOCK" });
      expect(station()).toMatchObject({ mode: "EXPIRED", session: { status: "EXPIRED" } });
      expect(lockRows()).toBe(1);
    });
  });

  describe("truthful expired-screen evidence (simulation only)", () => {
    it("reports FAILED with outcome UNSUPPORTED when the TV cannot show the expired screen", async () => {
      await system.action("ps5-01", { type: "SIMULATE_UNSUPPORTED", enabled: true });
      const view = await system.action("ps5-01", { type: "LOCK" });
      expect(view.lastCommand?.outcome).toBe("UNSUPPORTED");
      expect(view.blockingStatus).toBe("FAILED");
    });

    it("turns CONFIRMED into FAILED after an input switch bypasses the expired screen, until a new LOCK", async () => {
      await system.action("ps5-01", { type: "START", durationMs: 15 * 60_000 });
      system.advanceSimulation(15 * 60_000);
      await system.reconcileExpired();
      expect(station().blockingStatus).toBe("CONFIRMED");

      const bypassed = await system.action("ps5-01", { type: "SWITCH_INPUT", input: "HDMI1" });
      expect(bypassed.lastCommand?.outcome).toBe("SUCCESS");
      expect(bypassed.deviceState.displayedMode).toBe("PLAYING");
      expect(bypassed.mode).toBe("EXPIRED");
      expect(bypassed.blockingStatus).toBe("FAILED");
      // A harmless command afterwards does not restore the claim.
      expect((await system.action("ps5-01", { type: "REMOTE_KEY", key: "OK" })).blockingStatus).toBe("FAILED");

      const relocked = await system.action("ps5-01", { type: "LOCK" });
      expect(relocked.blockingStatus).toBe("CONFIRMED");
      expect(relocked.deviceState.displayedMode).toBe("EXPIRED");
    });

    it("reports UNVERIFIED for a bypass on a TV that cannot verify its state", async () => {
      await system.action("ps5-01", { type: "LOCK" });
      expect(station().blockingStatus).toBe("CONFIRMED");
      await system.action("ps5-01", { type: "SIMULATE_UNSUPPORTED", enabled: true });
      const original = MockTvAdapter.prototype.getDeviceStatus;
      vi.spyOn(MockTvAdapter.prototype, "getDeviceStatus").mockImplementationOnce(async function (this: MockTvAdapter) {
        return { ...(await original.call(this)), displayedMode: "PLAYING" };
      });
      const view = await system.action("ps5-01", { type: "REMOTE_KEY", key: "HOME" });
      expect(view.capabilities.stateVerification).toBe(false);
      expect(view.blockingStatus).toBe("UNVERIFIED");
    });

    it("stops claiming CONFIRMED when the readback after a command on an expired TV fails", async () => {
      await system.action("ps5-01", { type: "LOCK" });
      vi.spyOn(MockTvAdapter.prototype, "getDeviceStatus").mockRejectedValueOnce(new Error("status unavailable"));
      expect((await system.action("ps5-01", { type: "REMOTE_KEY", key: "OK" })).blockingStatus).toBe("UNVERIFIED");
    });

    it.each<[CommandOutcome, boolean, BlockingStatus]>([
      ["SUCCESS", true, "CONFIRMED"],
      ["SUCCESS", false, "UNVERIFIED"],
      ["UNVERIFIED", false, "UNVERIFIED"],
      ["UNSUPPORTED", false, "FAILED"],
      ["FAILURE", false, "FAILED"],
      ["TIMEOUT", false, "FAILED"],
      ["DEVICE_OFFLINE", false, "FAILED"],
    ])("maps a LOCK result of %s (verified=%s) to %s", async (outcome, verified, expected) => {
      vi.spyOn(MockTvAdapter.prototype, "enterExpiredMode").mockResolvedValueOnce({
        commandId: randomUUID(), outcome, verified, message: `test ${outcome}`, completedAt: clock.now(),
      });
      expect((await system.action("ps5-01", { type: "LOCK" })).blockingStatus).toBe(expected);
    });

    it("never reports a verified disconnect from an unverified adapter", async () => {
      const result = await new UnverifiedTvAdapter("android-tv", clock).disconnect();
      expect(result.outcome).toBe("UNSUPPORTED");
      expect(result.verified).toBe(false);
    });

    it("rejects a CONNECTING request in the domain as well", async () => {
      await expect(system.action("ps5-01", { type: "SET_CONNECTION", connection: "CONNECTING" })).rejects.toBeInstanceOf(ActionRejectedError);
      expect(station().connection).toBe("ONLINE");
    });
  });
});

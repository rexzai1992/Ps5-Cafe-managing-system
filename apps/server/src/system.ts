import { randomUUID } from "node:crypto";
import type {
  BlockingStatus, CommandOutcome, CommandResult, DeviceState, StationAction, StationView, SystemSnapshot,
} from "@ps5-cafe/contracts";
import type { Clock } from "./clock.js";
import { AdjustableClock, SystemClock } from "./clock.js";
import type { AppDatabase, SessionRow, StationRow } from "./database.js";
import { MockTvAdapter, type RemoteControl, ScreenOnlyAdapter, type TvAdapter } from "./adapters.js";

/** The requested station does not exist. */
export class StationNotFoundError extends Error {
  public constructor(stationId: string) { super(`Station not found: ${stationId}`); }
}

/** The action is not valid for the station's current state or arguments. */
export class ActionRejectedError extends Error {}

const BROADCAST_INTERVAL_MS = 50;
/** Default upper bound for one adapter call, in wall-clock milliseconds. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const MIN_SESSION_MS = 60_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_FAILURE_MESSAGE_LENGTH = 200;

export interface SystemOptions {
  /** The owner's opt-in remote control per live TV (looked up on every use, so assignments apply at once). */
  remoteFor?: ((stationId: string) => RemoteControl | null) | undefined;
  /**
   * Upper bound for each adapter call, in wall-clock milliseconds (domain time stays on the injected clock).
   * A call that exceeds it is recorded as TIMEOUT. Defaults to DEFAULT_COMMAND_TIMEOUT_MS.
   */
  commandTimeoutMs?: number | undefined;
}

/** Per-station data owned elsewhere (QR reservations, screen polls). Live mode also derives connection and evidence there. */
export type ViewExtension = (stationId: string, base: StationView) =>
  Partial<Pick<StationView, "reservation" | "screenSeenAt" | "screenOnline" | "connection" | "blockingStatus" | "remote">>;

type Bounded<T> = { status: "ok"; value: T } | { status: "timeout" } | { status: "error"; error: unknown };

interface RuntimeStation {
  row: StationRow;
  session: SessionRow;
  adapter: TvAdapter;
  /** The same adapter when the TV is simulated; simulation controls need it. */
  mock: MockTvAdapter | null;
  queue: Promise<void>;
}

export class TvManagementSystem {
  private readonly stations = new Map<string, RuntimeStation>();
  /** Stations with an expiry task already queued; overlapping ticks must not queue another. */
  private readonly expiring = new Set<string>();
  private onChange: ((snapshot: SystemSnapshot) => void) | null = null;
  /** Adds per-station data owned elsewhere (QR reservations, screen polls) to every station view. */
  private extend: ViewExtension | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private lastBroadcastAt = Number.NEGATIVE_INFINITY;
  private closed = false;
  private readonly commandTimeoutMs: number;
  private readonly remoteFor: (stationId: string) => RemoteControl | null;
  private readonly commitTransition: (runtime: RuntimeStation, type: StationAction["type"], command: CommandResult | null) => void;

  public constructor(
    private readonly db: AppDatabase,
    private readonly clock: AdjustableClock,
    private readonly simulationMode: boolean,
    stationCount: number,
    options: SystemOptions = {},
  ) {
    const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("commandTimeoutMs must be a positive integer");
    this.commandTimeoutMs = timeoutMs;
    this.remoteFor = options.remoteFor ?? (() => null);
    // Simulated and real TVs never share a database: a mixed file would let simulation state leak into the café.
    const kind = simulationMode ? "mock" : "screen-only";
    const kinds = (db.raw.prepare("SELECT DISTINCT adapter_kind FROM stations").all() as { adapter_kind: string }[]).map((r) => r.adapter_kind);
    if (kinds.some((existing) => existing !== kind)) {
      throw new Error(simulationMode
        ? "This database holds the café's live TVs; run the simulation with its own PS5_CAFE_DB_PATH"
        : "This database holds simulated TVs; live mode needs its own PS5_CAFE_DB_PATH");
    }
    db.seedStations(stationCount, kind);

    const insertCommand = db.raw.prepare(`
      INSERT INTO command_log(id, station_id, command_type, outcome, message, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const updateStation = db.raw.prepare(`
      UPDATE stations SET connection=?, mode=?, blocking_status=?, hdmi_input=?, device_state_json=?, last_command_json=? WHERE id=?
    `);
    const updateSession = db.raw.prepare(`
      UPDATE sessions SET status=?, started_at=?, deadline_at=?, paused_remaining_ms=? WHERE station_id=?
    `);
    // The command log row and the station/session rows commit together or not at all.
    this.commitTransition = db.raw.transaction((runtime: RuntimeStation, type: StationAction["type"], command: CommandResult | null) => {
      const { row, session } = runtime;
      if (command) {
        row.last_command_json = JSON.stringify(command);
        insertCommand.run(command.commandId, row.id, type, command.outcome, command.message, command.completedAt);
      }
      updateStation.run(row.connection, row.mode, row.blocking_status, row.hdmi_input, row.device_state_json, row.last_command_json, row.id);
      updateSession.run(session.status, session.started_at, session.deadline_at, session.paused_remaining_ms, session.station_id);
    });
    this.load();
  }

  private load(): void {
    const rows = this.db.raw.prepare("SELECT * FROM stations ORDER BY station_number").all() as StationRow[];
    const sessions = this.db.raw.prepare("SELECT * FROM sessions").all() as SessionRow[];
    const byStation = new Map(sessions.map((session) => [session.station_id, session]));
    for (const row of rows) {
      const session = byStation.get(row.id);
      if (!session) throw new Error(`Missing session row for ${row.id}`);
      const mock = row.adapter_kind === "mock" ? new MockTvAdapter(this.clock, JSON.parse(row.device_state_json) as DeviceState) : null;
      mock?.setConnection(row.connection);
      const adapter = mock ?? new ScreenOnlyAdapter(this.clock, () => this.remoteFor(row.id));
      this.stations.set(row.id, { row, session, adapter, mock, queue: Promise.resolve() });
    }
  }

  subscribe(callback: (snapshot: SystemSnapshot) => void): () => void {
    this.onChange = callback;
    return () => { if (this.onChange === callback) this.onChange = null; };
  }

  /** Domain time: the injected clock plus the persisted simulation offset. */
  now(): number { return this.clock.now(); }

  stationIds(): string[] { return [...this.stations.keys()]; }

  /** One station's current view, or throws StationNotFoundError. */
  viewOf(stationId: string): StationView {
    const runtime = this.stations.get(stationId);
    if (!runtime) throw new StationNotFoundError(stationId);
    return this.view(runtime, this.clock.now());
  }

  setViewExtension(extend: ViewExtension): void { this.extend = extend; }

  /** State owned outside the queues changed (e.g. a reservation); push a fresh snapshot to dashboards. */
  notifyChanged(): void { this.emit(); }

  snapshot(): SystemSnapshot {
    const now = this.clock.now();
    return {
      serverTime: now,
      simulationMode: this.simulationMode,
      acceleratedByMs: this.clock.getOffset(),
      stations: [...this.stations.values()].map((runtime) => this.view(runtime, now)),
    };
  }

  private view({ row, session, adapter }: RuntimeStation, now: number): StationView {
    const base: StationView = {
      id: row.id,
      number: row.station_number,
      name: row.name,
      adapterKind: row.adapter_kind,
      simulated: Boolean(row.simulated),
      connection: row.connection,
      mode: row.mode,
      blockingStatus: row.blocking_status,
      hdmiInput: row.hdmi_input,
      capabilities: adapter.getCapabilities(),
      deviceState: JSON.parse(row.device_state_json) as DeviceState,
      session: {
        status: session.status,
        startedAt: session.started_at,
        deadlineAt: session.deadline_at,
        pausedRemainingMs: session.paused_remaining_ms,
        remainingMs: this.remaining(session, now),
      },
      lastCommand: row.last_command_json ? JSON.parse(row.last_command_json) as CommandResult : null,
    };
    return this.extend ? { ...base, ...this.extend(row.id, base) } : base;
  }

  private remaining(session: SessionRow, now = this.clock.now()): number {
    if (session.status === "PAUSED") return Math.max(0, session.paused_remaining_ms ?? 0);
    if (session.status === "ACTIVE" && session.deadline_at !== null) return Math.max(0, session.deadline_at - now);
    return 0;
  }

  private isDue({ session }: RuntimeStation, now: number): boolean {
    return session.status === "ACTIVE" && session.deadline_at !== null && session.deadline_at <= now;
  }

  async reconcileExpired(): Promise<void> {
    const now = this.clock.now();
    const due = [...this.stations.values()].filter((runtime) => this.isDue(runtime, now) && !this.expiring.has(runtime.row.id));
    for (const { row } of due) this.expiring.add(row.id);
    // One station's failure must not reject the tick or stop other stations from locking.
    await Promise.allSettled(due.map((runtime) =>
      this.enqueue(runtime, () => this.expireIfStillDue(runtime)).finally(() => this.expiring.delete(runtime.row.id))));
    this.emit();
  }

  /**
   * The tick only decides that a LOCK may be due. Commands queued ahead of it (ADD_TIME, SET_REMAINING, END, PAUSE)
   * can change that, so the deadline is re-checked when the task reaches the head of the station queue. An operator
   * LOCK through the API stays unconditional.
   */
  private async expireIfStillDue(runtime: RuntimeStation): Promise<void> {
    if (!this.isDue(runtime, this.clock.now())) return;
    await this.execute(runtime, { type: "LOCK" });
  }

  async action(stationId: string, action: StationAction): Promise<StationView> {
    const runtime = this.stations.get(stationId);
    if (!runtime) throw new StationNotFoundError(stationId);
    await this.enqueue(runtime, () => this.execute(runtime, action));
    this.emit();
    return this.view(runtime, this.clock.now());
  }

  /** Serialises work per station. The queue keeps draining after a rejection; the caller still receives the error. */
  private enqueue<T>(runtime: RuntimeStation, work: () => Promise<T>): Promise<T> {
    const completed = runtime.queue.then(work);
    runtime.queue = completed.then(() => undefined, () => undefined);
    return completed;
  }

  /**
   * Waits until every station queue is idle, for at most boundMs of wall-clock time. Work enqueued while waiting is
   * included. Returns false if the bound was reached first.
   */
  async drain(boundMs: number): Promise<boolean> {
    const deadline = performance.now() + boundMs;
    for (;;) {
      const tails = [...this.stations.values()].map((runtime) => runtime.queue);
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const idle = await Promise.race([
        Promise.all(tails).then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), remainingMs); }),
      ]);
      clearTimeout(timer);
      if (!idle) return false;
      if ([...this.stations.values()].every((runtime, index) => runtime.queue === tails[index])) return true;
    }
  }

  /**
   * Runs one action. In-memory row/session changes are restored from copies if anything throws before the commit
   * finishes (a rejected action, or SQLite itself), so memory always matches SQLite.
   */
  private async execute(runtime: RuntimeStation, action: StationAction): Promise<void> {
    if (this.closed) throw new Error("Server is shutting down");
    const rowBefore = { ...runtime.row };
    const sessionBefore = { ...runtime.session };
    try {
      await this.transition(runtime, action);
    } catch (error) {
      Object.assign(runtime.row, rowBefore);
      Object.assign(runtime.session, sessionBefore);
      runtime.mock?.setConnection(runtime.row.connection);
      throw error;
    }
  }

  private async transition(runtime: RuntimeStation, action: StationAction): Promise<void> {
    const now = this.clock.now();
    const { row, session, adapter } = runtime;
    let command: CommandResult | null = null;

    switch (action.type) {
      case "START": {
        this.requireSessionDuration(action.durationMs);
        if (session.status === "ACTIVE" || session.status === "PAUSED") {
          throw new ActionRejectedError("Session already running; use ADD_TIME or SET_REMAINING");
        }
        session.status = "ACTIVE";
        session.started_at = now;
        session.deadline_at = now + action.durationMs;
        session.paused_remaining_ms = null;
        row.mode = "PLAYING";
        row.blocking_status = "NOT_APPLICABLE";
        command = await this.command("enter gaming mode", () => adapter.enterGamingMode(row.hdmi_input));
        break;
      }
      case "PAUSE": {
        if (session.status !== "ACTIVE") throw new ActionRejectedError("Only an active session can be paused");
        session.paused_remaining_ms = this.remaining(session, now);
        session.deadline_at = null;
        session.status = "PAUSED";
        break;
      }
      case "RESUME": {
        if (session.status !== "PAUSED") throw new ActionRejectedError("Only a paused session can be resumed");
        session.deadline_at = now + (session.paused_remaining_ms ?? 0);
        session.paused_remaining_ms = null;
        session.status = "ACTIVE";
        row.mode = "PLAYING";
        row.blocking_status = "NOT_APPLICABLE";
        command = await this.command("enter gaming mode", () => adapter.enterGamingMode(row.hdmi_input));
        break;
      }
      case "ADD_TIME": {
        this.requireSessionDuration(action.durationMs);
        if (!["ACTIVE", "PAUSED", "EXPIRED"].includes(session.status)) throw new ActionRejectedError("No session to extend");
        if (session.status === "PAUSED") session.paused_remaining_ms = (session.paused_remaining_ms ?? 0) + action.durationMs;
        else {
          session.status = "ACTIVE";
          session.deadline_at = Math.max(now, session.deadline_at ?? now) + action.durationMs;
          session.paused_remaining_ms = null;
          row.mode = "PLAYING";
          row.blocking_status = "NOT_APPLICABLE";
          command = await this.command("enter gaming mode", () => adapter.enterGamingMode(row.hdmi_input));
        }
        break;
      }
      case "SET_REMAINING": {
        // Only the clock changes: mode, blocking evidence and the TV are left alone.
        this.requireSessionDuration(action.durationMs);
        if (session.status === "PAUSED") session.paused_remaining_ms = action.durationMs;
        else if (session.status === "ACTIVE") session.deadline_at = now + action.durationMs;
        else throw new ActionRejectedError("Only an active or paused session can have its remaining time set");
        break;
      }
      case "END":
      case "SHOW_ADVERTISING": {
        if (action.type === "SHOW_ADVERTISING" && (session.status === "ACTIVE" || session.status === "PAUSED")) {
          throw new ActionRejectedError("End the session before showing advertising");
        }
        if (action.type === "END") session.status = "ENDED";
        session.deadline_at = null;
        session.paused_remaining_ms = null;
        row.mode = "IDLE";
        row.blocking_status = "NOT_APPLICABLE";
        command = await this.command("enter idle mode", () => adapter.enterIdleMode());
        break;
      }
      case "LOCK": {
        session.status = "EXPIRED";
        session.deadline_at = null;
        session.paused_remaining_ms = null;
        row.mode = "EXPIRED";
        row.blocking_status = "PENDING";
        command = await this.command("enter expired mode", () => adapter.enterExpiredMode());
        row.blocking_status = this.blockingStatus(command);
        break;
      }
      case "SWITCH_INPUT": command = await this.command("switch input", () => adapter.switchInput(action.input)); break;
      case "REMOTE_KEY": command = await this.command(`send ${action.key}`, () => adapter.sendRemoteKey(action.key)); break;
      case "REMOTE_TAP": command = await this.command("touch the screen", () => adapter.tap(action.x, action.y)); break;
      case "SET_CONNECTION": {
        const mock = this.simulated(runtime);
        if (action.connection !== "ONLINE" && action.connection !== "OFFLINE") {
          throw new ActionRejectedError("connection must be ONLINE or OFFLINE");
        }
        row.connection = action.connection;
        mock.setConnection(action.connection);
        command = action.connection === "ONLINE"
          ? await this.command("connect", () => mock.connect())
          : await this.command("disconnect", () => mock.disconnect());
        break;
      }
      case "SIMULATE_NEXT_FAILURE": this.simulated(runtime).simulateNextFailure(); break;
      case "SIMULATE_UNSUPPORTED": this.simulated(runtime).simulateUnsupported(action.enabled); break;
    }

    // A failed or timed-out readback keeps the previous device state and never aborts the transition.
    const readback = await this.bounded(() => adapter.getDeviceStatus());
    const deviceState = readback.status === "ok" ? readback.value : null;
    if (deviceState) row.device_state_json = JSON.stringify(deviceState);
    if (action.type !== "LOCK" && row.mode === "EXPIRED") this.rederiveExpiredBlocking(row, adapter, deviceState);
    if (this.closed) throw new Error("Server is shutting down; the transition was not persisted");
    this.commitTransition(runtime, action.type, command);
  }

  /**
   * After any non-LOCK command on an expired TV, the blocking evidence follows the readback: a TV that no longer shows
   * the expired screen (for example after an input switch) is FAILED when the adapter can verify state, otherwise
   * UNVERIFIED. Evidence is only ever downgraded here; only a new LOCK can confirm the screen again.
   */
  private rederiveExpiredBlocking(row: StationRow, adapter: TvAdapter, readback: DeviceState | null): void {
    if (row.blocking_status === "FAILED") return;
    if (readback === null) {
      if (row.blocking_status === "CONFIRMED") row.blocking_status = "UNVERIFIED";
      return;
    }
    if (readback.displayedMode !== "EXPIRED") row.blocking_status = adapter.getCapabilities().stateVerification ? "FAILED" : "UNVERIFIED";
  }

  /**
   * Bounds one adapter call. Every adapter call made by a transition goes through here. A result that arrives after the
   * timeout is discarded and never recorded. Real adapters will need an AbortSignal (Phase 4) so that the underlying
   * network call is cancelled too; today a late mock result simply settles into nothing.
   */
  private async bounded<T>(call: () => Promise<T>): Promise<Bounded<T>> {
    let pending: Promise<T>;
    try { pending = Promise.resolve(call()); } catch (error) { return { status: "error", error }; }
    // `settled` never rejects, so a late failure after the timeout cannot become an unhandled rejection.
    const settled = pending.then((value): Bounded<T> => ({ status: "ok", value }), (error: unknown): Bounded<T> => ({ status: "error", error }));
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<Bounded<T>>((resolve) => { timer = setTimeout(() => resolve({ status: "timeout" }), this.commandTimeoutMs); });
    try {
      return await Promise.race([settled, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs an adapter command through `bounded`; a timeout becomes TIMEOUT and a thrown error FAILURE, both unverified. */
  private async command(label: string, call: () => Promise<CommandResult>): Promise<CommandResult> {
    const result = await this.bounded(call);
    if (result.status === "ok") return result.value;
    if (result.status === "timeout") {
      return this.localResult("TIMEOUT", `Cannot ${label}: no answer within ${this.commandTimeoutMs} ms; TV state unknown`);
    }
    const detail = result.error instanceof Error ? result.error.message : String(result.error);
    const message = `Cannot ${label}: ${detail}`;
    return this.localResult("FAILURE", message.length > MAX_FAILURE_MESSAGE_LENGTH ? `${message.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 3)}...` : message);
  }

  private localResult(outcome: Extract<CommandOutcome, "TIMEOUT" | "FAILURE">, message: string): CommandResult {
    return { commandId: randomUUID(), outcome, message, verified: false, completedAt: this.clock.now() };
  }

  advanceSimulation(durationMs: number): SystemSnapshot {
    if (!this.simulationMode) throw new ActionRejectedError("Time acceleration is disabled outside simulation mode");
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAX_DURATION_MS) {
      throw new ActionRejectedError("durationMs must be a whole number from 1 to 86400000 (24 hours)");
    }
    this.clock.advance(durationMs);
    this.db.setSetting("simulationClockOffsetMs", String(this.clock.getOffset()));
    this.emit();
    return this.snapshot();
  }

  /** Simulation controls act on simulated TVs only; a real TV's connection is what it reports, never what staff set. */
  private simulated(runtime: RuntimeStation): MockTvAdapter {
    if (!runtime.mock) throw new ActionRejectedError("Simulation controls only work on simulated TVs");
    return runtime.mock;
  }

  /** Only a verified success confirms the expired screen; anything that did not show it is FAILED. */
  private blockingStatus(result: CommandResult): BlockingStatus {
    switch (result.outcome) {
      case "SUCCESS": return result.verified ? "CONFIRMED" : "UNVERIFIED";
      case "UNVERIFIED": return "UNVERIFIED";
      case "UNSUPPORTED":
      case "FAILURE":
      case "TIMEOUT":
      case "DEVICE_OFFLINE": return "FAILED";
    }
  }

  private requireSessionDuration(durationMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs < MIN_SESSION_MS || durationMs > MAX_DURATION_MS) {
      throw new ActionRejectedError("durationMs must be a whole number from 60000 (1 minute) to 86400000 (24 hours)");
    }
  }

  /**
   * Broadcasts are coalesced: at most one full snapshot per BROADCAST_INTERVAL_MS, built when it is sent so it always
   * carries the latest state. Without this a 50-station command storm costs O(stations^2) work per connected client.
   */
  private emit(): void {
    if (!this.onChange || this.broadcastTimer) return;
    const wait = Math.max(0, this.lastBroadcastAt + BROADCAST_INTERVAL_MS - performance.now());
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.lastBroadcastAt = performance.now();
      this.onChange?.(this.snapshot());
    }, wait);
    this.broadcastTimer.unref();
  }

  /** Stops broadcasts and refuses further transitions; call after `drain` and before closing the database. */
  dispose(): void {
    this.closed = true;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    this.onChange = null;
  }
}

export function createSystem(
  db: AppDatabase,
  simulationMode = true,
  stationCount = 10,
  baseClock: Clock = new SystemClock(),
  options: SystemOptions = {},
): TvManagementSystem {
  // Live time is never accelerated, whatever an old setting says.
  const offset = simulationMode ? Number(db.getSetting("simulationClockOffsetMs", "0")) : 0;
  return new TvManagementSystem(db, new AdjustableClock(offset, baseClock), simulationMode, stationCount, options);
}

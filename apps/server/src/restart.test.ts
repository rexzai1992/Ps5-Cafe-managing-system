import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StationView, SystemSnapshot } from "@ps5-cafe/contracts";

/**
 * Runs the real server entrypoint as a child process against a temporary SQLite file, then kills and restarts it.
 * Time moves via the persisted simulation offset; the only real time that passes is process startup.
 */

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "restart-test-token";
const MINUTE = 60_000;
const STARTUP_SLACK_MS = 30_000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

class ServerProcess {
  private output = "";
  private constructor(private readonly child: ChildProcess, readonly baseUrl: string) {
    child.stdout?.on("data", (chunk: Buffer) => { this.output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { this.output += chunk.toString(); });
  }

  static async start(databasePath: string): Promise<ServerProcess> {
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: String(port),
        PS5_CAFE_API_TOKEN: TOKEN,
        PS5_CAFE_DB_PATH: databasePath,
        SIMULATION_MODE: "true",
        STATION_COUNT: "10",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const server = new ServerProcess(child, `http://127.0.0.1:${port}`);
    await server.waitUntilHealthy();
    return server;
  }

  private async waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) throw new Error(`Server exited early (${this.child.exitCode}):\n${this.output}`);
      try {
        if ((await fetch(`${this.baseUrl}/health`)).ok) return;
      } catch { /* not listening yet */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Server did not become healthy:\n${this.output}`);
  }

  async stop(signal: NodeJS.Signals): Promise<number | null> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.child.exitCode;
    const exited = new Promise<number | null>((resolve) => this.child.once("exit", (code) => resolve(code)));
    this.child.kill(signal);
    return exited;
  }

  async snapshot(): Promise<SystemSnapshot> {
    const response = await fetch(`${this.baseUrl}/api/snapshot`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    return await response.json() as SystemSnapshot;
  }

  async post(url: string, body: unknown, idempotencyKey: string): Promise<Response> {
    return fetch(`${this.baseUrl}${url}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    });
  }
}

/** Connects a dashboard-like Socket.IO client and resolves once it has received its first snapshot. */
const connectDashboard = (baseUrl: string) => new Promise<Socket>((resolve, reject) => {
  const socket = connect(baseUrl, { path: "/socket.io", auth: { token: TOKEN }, transports: ["websocket"], reconnection: false, forceNew: true });
  socket.once("snapshot", () => resolve(socket));
  socket.once("connect_error", reject);
});

const station = (snapshot: SystemSnapshot, id: string): StationView => {
  const found = snapshot.stations.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
};

describe("process-boundary restart against a temporary SQLite file", { timeout: 90_000 }, () => {
  let dir: string;
  let databasePath: string;
  let current: ServerProcess | null = null;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps5-cafe-restart-"));
    databasePath = path.join(dir, "cafe.sqlite");
  });
  afterAll(async () => {
    await current?.stop("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restores sessions, simulation offset, and idempotency records after a crash and a graceful stop", async () => {
    // --- First process: create active, paused, and soon-to-be-overdue sessions.
    current = await ServerProcess.start(databasePath);
    expect((await current.post("/api/stations/ps5-01/actions", { type: "START", durationMs: 60 * MINUTE }, "restart-start-01")).status).toBe(200);
    expect((await current.post("/api/stations/ps5-02/actions", { type: "START", durationMs: 60 * MINUTE }, "restart-start-02")).status).toBe(200);
    expect((await current.post("/api/stations/ps5-03/actions", { type: "START", durationMs: 60 * MINUTE }, "restart-start-03")).status).toBe(200);
    expect((await current.post("/api/simulation/advance", { durationMs: 10 * MINUTE }, "restart-advance-1")).status).toBe(200);
    expect((await current.post("/api/stations/ps5-02/actions", { type: "PAUSE" }, "restart-pause-02")).status).toBe(200);
    const before = await current.snapshot();
    const activeDeadline = station(before, "ps5-01").session.deadlineAt;
    const pausedRemaining = station(before, "ps5-02").session.pausedRemainingMs!;
    expect(pausedRemaining).toBeLessThanOrEqual(50 * MINUTE);
    expect(pausedRemaining).toBeGreaterThan(50 * MINUTE - STARTUP_SLACK_MS);

    // --- Crash: SIGKILL gives the process no chance to flush or close the database.
    await current.stop("SIGKILL");
    current = null;

    // Simulate ps5-03's deadline passing while the server was down.
    const offline = new Database(databasePath);
    offline.prepare("UPDATE sessions SET deadline_at = 1 WHERE station_id = 'ps5-03'").run();
    offline.close();

    // --- Second process: state must be reconstructed from the file.
    current = await ServerProcess.start(databasePath);
    const afterCrash = await current.snapshot();
    expect(afterCrash.acceleratedByMs).toBe(10 * MINUTE);
    const active = station(afterCrash, "ps5-01");
    expect(active.session.status).toBe("ACTIVE");
    expect(active.session.deadlineAt).toBe(activeDeadline);
    expect(active.session.remainingMs).toBeLessThanOrEqual(50 * MINUTE);
    expect(active.session.remainingMs).toBeGreaterThan(50 * MINUTE - STARTUP_SLACK_MS);
    const paused = station(afterCrash, "ps5-02");
    expect(paused.session.status).toBe("PAUSED");
    expect(paused.session.remainingMs).toBe(pausedRemaining);

    // The overdue station is locked by server reconciliation without any client action.
    const lockDeadline = Date.now() + 5_000;
    let overdue = station(afterCrash, "ps5-03");
    while (overdue.mode !== "EXPIRED" && Date.now() < lockDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      overdue = station(await current.snapshot(), "ps5-03");
    }
    expect(overdue.session.status).toBe("EXPIRED");
    expect(overdue.mode).toBe("EXPIRED");
    expect(overdue.blockingStatus).toBe("CONFIRMED");

    // A client retrying a pre-crash request is replayed, not re-executed.
    const retry = await current.post("/api/stations/ps5-01/actions", { type: "START", durationMs: 60 * MINUTE }, "restart-start-01");
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(station(await current.snapshot(), "ps5-01").session.deadlineAt).toBe(activeDeadline);

    // --- Graceful stop exits cleanly and promptly even with a dashboard still connected, and a third process still
    // sees the same state.
    const dashboard = await connectDashboard(current.baseUrl);
    const dashboardDisconnected = new Promise<string>((resolve) => dashboard.once("disconnect", resolve));
    const stopStartedAt = Date.now();
    try {
      expect(await current.stop("SIGTERM")).toBe(0);
      expect(Date.now() - stopStartedAt).toBeLessThan(5_000);
      await dashboardDisconnected;
    } finally {
      dashboard.close();
    }
    current = await ServerProcess.start(databasePath);
    const afterGraceful = await current.snapshot();
    expect(station(afterGraceful, "ps5-01").session.deadlineAt).toBe(activeDeadline);
    expect(station(afterGraceful, "ps5-02").session.remainingMs).toBe(pausedRemaining);
    expect(station(afterGraceful, "ps5-03").mode).toBe("EXPIRED");

    // Remaining time continues to expire on the restarted server.
    expect((await current.post("/api/simulation/advance", { durationMs: 51 * MINUTE }, "restart-advance-2")).status).toBe(200);
    const expired = await current.snapshot();
    expect(station(expired, "ps5-01").mode).toBe("EXPIRED");
    expect(station(expired, "ps5-02").session.status).toBe("PAUSED");
  });
});

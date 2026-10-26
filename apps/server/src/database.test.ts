import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "./database.js";

describe("schema migrations", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps5-cafe-db-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("migrates a fresh database to the latest version", () => {
    const db = new AppDatabase(path.join(dir, "fresh.sqlite"));
    expect(db.schemaVersion()).toBe(5);
    db.close();
  });

  it("upgrades a pre-versioning database without rewriting its data", () => {
    const file = path.join(dir, "legacy.sqlite");
    // Shape written by the original unversioned foundation build (user_version 0).
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE stations (id TEXT PRIMARY KEY, station_number INTEGER NOT NULL UNIQUE, name TEXT NOT NULL,
        adapter_kind TEXT NOT NULL, simulated INTEGER NOT NULL DEFAULT 1, connection TEXT NOT NULL, mode TEXT NOT NULL,
        blocking_status TEXT NOT NULL, hdmi_input TEXT NOT NULL, device_state_json TEXT NOT NULL, last_command_json TEXT);
      CREATE TABLE sessions (station_id TEXT PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE, status TEXT NOT NULL,
        started_at INTEGER, deadline_at INTEGER, paused_remaining_ms INTEGER);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO stations VALUES ('ps5-01', 1, 'PS5-01', 'mock', 1, 'ONLINE', 'PLAYING', 'NOT_APPLICABLE', 'HDMI1', '{}', NULL);
      INSERT INTO sessions VALUES ('ps5-01', 'ACTIVE', 100, 3600100, NULL);
      INSERT INTO settings VALUES ('simulationClockOffsetMs', '42');
    `);
    legacy.close();

    const db = new AppDatabase(file);
    expect(db.schemaVersion()).toBe(5);
    expect(db.raw.prepare("SELECT status, deadline_at FROM sessions WHERE station_id = 'ps5-01'").get())
      .toEqual({ status: "ACTIVE", deadline_at: 3_600_100 });
    expect(db.getSetting("simulationClockOffsetMs", "0")).toBe("42");
    expect(db.getIdempotentResponse("missing-key")).toBeNull();
    db.close();

    // Re-opening an up-to-date database is a no-op.
    const reopened = new AppDatabase(file);
    expect(reopened.schemaVersion()).toBe(5);
    reopened.close();
  });

  it("prunes idempotency records past the retention window", () => {
    const db = new AppDatabase(":memory:");
    db.saveIdempotentResponse("old-key-0001", { requestFingerprint: "a", statusCode: 200, body: { ok: 1 } }, 1_000, 500);
    db.saveIdempotentResponse("new-key-0001", { requestFingerprint: "b", statusCode: 200, body: { ok: 2 } }, 2_000, 500);
    expect(db.getIdempotentResponse("old-key-0001")).toBeNull();
    expect(db.getIdempotentResponse("new-key-0001")).toEqual({ requestFingerprint: "b", statusCode: 200, body: { ok: 2 } });
    db.close();
  });
});

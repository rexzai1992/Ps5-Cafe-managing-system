import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AdapterKind, BlockingStatus, ConnectionState, SessionStatus, TvMode } from "@ps5-cafe/contracts";

export interface StationRow {
  id: string;
  station_number: number;
  name: string;
  adapter_kind: AdapterKind;
  simulated: number;
  connection: ConnectionState;
  mode: TvMode;
  blocking_status: BlockingStatus;
  hdmi_input: string;
  device_state_json: string;
  last_command_json: string | null;
}

export interface SessionRow {
  station_id: string;
  status: SessionStatus;
  started_at: number | null;
  deadline_at: number | null;
  paused_remaining_ms: number | null;
}

const MIGRATIONS: readonly string[] = [
  // 1: Phase 1 foundation. IF NOT EXISTS keeps pre-versioning databases (user_version 0) intact.
  `
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      station_number INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      adapter_kind TEXT NOT NULL,
      simulated INTEGER NOT NULL DEFAULT 1,
      connection TEXT NOT NULL,
      mode TEXT NOT NULL,
      blocking_status TEXT NOT NULL,
      hdmi_input TEXT NOT NULL,
      device_state_json TEXT NOT NULL,
      last_command_json TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      station_id TEXT PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      started_at INTEGER,
      deadline_at INTEGER,
      paused_remaining_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS command_log (
      id TEXT PRIMARY KEY,
      station_id TEXT NOT NULL REFERENCES stations(id),
      command_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_command_log_station_time ON command_log(station_id, created_at DESC);
  `,
  // 2: Stored responses for client-supplied Idempotency-Key headers on mutating requests.
  `
    CREATE TABLE idempotency_keys (
      key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_idempotency_keys_created ON idempotency_keys(created_at);
  `,
  // 3: Per-TV screen credentials and QR reservations. phone is nulled as soon as a reservation closes (PDPA).
  `
    CREATE TABLE station_screens (
      station_id TEXT PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
      screen_key TEXT NOT NULL,
      qr_secret TEXT NOT NULL,
      seen_at INTEGER
    );
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY,
      ref TEXT NOT NULL UNIQUE,
      station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      phone TEXT,
      phone_last4 TEXT,
      token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      hold_until INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE INDEX idx_reservations_station_status ON reservations(station_id, status);
    -- At most one open reservation per TV, enforced by SQLite as well as by the service.
    CREATE UNIQUE INDEX idx_reservations_one_open ON reservations(station_id) WHERE status IN ('HELD', 'STARTED');
  `,
  // 4: The owner's opt-in remote control per TV: which ADB device (wireless debugging) controls it. (5 adds last_address.)
  `
    CREATE TABLE station_remotes (
      station_id TEXT PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
      device TEXT NOT NULL,
      assigned_at INTEGER NOT NULL
    );
  `,
  // 5: The last address a remote-controlled TV announced; TVs stop announcing now and then.
  `
    ALTER TABLE station_remotes ADD COLUMN last_address TEXT;
  `,
];

export interface StoredResponse {
  requestFingerprint: string;
  statusCode: number;
  body: unknown;
}

export class AppDatabase {
  public readonly raw: Database.Database;

  public constructor(filename: string) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.raw = new Database(filename);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    // Erased values (e.g. a customer's phone number) are overwritten with zeros instead of lingering in free pages.
    this.raw.pragma("secure_delete = ON");
    this.migrate();
  }

  /**
   * Ordered, append-only schema migrations tracked by `PRAGMA user_version`.
   * Never edit a released migration; add a new one instead.
   */
  private migrate(): void {
    const current = this.raw.pragma("user_version", { simple: true }) as number;
    for (const [index, sql] of MIGRATIONS.entries()) {
      const version = index + 1;
      if (version <= current) continue;
      this.raw.transaction(() => {
        this.raw.exec(sql);
        this.raw.pragma(`user_version = ${version}`);
      })();
    }
  }

  schemaVersion(): number {
    return this.raw.pragma("user_version", { simple: true }) as number;
  }

  /** Adds missing stations: simulated (`mock`) TVs, or live `screen-only` TVs that stay offline until their screen polls. */
  seedStations(count: number, kind: "mock" | "screen-only" = "mock"): void {
    const simulated = kind === "mock";
    const stationInsert = this.raw.prepare(`
      INSERT OR IGNORE INTO stations
      (id, station_number, name, adapter_kind, simulated, connection, mode, blocking_status, hdmi_input, device_state_json)
      VALUES (?, ?, ?, ?, ?, ?, 'IDLE', 'NOT_APPLICABLE', 'HDMI1', ?)
    `);
    const sessionInsert = this.raw.prepare(`
      INSERT OR IGNORE INTO sessions (station_id, status, started_at, deadline_at, paused_remaining_ms)
      VALUES (?, 'NONE', NULL, NULL, NULL)
    `);
    const seed = this.raw.transaction(() => {
      for (let number = 1; number <= count; number += 1) {
        const id = `ps5-${String(number).padStart(2, "0")}`;
        const state = JSON.stringify({ power: true, volume: 25, muted: false, input: "APP", displayedMode: "IDLE" });
        stationInsert.run(id, number, `PS5-${String(number).padStart(2, "0")}`, kind, simulated ? 1 : 0, simulated ? "ONLINE" : "OFFLINE", state);
        sessionInsert.run(id);
      }
    });
    seed();
  }

  getSetting(key: string, fallback: string): string {
    const row = this.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? fallback;
  }

  setSetting(key: string, value: string): void {
    this.raw.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getIdempotentResponse(key: string): StoredResponse | null {
    const row = this.raw.prepare("SELECT request_fingerprint, status_code, response_json FROM idempotency_keys WHERE key = ?")
      .get(key) as { request_fingerprint: string; status_code: number; response_json: string } | undefined;
    if (!row) return null;
    return { requestFingerprint: row.request_fingerprint, statusCode: row.status_code, body: JSON.parse(row.response_json) };
  }

  saveIdempotentResponse(key: string, response: StoredResponse, createdAt: number, retainMs: number): void {
    const save = this.raw.transaction(() => {
      this.raw.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").run(createdAt - retainMs);
      this.raw.prepare(`
        INSERT INTO idempotency_keys(key, request_fingerprint, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?)
      `).run(key, response.requestFingerprint, response.statusCode, JSON.stringify(response.body), createdAt);
    });
    save();
  }

  close(): void { this.raw.close(); }
}


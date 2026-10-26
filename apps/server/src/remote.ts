import type { Statement } from "better-sqlite3";
import type { RemoteControl } from "./adapters.js";
import { ADB_SERIAL, type Adb } from "./adb.js";
import type { AppDatabase } from "./database.js";

/** A remote-control setting the server refuses; `statusCode` is the HTTP status to answer with. */
export class RemoteRejectedError extends Error {
  public constructor(message: string, public readonly statusCode: number) { super(message); }
}

/**
 * Which ADB device remote-controls which TV. Opt-in per TV: nothing is controlled until the owner assigns a device it
 * paired with wireless debugging. Kept in SQLite so it survives restarts.
 */
export class RemoteRegistry {
  private readonly devices = new Map<string, string>();
  private readonly upsert: Statement;
  private readonly remove: Statement;

  public constructor(private readonly db: AppDatabase, private readonly adb: Adb | null, private readonly now: () => number) {
    const rows = db.raw.prepare("SELECT station_id, device, last_address FROM station_remotes").all() as { station_id: string; device: string; last_address: string | null }[];
    for (const row of rows) {
      this.devices.set(row.station_id, row.device);
      adb?.remember(row.device, row.last_address);
    }
    // Keep the last address a TV announced, so it stays reachable when it stops announcing (or after a restart).
    const saveAddress = db.raw.prepare("UPDATE station_remotes SET last_address = ? WHERE device = ?");
    if (adb) adb.onAddress = (device, address) => { saveAddress.run(address, device); };
    this.upsert = db.raw.prepare(`INSERT INTO station_remotes(station_id, device, assigned_at) VALUES (?, ?, ?)
      ON CONFLICT(station_id) DO UPDATE SET device = excluded.device, assigned_at = excluded.assigned_at`);
    this.remove = db.raw.prepare("DELETE FROM station_remotes WHERE station_id = ?");
  }

  get available(): boolean { return this.adb !== null; }

  deviceOf(stationId: string): string | null { return this.devices.get(stationId) ?? null; }

  /** The control channel for a TV, or null when none is assigned or the server has no ADB tool. */
  controlFor(stationId: string): RemoteControl | null {
    const device = this.devices.get(stationId);
    const adb = this.adb;
    if (!device || !adb) return null;
    return { key: (key) => adb.key(device, key), tap: (x, y) => adb.tap(device, x, y), showInput: (input) => adb.showInput(device, input) };
  }

  assign(stationId: string, device: unknown): void {
    if (!this.adb) throw new RemoteRejectedError("This server has no ADB tool, so it cannot remote-control TVs.", 409);
    if (typeof device !== "string" || !ADB_SERIAL.test(device)) throw new RemoteRejectedError("Choose a device from the list.", 400);
    const owner = [...this.devices].find(([station, assigned]) => assigned === device && station !== stationId);
    if (owner) throw new RemoteRejectedError(`That device already controls ${owner[0].toUpperCase()}.`, 409);
    this.upsert.run(stationId, device, this.now());
    this.db.raw.prepare("UPDATE station_remotes SET last_address = ? WHERE station_id = ?").run(this.adb.lastAddress(device), stationId);
    this.devices.set(stationId, device);
  }

  /** Assigned devices with whether each can be reached right now (a TV may be connected without announcing itself). */
  async assignedStatus(): Promise<{ serial: string; address: string | null; connected: boolean }[]> {
    const adb = this.adb;
    if (!adb) return [];
    return Promise.all([...new Set(this.devices.values())].map(async (serial) => ({ serial, ...await adb.status(serial).catch(() => ({ connected: false, address: null })) })));
  }

  clear(stationId: string): void {
    this.remove.run(stationId);
    this.devices.delete(stationId);
  }

  async screenshot(stationId: string): Promise<Buffer> {
    const device = this.devices.get(stationId);
    if (!device || !this.adb) throw new RemoteRejectedError("No remote control is set up for this TV.", 404);
    return this.adb.screenshot(device);
  }
}

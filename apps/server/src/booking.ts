import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  BlockingStatus, PublicBookingInfo, PublicReservation, ReservationCreated, ReservationStatus, ReservationView, ScreenLink, ScreenView, StationView,
} from "@ps5-cafe/contracts";
import type { Statement } from "better-sqlite3";
import type { AppDatabase } from "./database.js";
import type { TvManagementSystem, ViewExtension } from "./system.js";

/** How long one QR code is shown before the TV's screen rotates to the next. */
export const QR_WINDOW_MS = 2 * 60_000;
/** Scanning proves presence: the info page accepts the current or previous code only. */
const SCAN_WINDOWS = 1;
/** Submitting the form may take longer (typing a phone number), so a code scanned up to ~10 minutes ago still works. */
const SUBMIT_WINDOWS = 5;
export const DEFAULT_HOLD_MS = 10 * 60_000;
export const BOOKING_DURATIONS_MS = [15, 30, 60, 120, 180].map((minutes) => minutes * 60_000);
/** Safety net: no phone number survives this long, whatever state its reservation is in. */
export const PHONE_RETENTION_MS = 24 * 60 * 60_000;
/** Screen heartbeats are written at most this often per TV. */
const SEEN_WRITE_INTERVAL_MS = 5_000;
/** A screen page polls every 2 s; this long without a poll means it was closed, went to sleep, or the TV changed input. */
export const SCREEN_ONLINE_MS = 15_000;
/**
 * Live mode: how long after a session expires the TV's screen page may take to come up (the companion app brings it to
 * the front) before the expired screen counts as not shown.
 */
export const EXPIRED_SCREEN_GRACE_MS = 20_000;
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Who polled a TV's screen view. Only a visible screen page is a heartbeat; only the TV itself shows it is online. */
export type ScreenPollSource = "screen" | "overlay" | "preview";

/** A booking request the server refuses; `statusCode` is the HTTP status to answer with. */
export class BookingRejectedError extends Error {
  public constructor(message: string, public readonly statusCode: 400 | 403 | 404 | 409) { super(message); }
}

interface ScreenRow { station_id: string; screen_key: string; qr_secret: string; seen_at: number | null }
interface ReservationRow {
  id: string; ref: string; station_id: string; status: ReservationStatus; duration_ms: number; phone: string | null;
  phone_last4: string | null; token_hash: string; created_at: number; hold_until: number; closed_at: number | null;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));
const secret = () => randomBytes(24).toString("base64url");

/**
 * Normalises a Malaysian mobile number to E.164 (+60…). Accepts "012-345 6789", "0123456789", "60123456789",
 * "+60 11-2345 6789". Returns null for anything else, including landlines and foreign numbers.
 */
export function normalizeMalaysianMobile(input: string): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  if (!/^[+\d\s()-]+$/.test(input)) return null;
  let digits = input.replace(/\D/g, "");
  if (input.trim().startsWith("+") && !digits.startsWith("60")) return null;
  if (digits.startsWith("60")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  else return null;
  return /^1\d{8,9}$/.test(digits) ? `+60${digits}` : null;
}

/** 8-character code for one TV and one time window: HMAC, so it cannot be guessed or computed without the TV's secret. */
export function qrCode(qrSecret: string, stationId: string, window: number): string {
  const digest = createHmac("sha256", qrSecret).update(`${stationId}:${window}`).digest();
  let code = "";
  for (let index = 0; index < 8; index += 1) code += REF_ALPHABET[digest[index]! % REF_ALPHABET.length];
  return code;
}

function bookable(view: StationView): string | null {
  const status = view.session.status;
  if (status === "ACTIVE" || status === "PAUSED") return "This TV is in use right now.";
  if (view.mode !== "IDLE") return "This TV's session has just ended. Please ask at the counter.";
  return null;
}

export interface BookingOptions { holdMs?: number }

/** QR reservations: per-TV rotating codes, a time-limited hold, staff start/release, and phone-number erasure. */
export class BookingService {
  private readonly holdMs: number;
  private readonly lastSeenWrite = new Map<string, number>();
  /** Last poll of each screen page that is open now. Kept in memory: after a restart, open screens reappear within 2 s. */
  private readonly liveScreens = new Map<string, number>();
  /** Last poll of any kind (screen page or the companion app's timer overlay): the TV is on and reaching the server. */
  private readonly liveApps = new Map<string, number>();
  /** Live-mode connection and evidence as last broadcast, so the 1 s tick can push changes that only time causes. */
  private liveSignature = "";
  // Used on every snapshot, so prepared once.
  private readonly openStatement: Statement;
  private readonly seenStatement: Statement;

  public constructor(private readonly db: AppDatabase, private readonly system: TvManagementSystem, options: BookingOptions = {}) {
    this.holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
    this.openStatement = db.raw.prepare("SELECT * FROM reservations WHERE station_id = ? AND status IN ('HELD', 'STARTED')");
    this.seenStatement = db.raw.prepare("SELECT seen_at FROM station_screens WHERE station_id = ?");
    this.ensureScreens();
  }

  /** Every station gets a screen key and QR secret once; existing ones are never rotated silently. */
  private ensureScreens(): void {
    const insert = this.db.raw.prepare("INSERT OR IGNORE INTO station_screens(station_id, screen_key, qr_secret, seen_at) VALUES (?, ?, ?, NULL)");
    this.db.raw.transaction(() => { for (const id of this.system.stationIds()) insert.run(id, secret(), secret()); })();
  }

  private screen(stationId: string): ScreenRow {
    const row = this.db.raw.prepare("SELECT * FROM station_screens WHERE station_id = ?").get(stationId) as ScreenRow | undefined;
    if (!row) throw new BookingRejectedError("This TV does not exist.", 404);
    return row;
  }

  private open(stationId: string): ReservationRow | undefined {
    return this.openStatement.get(stationId) as ReservationRow | undefined;
  }

  private stationView(stationId: string): StationView {
    try { return this.system.viewOf(stationId); }
    catch { throw new BookingRejectedError("This TV does not exist.", 404); }
  }

  private window(now: number): number { return Math.floor(now / QR_WINDOW_MS); }

  private codeValid(screen: ScreenRow, code: unknown, windowsBack: number): boolean {
    if (typeof code !== "string" || !/^[A-Z2-9]{8}$/.test(code)) return false;
    const current = this.window(this.system.now());
    for (let window = current; window >= current - windowsBack; window -= 1) {
      if (sameSecret(code, qrCode(screen.qr_secret, screen.station_id, window))) return true;
    }
    return false;
  }

  private close(row: ReservationRow, status: Extract<ReservationStatus, "COMPLETED" | "RELEASED" | "EXPIRED" | "CANCELLED">, now: number): void {
    // Closing erases the phone number in the same statement (PDPA: kept only while needed for this booking).
    this.db.raw.prepare("UPDATE reservations SET status = ?, closed_at = ?, phone = NULL, phone_last4 = NULL WHERE id = ?").run(status, now, row.id);
    this.flushHistory();
  }

  /** Older copies of an erased row can sit in the write-ahead log until a checkpoint; reservations close rarely, so flush. */
  private flushHistory(): void {
    try { this.db.raw.pragma("wal_checkpoint(TRUNCATE)"); }
    catch { /* a busy checkpoint is retried on the next close; secure_delete still zeroes the main file */ }
  }

  // --- Staff --------------------------------------------------------------------------------------------------------

  screenLinks(): ScreenLink[] {
    const rows = this.db.raw.prepare("SELECT * FROM station_screens").all() as ScreenRow[];
    const byId = new Map(rows.map((row) => [row.station_id, row]));
    return this.system.stationIds().flatMap((id) => {
      const row = byId.get(id);
      return row ? [{ stationId: id, name: this.system.viewOf(id).name, key: row.screen_key, seenAt: row.seen_at }] : [];
    });
  }

  /**
   * Data merged into each staff station view. A screen-only (live) TV is only ever known through its own polls, so its
   * connection and expired-screen evidence come from here rather than from an adapter.
   */
  extension(stationId: string, base: StationView): ReturnType<ViewExtension> {
    const row = this.open(stationId);
    const seen = this.seenStatement.get(stationId) as { seen_at: number | null } | undefined;
    const reservation: ReservationView | null = row
      ? { id: row.id, ref: row.ref, status: row.status, durationMs: row.duration_ms, createdAt: row.created_at, holdUntil: row.hold_until, phone: row.phone }
      : null;
    const screenOnline = this.liveScreens.has(stationId);
    const extension: ReturnType<ViewExtension> = { reservation, screenSeenAt: seen?.seen_at ?? null, screenOnline };
    if (base.adapterKind !== "screen-only") return extension;
    extension.connection = this.liveApps.has(stationId) ? "ONLINE" : "OFFLINE";
    if (base.mode === "EXPIRED") extension.blockingStatus = this.expiredScreenEvidence(screenOnline, base.lastCommand?.completedAt ?? 0);
    return extension;
  }

  /**
   * The screen page is the only thing that can show "Time expired" on a screen-only TV, and it polls only while visible:
   * a poll after expiry is the evidence. Software only — the customer can still change input with the TV remote.
   */
  private expiredScreenEvidence(screenOnline: boolean, expiredAt: number): BlockingStatus {
    if (screenOnline) return "CONFIRMED";
    return this.system.now() - expiredAt < EXPIRED_SCREEN_GRACE_MS ? "PENDING" : "FAILED";
  }

  /** A staff START on a held TV is the customer's session starting. */
  onStarted(stationId: string): void {
    this.db.raw.prepare("UPDATE reservations SET status = 'STARTED' WHERE station_id = ? AND status = 'HELD'").run(stationId);
  }

  release(stationId: string): void {
    this.stationView(stationId);
    const row = this.open(stationId);
    if (!row) throw new BookingRejectedError("This TV has no reservation to release.", 409);
    if (row.status === "STARTED") throw new BookingRejectedError("The session is running; end the session instead.", 409);
    this.close(row, "RELEASED", this.system.now());
  }

  /**
   * Expires holds, completes reservations whose session is over, erases stale phone numbers, and marks screens that went
   * quiet as offline. True if anything changed.
   */
  reconcile(): boolean {
    const now = this.system.now();
    let changed = false;
    for (const live of [this.liveScreens, this.liveApps]) {
      for (const [stationId, at] of live) if (now - at >= SCREEN_ONLINE_MS) { live.delete(stationId); changed = true; }
    }
    const signature = this.system.stationIds().map((id) => this.system.viewOf(id))
      .filter((view) => view.adapterKind === "screen-only").map((view) => `${view.connection}:${view.blockingStatus}`).join("|");
    if (signature !== this.liveSignature) { this.liveSignature = signature; changed = true; }
    const open = this.db.raw.prepare("SELECT * FROM reservations WHERE status IN ('HELD', 'STARTED')").all() as ReservationRow[];
    for (const row of open) {
      if (row.status === "HELD" && row.hold_until <= now) { this.close(row, "EXPIRED", now); changed = true; continue; }
      if (row.status === "STARTED") {
        const status = this.stationView(row.station_id).session.status;
        if (status !== "ACTIVE" && status !== "PAUSED") { this.close(row, "COMPLETED", now); changed = true; }
      }
    }
    const purged = this.db.raw.prepare("UPDATE reservations SET phone = NULL, phone_last4 = NULL WHERE phone IS NOT NULL AND created_at < ?")
      .run(now - PHONE_RETENTION_MS);
    if (purged.changes > 0) this.flushHistory();
    return changed || purged.changes > 0;
  }

  // --- TV screen (screen key) ---------------------------------------------------------------------------------------

  /**
   * `source` says who is asking: the TV's visible screen page (a heartbeat), the companion app's timer overlay (the TV is
   * on and the app alive, but the page is hidden), or a staff preview of the page (says nothing about the TV at all).
   */
  screenView(stationId: string, key: unknown, source: ScreenPollSource = "screen"): ScreenView {
    const heartbeat = source === "screen";
    const screen = this.screen(stationId);
    if (typeof key !== "string" || !sameSecret(key, screen.screen_key)) throw new BookingRejectedError("Wrong screen key for this TV.", 403);
    const now = this.system.now();
    const last = this.lastSeenWrite.get(stationId) ?? Number.NEGATIVE_INFINITY;
    if (heartbeat && (now - last >= SEEN_WRITE_INTERVAL_MS || now < last)) {
      this.db.raw.prepare("UPDATE station_screens SET seen_at = ? WHERE station_id = ?").run(now, stationId);
      this.lastSeenWrite.set(stationId, now);
    }
    // Dashboards hear only changes (screen opened, TV came online), not every poll; going quiet is caught by reconcile().
    // The app being alive only changes a screen-only TV's view (its connection). A staff preview is not the TV.
    let cameOnline = source !== "preview" && !this.liveApps.has(stationId) && this.system.viewOf(stationId).adapterKind === "screen-only";
    if (source !== "preview") this.liveApps.set(stationId, now);
    if (heartbeat) {
      cameOnline ||= !this.liveScreens.has(stationId);
      this.liveScreens.set(stationId, now);
    }
    if (cameOnline) this.system.notifyChanged();
    const view = this.stationView(stationId);
    const row = this.open(stationId);
    const window = this.window(now);
    return {
      station: { id: view.id, name: view.name, number: view.number },
      serverTime: now,
      mode: view.mode,
      sessionStatus: view.session.status,
      remainingMs: view.session.remainingMs,
      reservation: row ? { ref: row.ref, status: row.status, durationMs: row.duration_ms, holdUntil: row.hold_until, phoneLast4: row.phone_last4 } : null,
      qr: !row && bookable(view) === null ? { code: qrCode(screen.qr_secret, stationId, window), rotatesAt: (window + 1) * QR_WINDOW_MS } : null,
    };
  }

  // --- Customer (QR code / reservation token) ----------------------------------------------------------------------

  bookingInfo(stationId: string, code: unknown): PublicBookingInfo {
    const screen = this.screen(stationId);
    const view = this.stationView(stationId);
    if (!this.codeValid(screen, code, SCAN_WINDOWS)) throw new BookingRejectedError("This QR code has expired. Please scan the code on the TV again.", 403);
    // "In use" first: a booked session that has started is, to a customer, simply a TV in use.
    const reason = bookable(view) ?? (this.open(stationId) ? "This TV is already reserved." : null);
    return {
      station: { id: view.id, name: view.name },
      available: reason === null,
      reason,
      durationsMs: BOOKING_DURATIONS_MS,
      holdMs: this.holdMs,
      serverTime: this.system.now(),
    };
  }

  reserve(stationId: string, request: { code: unknown; durationMs: unknown; phone: unknown; consent: unknown }): ReservationCreated {
    const screen = this.screen(stationId);
    const view = this.stationView(stationId);
    if (!this.codeValid(screen, request.code, SUBMIT_WINDOWS)) {
      throw new BookingRejectedError("This QR code has expired. Please scan the code on the TV again.", 403);
    }
    if (typeof request.durationMs !== "number" || !BOOKING_DURATIONS_MS.includes(request.durationMs)) {
      throw new BookingRejectedError("Please choose one of the listed times.", 400);
    }
    if (request.consent !== true) throw new BookingRejectedError("Please agree to the use of your phone number for this booking.", 400);
    const phone = typeof request.phone === "string" ? normalizeMalaysianMobile(request.phone) : null;
    if (!phone) throw new BookingRejectedError("Please enter a Malaysian mobile number, e.g. 012-345 6789.", 400);
    if (this.open(stationId)) throw new BookingRejectedError("Sorry, this TV has just been reserved by someone else.", 409);
    const notBookable = bookable(view);
    if (notBookable) throw new BookingRejectedError(notBookable, 409);

    const now = this.system.now();
    const token = secret();
    const row: ReservationRow = {
      id: randomUUID(), ref: "", station_id: stationId, status: "HELD", duration_ms: request.durationMs, phone, phone_last4: phone.slice(-4),
      token_hash: sha256(token).toString("hex"), created_at: now, hold_until: now + this.holdMs, closed_at: null,
    };
    const insert = this.db.raw.prepare(`
      INSERT INTO reservations(id, ref, station_id, status, duration_ms, phone, phone_last4, token_hash, created_at, hold_until, closed_at)
      VALUES (@id, @ref, @station_id, @status, @duration_ms, @phone, @phone_last4, @token_hash, @created_at, @hold_until, @closed_at)
    `);
    for (let attempt = 0; ; attempt += 1) {
      row.ref = Array.from(randomBytes(6), (byte) => REF_ALPHABET[byte % REF_ALPHABET.length]).join("");
      try { insert.run(row); break; }
      catch (error) {
        const message = error instanceof Error ? error.message : "";
        // The partial unique index is the final word when two phones submit for the same TV at the same moment.
        if (message.includes("idx_reservations_one_open") || message.includes("reservations.station_id")) {
          throw new BookingRejectedError("Sorry, this TV has just been reserved by someone else.", 409);
        }
        if (!message.includes("reservations.ref") || attempt >= 4) throw error;
      }
    }
    return { ...this.toPublic(row, view.name, now), token };
  }

  private find(id: unknown, token: unknown): ReservationRow {
    const row = typeof id === "string" ? this.db.raw.prepare("SELECT * FROM reservations WHERE id = ?").get(id) as ReservationRow | undefined : undefined;
    // Unknown id and wrong token look the same, so ids cannot be probed.
    if (!row || typeof token !== "string" || !timingSafeEqual(sha256(token), Buffer.from(row.token_hash, "hex"))) {
      throw new BookingRejectedError("Reservation not found.", 404);
    }
    return row;
  }

  private toPublic(row: ReservationRow, stationName: string, now: number): PublicReservation {
    let session: PublicReservation["session"] = null;
    if (row.status === "STARTED") {
      const view = this.stationView(row.station_id);
      session = { status: view.session.status, remainingMs: view.session.remainingMs };
    }
    return {
      id: row.id, ref: row.ref, status: row.status, station: { id: row.station_id, name: stationName },
      durationMs: row.duration_ms, holdUntil: row.hold_until, serverTime: now, session,
    };
  }

  publicStatus(id: unknown, token: unknown): PublicReservation {
    const row = this.find(id, token);
    return this.toPublic(row, this.stationView(row.station_id).name, this.system.now());
  }

  cancel(id: unknown, token: unknown): PublicReservation {
    const row = this.find(id, token);
    const now = this.system.now();
    if (row.status !== "HELD") throw new BookingRejectedError(row.status === "STARTED" ? "Your session has started; please ask at the counter." : "This reservation is already closed.", 409);
    this.close(row, "CANCELLED", now);
    return this.toPublic({ ...row, status: "CANCELLED" }, this.stationView(row.station_id).name, now);
  }
}

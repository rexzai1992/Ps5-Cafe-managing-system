// Pure presentation logic for the dashboard. No React, no DOM, no network: everything here is unit-tested in logic.test.ts.
import type { BlockingStatus, CommandOutcome, SessionStatus, StationAction, StationView } from "@ps5-cafe/contracts";

export const MINUTE_MS = 60_000;
export const MAX_DURATION_MS = 24 * 60 * MINUTE_MS;
export const EXTEND_MS = 30 * MINUTE_MS;

// ---------------------------------------------------------------------------------------------------------------
// Formatting

export function formatTime(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

/** "1h 20m", "45m", "2h". Whole minutes, rounded down. */
export function formatDurationLabel(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / MINUTE_MS));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Whole minutes as the HH:MM:SS timer shows them. The timer rounds seconds up, so 79:59.4 reads 01:20:00 and counts
 * as 80 minutes here; minute arithmetic in dialogs then agrees with what the operator sees.
 */
export function displayedMinutes(milliseconds: number): number {
  return Math.floor(Math.ceil(Math.max(0, milliseconds) / 1000) / 60);
}

/** "0:15", "1:05". Whole minutes as the timer displays them. */
export function formatHM(milliseconds: number): string {
  const totalMinutes = displayedMinutes(milliseconds);
  return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

/** Local wall-clock "HH:MM" or "HH:MM:SS" for an epoch time. */
export function formatClock(epochMs: number, withSeconds = false): string {
  const date = new Date(epochMs);
  const parts = [date.getHours(), date.getMinutes(), ...(withSeconds ? [date.getSeconds()] : [])];
  return parts.map((value) => String(value).padStart(2, "0")).join(":");
}

export function minutesText(minutes: number): string {
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** "Ends at 14:35", marked when the server clock has been fast-forwarded by the simulation. */
export function endsAtText(serverNow: number, durationMs: number, acceleratedByMs: number): string {
  return `Ends at ${formatClock(serverNow + durationMs)}${acceleratedByMs > 0 ? " (simulated clock)" : ""}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Durations

export const PRESETS = [
  { id: "15m", label: "15m", ms: 15 * MINUTE_MS },
  { id: "30m", label: "30m", ms: 30 * MINUTE_MS },
  { id: "1h", label: "1h", ms: 60 * MINUTE_MS },
  { id: "2h", label: "2h", ms: 120 * MINUTE_MS },
  { id: "3h", label: "3h", ms: 180 * MINUTE_MS },
] as const;
export type PresetId = (typeof PRESETS)[number]["id"];

export function presetMs(id: PresetId): number {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown preset ${id}`);
  return preset.ms;
}

export type DurationError = "EMPTY" | "NOT_WHOLE_NUMBER" | "TOO_SHORT" | "TOO_LONG";
export type DurationParse = { ok: true; ms: number; minutes: number } | { ok: false; code: DurationError; error: string };

const WHOLE_NUMBER = /^[0-9]{1,4}$/;

/** Hours and minutes typed by the operator. Whole minutes only, from 1 minute to 24 hours. Empty fields count as 0. */
export function parseCustomDuration(hoursText: string, minutesText: string): DurationParse {
  const hours = hoursText.trim();
  const minutes = minutesText.trim();
  if (hours === "" && minutes === "") return { ok: false, code: "EMPTY", error: "Enter hours or minutes." };
  if ((hours !== "" && !WHOLE_NUMBER.test(hours)) || (minutes !== "" && !WHOLE_NUMBER.test(minutes))) {
    return { ok: false, code: "NOT_WHOLE_NUMBER", error: "Use whole numbers (digits 0-9 only)." };
  }
  const total = Number(hours || "0") * 60 + Number(minutes || "0");
  if (total < 1) return { ok: false, code: "TOO_SHORT", error: "The time must be at least 1 minute." };
  if (total * MINUTE_MS > MAX_DURATION_MS) return { ok: false, code: "TOO_LONG", error: "The time cannot be more than 24 hours." };
  return { ok: true, ms: total * MINUTE_MS, minutes: total };
}

/** Splits a remaining time into the dialog's prefilled fields: the displayed time, rounded down to the minute. */
export function durationFields(milliseconds: number): { hours: string; minutes: string } {
  const totalMinutes = displayedMinutes(milliseconds);
  return { hours: String(Math.floor(totalMinutes / 60)), minutes: String(totalMinutes % 60) };
}

export interface RemainingChange { kind: "raise" | "lower" | "same"; deltaMinutes: number }

/** Compares in whole minutes, the unit the operator edits, against the remaining time the timer displays. */
export function setRemainingChange(currentMs: number, nextMs: number): RemainingChange {
  const delta = Math.floor(nextMs / MINUTE_MS) - displayedMinutes(currentMs);
  return { kind: delta > 0 ? "raise" : delta < 0 ? "lower" : "same", deltaMinutes: Math.abs(delta) };
}

export function remainingMs(station: StationView, serverNow: number): number {
  const { session } = station;
  if (session.status === "ACTIVE" && session.deadlineAt !== null) return Math.max(0, session.deadlineAt - serverNow);
  if (session.status === "PAUSED") return Math.max(0, session.pausedRemainingMs ?? session.remainingMs);
  return Math.max(0, session.remainingMs);
}

// ---------------------------------------------------------------------------------------------------------------
// Status-gated actions

export type CardAction =
  | "PRESETS" | "CUSTOM" | "ADVERTISING" | "PAUSE" | "RESUME" | "ADD_TIME" | "SET_REMAINING" | "END" | "EXPIRE_NOW"
  | "RETRY_EXPIRED_SCREEN";

const ALLOWED_ACTIONS: Record<SessionStatus, readonly CardAction[]> = {
  NONE: ["PRESETS", "CUSTOM", "ADVERTISING"],
  ENDED: ["PRESETS", "CUSTOM", "ADVERTISING"],
  ACTIVE: ["PAUSE", "ADD_TIME", "SET_REMAINING", "END", "EXPIRE_NOW"],
  PAUSED: ["RESUME", "ADD_TIME", "SET_REMAINING", "END"],
  EXPIRED: ["PRESETS", "CUSTOM", "ADD_TIME", "END", "ADVERTISING", "RETRY_EXPIRED_SCREEN"],
};

/** Which operator actions a card offers for a session status. Start is never offered while a session is running. */
export function allowedActions(status: SessionStatus): readonly CardAction[] {
  return ALLOWED_ACTIONS[status];
}

export interface Confirmation {
  title: string;
  body: string[];
  confirmLabel: string;
  safeLabel: string;
  tone: "danger" | "warning";
}

/**
 * Disruptive actions need an explicit confirmation; routine ones (+time, pause, resume, an online start) do not.
 * `remaining` is the station's current remaining time.
 */
export function confirmationFor(station: StationView, action: StationAction, remaining: number): Confirmation | null {
  const running = station.session.status === "ACTIVE" || station.session.status === "PAUSED";
  const offline = station.connection === "OFFLINE";
  switch (action.type) {
    case "START":
      if (!offline) return null;
      return {
        tone: "warning",
        title: `Start ${formatDurationLabel(action.durationMs)} on ${station.name}?`,
        body: ["TV offline: the timer starts on the server but the TV will not switch."],
        confirmLabel: `Start ${formatDurationLabel(action.durationMs)} anyway`,
        safeLabel: "Cancel",
      };
    case "END":
      if (!running) return null;
      return {
        tone: "danger",
        title: `End the session on ${station.name}?`,
        body: [
          `${formatHM(remaining)} of remaining time will be lost.`,
          offline ? "The TV is offline, so it will not switch to advertising until it reconnects." : "The TV returns to advertising.",
        ],
        confirmLabel: `End session on ${station.name}`,
        safeLabel: "Keep session",
      };
    case "LOCK":
      if (station.session.status !== "ACTIVE") return null;
      return {
        tone: "danger",
        title: `Expire ${station.name} now?`,
        body: [
          `The customer loses ${formatHM(remaining)} of remaining time.`,
          offline
            ? "The TV is offline, so the expired screen cannot be shown until it reconnects."
            : "The TV is sent to the expired screen. This is software only: the customer can still change input on the TV.",
        ],
        confirmLabel: `Expire ${station.name} now`,
        safeLabel: "Keep playing",
      };
    case "SET_REMAINING": {
      if (!running) return null;
      const change = setRemainingChange(remaining, action.durationMs);
      if (change.kind !== "lower") return null;
      return {
        tone: "danger",
        title: `Reduce ${station.name} to ${formatHM(action.durationMs)}?`,
        body: [
          `Customer loses ${minutesText(change.deltaMinutes)}.`,
          ...(station.session.status === "PAUSED" ? ["Session stays paused."] : []),
        ],
        confirmLabel: `Reduce ${station.name} to ${formatHM(action.durationMs)}`,
        safeLabel: `Keep ${formatHM(remaining)}`,
      };
    }
    default:
      return null;
  }
}

/** Text shown on the clicked button while its request is in flight. */
export function pendingLabel(action: StationAction): string {
  switch (action.type) {
    case "START": return "Starting…";
    case "PAUSE": return "Pausing…";
    case "RESUME": return "Resuming…";
    case "ADD_TIME": return "Adding time…";
    case "SET_REMAINING": return "Setting time…";
    case "END": return "Ending…";
    case "LOCK": return "Expiring…";
    case "SHOW_ADVERTISING": return "Showing ads…";
    case "SWITCH_INPUT": return "Switching…";
    case "REMOTE_KEY": return "Sending…";
    case "REMOTE_TAP": return "Touching…";
    case "SET_CONNECTION": return action.connection === "OFFLINE" ? "Disconnecting…" : "Reconnecting…";
    case "SIMULATE_NEXT_FAILURE": return "Arming…";
    case "SIMULATE_UNSUPPORTED": return "Applying…";
  }
}

/** Short name of an action for errors and announcements. */
export function actionTitle(action: StationAction): string {
  switch (action.type) {
    case "START": return `Start ${formatDurationLabel(action.durationMs)}`;
    case "PAUSE": return "Pause";
    case "RESUME": return "Resume";
    case "ADD_TIME": return `Add ${formatDurationLabel(action.durationMs)}`;
    case "SET_REMAINING": return `Set remaining to ${formatHM(action.durationMs)}`;
    case "END": return "End session";
    case "LOCK": return "Expired screen";
    case "SHOW_ADVERTISING": return "Advertising";
    case "SWITCH_INPUT": return `Switch to ${action.input}`;
    case "REMOTE_KEY": return `Remote ${action.key.replaceAll("_", " ")}`;
    case "REMOTE_TAP": return "Touch the TV screen";
    case "SET_CONNECTION": return action.connection === "OFFLINE" ? "Disconnect TV" : "Reconnect TV";
    case "SIMULATE_NEXT_FAILURE": return "Fail next command";
    case "SIMULATE_UNSUPPORTED": return action.enabled ? "Simulate unsupported" : "Restore capabilities";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Warnings, outcomes, and expired-screen evidence

export type Threshold = 10 | 5 | 1;
export const THRESHOLDS: readonly Threshold[] = [10, 5, 1];

export interface WarningLevel { threshold: Threshold; tone: "amber" | "red"; text: string }

/** Ending-soon warning for a running session. Paused, expired, and idle stations never warn. */
export function warningLevel(remaining: number, status: SessionStatus): WarningLevel | null {
  if (status !== "ACTIVE") return null;
  if (remaining <= 1 * MINUTE_MS) return { threshold: 1, tone: "red", text: "Ending" };
  if (remaining <= 5 * MINUTE_MS) return { threshold: 5, tone: "amber", text: "5 min left" };
  if (remaining <= 10 * MINUTE_MS) return { threshold: 10, tone: "amber", text: "Ends in 10m" };
  return null;
}

export type Tone = "ok" | "amber" | "red";

export function outcomeTone(outcome: CommandOutcome): Tone {
  if (outcome === "FAILURE" || outcome === "DEVICE_OFFLINE") return "red";
  if (outcome === "TIMEOUT" || outcome === "UNVERIFIED" || outcome === "UNSUPPORTED") return "amber";
  return "ok";
}

export function blockingLabel(status: BlockingStatus): string {
  switch (status) {
    case "NOT_APPLICABLE": return "Not needed";
    case "PENDING": return "Sending";
    case "CONFIRMED": return "Shown";
    case "FAILED": return "NOT shown";
    case "UNVERIFIED": return "Not confirmed";
  }
}

export interface Banner { tone: "red" | "amber" | "info"; text: string; retry: boolean }

/** Evidence for the expired screen, shown only while the station is in expired mode. Never claims a secure lock. */
export function expiredScreenBanner(station: StationView): Banner | null {
  if (station.mode !== "EXPIRED") return null;
  switch (station.blockingStatus) {
    case "FAILED":
      return { tone: "red", text: "Expired screen NOT shown — TV did not confirm. Go to the station.", retry: true };
    case "UNVERIFIED":
    case "PENDING":
      return { tone: "amber", text: "Expired screen sent — not confirmed", retry: false };
    case "CONFIRMED":
      return {
        tone: "info",
        text: station.simulated
          ? "Expired screen shown (simulated · software only)"
          : "Expired screen shown (software only — the customer can still change input)",
        retry: false,
      };
    case "NOT_APPLICABLE":
      return null;
  }
}

/**
 * What the TV reports differs from what the server expects. Only meaningful while the TV is reachable, and never for a
 * screen-only TV, which reports nothing.
 */
export function previewMismatch(station: StationView): string | null {
  if (station.adapterKind === "screen-only") return null;
  if (station.connection !== "ONLINE" || station.deviceState.displayedMode === station.mode) return null;
  return `Mismatch: TV shows ${station.deviceState.displayedMode}, expected ${station.mode}`;
}

export function offlineNotice(station: StationView): string | null {
  if (station.connection !== "OFFLINE") return null;
  if (station.session.status === "ACTIVE") {
    return "TV offline — timer continues on the server; expired screen cannot be shown until it reconnects";
  }
  if (station.session.status === "PAUSED") {
    return "TV offline — session stays paused on the server; the TV cannot be switched until it reconnects";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// TV thumbnail

export type ThumbnailKind = "offline" | "connecting" | "ads" | "reserved" | "playing" | "paused" | "expired";

export interface Thumbnail {
  kind: ThumbnailKind;
  title: string;
  detail: string;
  /**
   * Whether the TV's screen page (ads, QR code, reserved or expired notice) is open on the TV right now. Null when the
   * TV should be on the PS5 instead, or the server is too old to say.
   */
  screen: "open" | "not-open" | null;
  /** A session is running or paused, so the time left belongs in the corner (like the timer box on the TV). */
  showsTime: boolean;
  mismatch: string | null;
}

const LAST_SHOWN: Record<StationView["deviceState"]["displayedMode"], string> = {
  IDLE: "ads", PLAYING: "the PS5", EXPIRED: "the expired screen",
};

/**
 * What a TV's thumbnail draws: what the TV reports showing (deviceState) and whether its screen page is open. It is a
 * drawing of that state, never a capture of the TV's picture.
 */
export function thumbnailFor(station: StationView): Thumbnail {
  const status = station.session.status;
  const shown = station.deviceState.displayedMode;
  const base = { showsTime: status === "ACTIVE" || status === "PAUSED", mismatch: previewMismatch(station) };
  if (station.adapterKind === "screen-only") return screenOnlyThumbnail(station, base);
  if (station.connection === "OFFLINE") {
    return { ...base, kind: "offline", title: "Offline", detail: `Not answering · last showed ${LAST_SHOWN[shown]}`, screen: null };
  }
  if (station.connection === "CONNECTING") return { ...base, kind: "connecting", title: "Connecting…", detail: "Waiting for the TV to answer", screen: null };
  if (shown === "PLAYING") {
    return { ...base, kind: status === "PAUSED" ? "paused" : "playing", title: status === "PAUSED" ? "Paused" : "PS5", detail: station.deviceState.input, screen: null };
  }
  const screen = station.screenOnline === undefined ? null : station.screenOnline ? "open" : "not-open";
  if (shown === "EXPIRED") return { ...base, kind: "expired", title: "Time expired", detail: "No QR code until you end it", screen };
  if (station.reservation?.status === "HELD") return { ...base, kind: "reserved", title: "Reserved", detail: "Waiting for payment", screen };
  return { ...base, kind: "ads", title: "Ads · QR code", detail: "Free to book", screen };
}

/**
 * A live screen-only TV reports nothing itself. What is known: its screen page is showing (it polls while visible), and
 * its companion app is alive (connection: any poll, including the timer box's while the page is hidden).
 */
function screenOnlyThumbnail(station: StationView, base: Pick<Thumbnail, "showsTime" | "mismatch">): Thumbnail {
  const open = station.screenOnline === true;
  const screen = open ? "open" : "not-open";
  const running = base.showsTime;
  const paused = station.session.status === "PAUSED";
  if (!open && station.connection !== "ONLINE") {
    return { ...base, kind: "offline", title: "Offline", detail: running ? "Not answering · timer still runs" : "Screen link not open on this TV", screen: null };
  }
  if (station.mode === "EXPIRED") {
    return { ...base, kind: "expired", title: "Time expired", detail: open ? "No QR code until you end it" : "TV is on another input", screen };
  }
  if (running) {
    return open
      ? { ...base, kind: paused ? "paused" : "playing", title: paused ? "Paused" : "Switch to the PS5", detail: "TV still shows the session screen", screen }
      : { ...base, kind: paused ? "paused" : "playing", title: paused ? "Paused" : "PS5", detail: "TV on another input · app running", screen: null };
  }
  if (station.reservation?.status === "HELD") return { ...base, kind: "reserved", title: "Reserved", detail: "Waiting for payment", screen };
  return { ...base, kind: "ads", title: "Ads · QR code", detail: open ? "Free to book" : "Hidden · TV is on another input", screen };
}

export interface LiveLabel { tone: "live" | "info" | "amber"; text: string }

/** Whether the live view of a TV's screen page is what the TV shows right now. Only the page's own polls can say so. */
export function liveScreenLabel(station: StationView): LiveLabel {
  if (station.screenOnline) return { tone: "live", text: "● Live: this is on the TV now" };
  if (station.session.status === "ACTIVE" || station.session.status === "PAUSED") {
    return { tone: "info", text: "Not on the TV right now: it should be on the PS5. The game itself is never shown here." };
  }
  if (station.adapterKind === "screen-only" && station.connection === "ONLINE") {
    return { tone: "amber", text: "Not on the TV right now: the TV is on another input. This is what its screen page shows." };
  }
  return { tone: "amber", text: "Not open on the TV right now. This is what its screen link shows." };
}

/** File sizes for the Media Manager: 812 KB, 4.2 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

/** Colour of the corner time, matching the timer box on the TV: amber from 10 minutes left, red in the last minute. */
export function timeTone(remaining: number): Tone {
  if (remaining <= MINUTE_MS) return "red";
  if (remaining <= 10 * MINUTE_MS) return "amber";
  return "ok";
}

// ---------------------------------------------------------------------------------------------------------------
// Attention, summary, and announcements

export type AttentionReason = "SCREEN_FAILED" | "OFFLINE_SESSION" | "SCREEN_UNVERIFIED" | "ENDING_SOON";

export interface AttentionItem {
  stationId: string;
  name: string;
  number: number;
  reason: AttentionReason;
  severity: number;
  text: string;
  remainingMs: number;
}

function attentionFor(station: StationView, serverNow: number): AttentionItem | null {
  const remaining = remainingMs(station, serverNow);
  const base = { stationId: station.id, name: station.name, number: station.number, remainingMs: remaining };
  const running = station.session.status === "ACTIVE" || station.session.status === "PAUSED";
  if (station.blockingStatus === "FAILED") return { ...base, reason: "SCREEN_FAILED", severity: 0, text: "Expired screen NOT shown" };
  if (station.connection === "OFFLINE" && running) return { ...base, reason: "OFFLINE_SESSION", severity: 1, text: "TV offline during a session" };
  if (station.blockingStatus === "UNVERIFIED") return { ...base, reason: "SCREEN_UNVERIFIED", severity: 2, text: "Expired screen not confirmed" };
  if (station.session.status === "ACTIVE" && remaining <= 5 * MINUTE_MS) {
    const minutes = Math.ceil(remaining / MINUTE_MS);
    return { ...base, reason: "ENDING_SOON", severity: 3, text: remaining <= MINUTE_MS ? "Ending" : `Ends in ${minutes} min` };
  }
  return null;
}

/** One entry per station that needs the operator, most severe first. */
export function attentionItems(stations: readonly StationView[], serverNow: number): AttentionItem[] {
  return stations
    .map((station) => attentionFor(station, serverNow))
    .filter((item): item is AttentionItem => item !== null)
    .sort((a, b) => a.severity - b.severity || a.remainingMs - b.remainingMs || a.number - b.number);
}

export interface SummaryCounts { playing: number; paused: number; idle: number; expired: number; offline: number; attention: number }

export function summaryCounts(stations: readonly StationView[], serverNow: number): SummaryCounts {
  const count = (predicate: (station: StationView) => boolean) => stations.filter(predicate).length;
  return {
    playing: count((station) => station.session.status === "ACTIVE"),
    paused: count((station) => station.session.status === "PAUSED"),
    idle: count((station) => station.session.status === "NONE" || station.session.status === "ENDED"),
    expired: count((station) => station.session.status === "EXPIRED"),
    offline: count((station) => station.connection === "OFFLINE"),
    attention: attentionItems(stations, serverNow).length,
  };
}

export type AnnouncedMap = ReadonlyMap<string, ReadonlySet<Threshold>>;

/**
 * Ending-soon announcements, each made once per station, session start, and threshold. A threshold re-arms when the
 * remaining time is lifted above it again (ADD_TIME / SET_REMAINING). When several thresholds are crossed at once
 * only the most urgent is spoken.
 */
export function nextAnnouncements(
  stations: readonly StationView[],
  serverNow: number,
  announced: AnnouncedMap,
): { messages: string[]; announced: Map<string, Set<Threshold>> } {
  const next = new Map<string, Set<Threshold>>();
  const messages: string[] = [];
  for (const station of stations) {
    const key = `${station.id}:${station.session.startedAt ?? "none"}`;
    const previous = announced.get(key);
    if (station.session.status === "PAUSED") {
      if (previous) next.set(key, new Set(previous));
      continue;
    }
    if (station.session.status !== "ACTIVE") continue;
    const remaining = remainingMs(station, serverNow);
    const crossed = THRESHOLDS.filter((threshold) => remaining <= threshold * MINUTE_MS);
    const fresh = crossed.filter((threshold) => !previous?.has(threshold));
    if (crossed.length > 0) next.set(key, new Set(crossed));
    if (fresh.length > 0) {
      const threshold = Math.min(...fresh);
      messages.push(`${station.name}: ${minutesText(threshold)} left`);
    }
  }
  return { messages, announced: next };
}

// ---------------------------------------------------------------------------------------------------------------
// Live-data freshness

export const STALE_AFTER_MS = 3_000;

/** Live data is stale when the socket is down or no snapshot has arrived recently. Uses the local clock, never serverTime. */
export function isStale(nowLocal: number, lastSnapshotAt: number | null, connected: boolean, staleAfterMs = STALE_AFTER_MS): boolean {
  if (!connected || lastSnapshotAt === null) return true;
  return nowLocal - lastSnapshotAt > staleAfterMs;
}

/** The mock adapter reports every capability false while "unsupported" is being simulated. */
export function simulatingUnsupported(station: StationView): boolean {
  return !Object.values(station.capabilities).some(Boolean);
}

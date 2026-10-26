import { describe, expect, it } from "vitest";
import type { SessionStatus, StationView } from "@ps5-cafe/contracts";
import {
  allowedActions, attentionItems, confirmationFor, durationFields, endsAtText, expiredScreenBanner, formatClock, formatDurationLabel,
  formatHM, formatTime, isStale, MINUTE_MS, nextAnnouncements, offlineNotice, outcomeTone, parseCustomDuration, PRESETS, presetMs,
  formatBytes, liveScreenLabel, previewMismatch, remainingMs, setRemainingChange, summaryCounts, thumbnailFor, timeTone, warningLevel,
} from "./logic.js";

const NOW = 1_800_000_000_000;

type Overrides = Partial<Omit<StationView, "session" | "deviceState">> & {
  session?: Partial<StationView["session"]>;
  deviceState?: Partial<StationView["deviceState"]>;
};

function station(overrides: Overrides = {}): StationView {
  const { session, deviceState, ...rest } = overrides;
  return {
    id: "ps5-03",
    number: 3,
    name: "PS5-03",
    adapterKind: "mock",
    simulated: true,
    connection: "ONLINE",
    mode: "IDLE",
    blockingStatus: "NOT_APPLICABLE",
    hdmiInput: "HDMI1",
    capabilities: {
      power: true, volume: true, mute: true, remoteKeys: true, inputSwitching: true, applicationLaunch: true,
      advertisingPlayback: true, stateVerification: true, secureDisplayBlocking: false,
    },
    lastCommand: null,
    ...rest,
    deviceState: { power: true, volume: 20, muted: false, input: "APP:advertising", displayedMode: "IDLE", ...deviceState },
    session: { status: "NONE", startedAt: null, deadlineAt: null, pausedRemainingMs: null, remainingMs: 0, ...session },
  };
}

function active(remaining: number, extra: Overrides = {}): StationView {
  return station({
    mode: "PLAYING",
    deviceState: { displayedMode: "PLAYING", input: "HDMI1" },
    ...extra,
    session: { status: "ACTIVE", startedAt: NOW - 3_600_000, deadlineAt: NOW + remaining, remainingMs: remaining, ...extra.session },
  });
}

function paused(remaining: number, extra: Overrides = {}): StationView {
  return station({
    mode: "PLAYING",
    deviceState: { displayedMode: "PLAYING", input: "HDMI1" },
    ...extra,
    session: { status: "PAUSED", startedAt: NOW - 3_600_000, pausedRemainingMs: remaining, remainingMs: remaining, ...extra.session },
  });
}

describe("allowedActions", () => {
  it.each<[SessionStatus, string[]]>([
    ["NONE", ["PRESETS", "CUSTOM", "ADVERTISING"]],
    ["ENDED", ["PRESETS", "CUSTOM", "ADVERTISING"]],
    ["ACTIVE", ["PAUSE", "ADD_TIME", "SET_REMAINING", "END", "EXPIRE_NOW"]],
    ["PAUSED", ["RESUME", "ADD_TIME", "SET_REMAINING", "END"]],
    ["EXPIRED", ["PRESETS", "CUSTOM", "ADD_TIME", "END", "ADVERTISING", "RETRY_EXPIRED_SCREEN"]],
  ])("%s offers exactly %j", (status, expected) => {
    expect([...allowedActions(status)]).toEqual(expected);
  });

  it("never offers Start or Advertising while a session is running", () => {
    for (const status of ["ACTIVE", "PAUSED"] as const) {
      expect(allowedActions(status)).not.toContain("PRESETS");
      expect(allowedActions(status)).not.toContain("CUSTOM");
      expect(allowedActions(status)).not.toContain("ADVERTISING");
    }
    expect(allowedActions("NONE")).not.toContain("PAUSE");
    expect(allowedActions("NONE")).not.toContain("ADD_TIME");
  });
});

describe("presets", () => {
  it("map to the exact START durations", () => {
    expect(presetMs("15m")).toBe(900_000);
    expect(presetMs("30m")).toBe(1_800_000);
    expect(presetMs("1h")).toBe(3_600_000);
    expect(presetMs("2h")).toBe(7_200_000);
    expect(presetMs("3h")).toBe(10_800_000);
    expect(PRESETS.map((preset) => preset.label)).toEqual(["15m", "30m", "1h", "2h", "3h"]);
  });
});

describe("parseCustomDuration", () => {
  it("accepts whole minutes from 1 minute to 24 hours", () => {
    expect(parseCustomDuration("1", "20")).toEqual({ ok: true, ms: 80 * MINUTE_MS, minutes: 80 });
    expect(parseCustomDuration("", "1")).toEqual({ ok: true, ms: MINUTE_MS, minutes: 1 });
    expect(parseCustomDuration("24", "")).toEqual({ ok: true, ms: 24 * 60 * MINUTE_MS, minutes: 1440 });
    expect(parseCustomDuration(" 2 ", " 05 ")).toMatchObject({ ok: true, minutes: 125 });
    expect(parseCustomDuration("", "90")).toMatchObject({ ok: true, minutes: 90 });
  });

  it("rejects zero", () => {
    expect(parseCustomDuration("0", "0")).toMatchObject({ ok: false, code: "TOO_SHORT" });
    expect(parseCustomDuration("", "0")).toMatchObject({ ok: false, code: "TOO_SHORT" });
  });

  it("rejects more than 24 hours", () => {
    expect(parseCustomDuration("24", "1")).toMatchObject({ ok: false, code: "TOO_LONG" });
    expect(parseCustomDuration("25", "")).toMatchObject({ ok: false, code: "TOO_LONG" });
    expect(parseCustomDuration("", "1441")).toMatchObject({ ok: false, code: "TOO_LONG" });
  });

  it("rejects non-digits", () => {
    for (const [hours, minutes] of [["1.5", ""], ["-1", ""], ["", "1e3"], ["abc", ""], ["", "٣"], ["1", "+5"], ["", "10000"]] as const) {
      expect(parseCustomDuration(hours, minutes)).toMatchObject({ ok: false, code: "NOT_WHOLE_NUMBER" });
    }
  });

  it("requires a value", () => {
    expect(parseCustomDuration("", "  ")).toMatchObject({ ok: false, code: "EMPTY" });
  });
});

describe("formatting", () => {
  it("formats timers, durations, and H:MM", () => {
    expect(formatTime(3_600_000)).toBe("01:00:00");
    expect(formatTime(1)).toBe("00:00:01");
    expect(formatTime(-5)).toBe("00:00:00");
    expect(formatDurationLabel(80 * MINUTE_MS)).toBe("1h 20m");
    expect(formatDurationLabel(45 * MINUTE_MS)).toBe("45m");
    expect(formatDurationLabel(120 * MINUTE_MS)).toBe("2h");
    expect(formatHM(15 * MINUTE_MS)).toBe("0:15");
    expect(formatHM(65 * MINUTE_MS + 30_000)).toBe("1:05");
    // The timer shows 01:06:00 for 65:59.4, so H:MM and the prefilled fields say 1:06 too.
    expect(formatHM(65 * MINUTE_MS + 59_400)).toBe("1:06");
    expect(durationFields(47 * MINUTE_MS + 30_000)).toEqual({ hours: "0", minutes: "47" });
    expect(durationFields(79 * MINUTE_MS + 59_400)).toEqual({ hours: "1", minutes: "20" });
  });

  it("marks end times on a fast-forwarded clock", () => {
    const start = new Date(2026, 9, 25, 14, 0, 0).getTime();
    expect(formatClock(start + 95 * MINUTE_MS)).toBe("15:35");
    expect(formatClock(start + 5_000, true)).toBe("14:00:05");
    expect(endsAtText(start, 80 * MINUTE_MS, 0)).toBe("Ends at 15:20");
    expect(endsAtText(start, 80 * MINUTE_MS, 5 * MINUTE_MS)).toBe("Ends at 15:20 (simulated clock)");
  });
});

describe("remainingMs", () => {
  it("uses the deadline while active and the stored value while paused", () => {
    expect(remainingMs(active(10 * MINUTE_MS), NOW + MINUTE_MS)).toBe(9 * MINUTE_MS);
    expect(remainingMs(active(10 * MINUTE_MS), NOW + 11 * MINUTE_MS)).toBe(0);
    expect(remainingMs(paused(7 * MINUTE_MS), NOW + 60 * MINUTE_MS)).toBe(7 * MINUTE_MS);
    expect(remainingMs(station(), NOW)).toBe(0);
  });
});

describe("setRemainingChange", () => {
  it("compares in whole minutes", () => {
    expect(setRemainingChange(47 * MINUTE_MS + 30_000, 15 * MINUTE_MS)).toEqual({ kind: "lower", deltaMinutes: 32 });
    expect(setRemainingChange(47 * MINUTE_MS + 30_000, 62 * MINUTE_MS)).toEqual({ kind: "raise", deltaMinutes: 15 });
    expect(setRemainingChange(47 * MINUTE_MS + 30_000, 47 * MINUTE_MS)).toEqual({ kind: "same", deltaMinutes: 0 });
    // 79:59.4 displays as 01:20:00: raising to 2:00 adds 40 minutes, not 41.
    expect(setRemainingChange(79 * MINUTE_MS + 59_400, 120 * MINUTE_MS)).toEqual({ kind: "raise", deltaMinutes: 40 });
  });
});

describe("confirmationFor", () => {
  it("lets routine actions through", () => {
    expect(confirmationFor(station(), { type: "START", durationMs: 3_600_000 }, 0)).toBeNull();
    expect(confirmationFor(active(MINUTE_MS * 30), { type: "ADD_TIME", durationMs: 1_800_000 }, MINUTE_MS * 30)).toBeNull();
    expect(confirmationFor(active(MINUTE_MS * 30), { type: "PAUSE" }, MINUTE_MS * 30)).toBeNull();
    expect(confirmationFor(paused(MINUTE_MS * 30), { type: "RESUME" }, MINUTE_MS * 30)).toBeNull();
    expect(confirmationFor(active(MINUTE_MS * 30), { type: "SET_REMAINING", durationMs: MINUTE_MS * 45 }, MINUTE_MS * 30)).toBeNull();
    expect(confirmationFor(station({ session: { status: "EXPIRED" } }), { type: "END" }, 0)).toBeNull();
    expect(confirmationFor(station({ session: { status: "EXPIRED" } }), { type: "LOCK" }, 0)).toBeNull();
  });

  it("warns before starting on an offline TV", () => {
    const result = confirmationFor(station({ connection: "OFFLINE" }), { type: "START", durationMs: 3_600_000 }, 0);
    expect(result?.body).toContain("TV offline: the timer starts on the server but the TV will not switch.");
    expect(result?.tone).toBe("warning");
  });

  it("confirms End and Expire now on a running session with a safe default", () => {
    const end = confirmationFor(paused(20 * MINUTE_MS), { type: "END" }, 20 * MINUTE_MS);
    expect(end).toMatchObject({ tone: "danger", confirmLabel: "End session on PS5-03", safeLabel: "Keep session" });
    const expire = confirmationFor(active(20 * MINUTE_MS), { type: "LOCK" }, 20 * MINUTE_MS);
    expect(expire).toMatchObject({ tone: "danger", confirmLabel: "Expire PS5-03 now", safeLabel: "Keep playing" });
    expect(expire?.body.join(" ")).toContain("software only");
  });

  it("confirms a reduction with the minutes lost", () => {
    const result = confirmationFor(active(47 * MINUTE_MS + 30_000), { type: "SET_REMAINING", durationMs: 15 * MINUTE_MS }, 47 * MINUTE_MS + 30_000);
    expect(result).toMatchObject({ title: "Reduce PS5-03 to 0:15?", confirmLabel: "Reduce PS5-03 to 0:15" });
    expect(result?.body).toContain("Customer loses 32 minutes.");
    const pausedResult = confirmationFor(paused(47 * MINUTE_MS), { type: "SET_REMAINING", durationMs: 15 * MINUTE_MS }, 47 * MINUTE_MS);
    expect(pausedResult?.body).toContain("Session stays paused.");
  });
});

describe("warningLevel", () => {
  it("warns at 10, 5, and 1 minute for active sessions only", () => {
    expect(warningLevel(10 * MINUTE_MS + 1, "ACTIVE")).toBeNull();
    expect(warningLevel(10 * MINUTE_MS, "ACTIVE")).toEqual({ threshold: 10, tone: "amber", text: "Ends in 10m" });
    expect(warningLevel(5 * MINUTE_MS + 1, "ACTIVE")?.threshold).toBe(10);
    expect(warningLevel(5 * MINUTE_MS, "ACTIVE")).toEqual({ threshold: 5, tone: "amber", text: "5 min left" });
    expect(warningLevel(MINUTE_MS, "ACTIVE")).toEqual({ threshold: 1, tone: "red", text: "Ending" });
    expect(warningLevel(0, "ACTIVE")?.tone).toBe("red");
    for (const status of ["NONE", "PAUSED", "EXPIRED", "ENDED"] as const) expect(warningLevel(30_000, status)).toBeNull();
  });
});

describe("nextAnnouncements", () => {
  it("announces each threshold once and re-arms when time is added", () => {
    let state = nextAnnouncements([active(20 * MINUTE_MS)], NOW, new Map());
    expect(state.messages).toEqual([]);
    state = nextAnnouncements([active(20 * MINUTE_MS)], NOW + 10 * MINUTE_MS, state.announced);
    expect(state.messages).toEqual(["PS5-03: 10 minutes left"]);
    state = nextAnnouncements([active(20 * MINUTE_MS)], NOW + 10 * MINUTE_MS + 1_000, state.announced);
    expect(state.messages).toEqual([]);
    state = nextAnnouncements([active(20 * MINUTE_MS)], NOW + 15 * MINUTE_MS, state.announced);
    expect(state.messages).toEqual(["PS5-03: 5 minutes left"]);
    // ADD_TIME / SET_REMAINING: same session start, deadline pushed beyond both thresholds.
    const extended = active(40 * MINUTE_MS);
    state = nextAnnouncements([extended], NOW + 15 * MINUTE_MS, state.announced);
    expect(state.messages).toEqual([]);
    state = nextAnnouncements([extended], NOW + 35 * MINUTE_MS, state.announced);
    expect(state.messages).toEqual(["PS5-03: 5 minutes left"]);
  });

  it("speaks only the most urgent threshold when several are crossed at once", () => {
    const state = nextAnnouncements([active(30_000)], NOW, new Map());
    expect(state.messages).toEqual(["PS5-03: 1 minute left"]);
    expect([...(state.announced.values().next().value ?? [])].sort((a, b) => a - b)).toEqual([1, 5, 10]);
  });

  it("keys by session start, so a new session announces again", () => {
    const first = nextAnnouncements([active(4 * MINUTE_MS)], NOW, new Map());
    const restarted = active(4 * MINUTE_MS, { session: { startedAt: NOW } });
    expect(nextAnnouncements([restarted], NOW, first.announced).messages).toEqual(["PS5-03: 5 minutes left"]);
  });

  it("keeps state through a pause and drops it after the session ends", () => {
    const first = nextAnnouncements([active(4 * MINUTE_MS)], NOW, new Map());
    const whilePaused = nextAnnouncements([paused(4 * MINUTE_MS)], NOW, first.announced);
    expect(whilePaused.messages).toEqual([]);
    expect(nextAnnouncements([active(4 * MINUTE_MS)], NOW, whilePaused.announced).messages).toEqual([]);
    const ended = nextAnnouncements([station({ session: { status: "ENDED" } })], NOW, whilePaused.announced);
    expect(ended.announced.size).toBe(0);
  });
});

describe("expired-screen evidence and preview", () => {
  const expired = (blockingStatus: StationView["blockingStatus"], extra: Overrides = {}) =>
    station({ mode: "EXPIRED", blockingStatus, session: { status: "EXPIRED" }, ...extra });

  it("never reports a failed or unverified screen as shown", () => {
    expect(expiredScreenBanner(expired("FAILED"))).toEqual({ tone: "red", text: "Expired screen NOT shown — TV did not confirm. Go to the station.", retry: true });
    expect(expiredScreenBanner(expired("UNVERIFIED"))).toMatchObject({ tone: "amber", text: "Expired screen sent — not confirmed" });
    expect(expiredScreenBanner(expired("PENDING"))?.tone).toBe("amber");
    expect(expiredScreenBanner(expired("CONFIRMED"))?.text).toBe("Expired screen shown (simulated · software only)");
    expect(expiredScreenBanner(expired("CONFIRMED", { simulated: false }))?.text).toContain("software only");
    expect(expiredScreenBanner(active(MINUTE_MS))).toBeNull();
  });

  it("flags a TV that shows something other than the server's mode", () => {
    const missed = expired("FAILED", { deviceState: { displayedMode: "PLAYING" } });
    expect(previewMismatch(missed)).toBe("Mismatch: TV shows PLAYING, expected EXPIRED");
    expect(previewMismatch({ ...missed, connection: "OFFLINE" })).toBeNull();
    expect(previewMismatch(active(MINUTE_MS))).toBeNull();
  });

  it("explains an offline TV during a session", () => {
    expect(offlineNotice(active(MINUTE_MS, { connection: "OFFLINE" }))).toBe(
      "TV offline — timer continues on the server; expired screen cannot be shown until it reconnects",
    );
    expect(offlineNotice(paused(MINUTE_MS, { connection: "OFFLINE" }))).toContain("paused");
    expect(offlineNotice(station({ connection: "OFFLINE" }))).toBeNull();
  });

  it("colours outcomes amber or red, never success", () => {
    expect(outcomeTone("SUCCESS")).toBe("ok");
    for (const outcome of ["TIMEOUT", "UNVERIFIED", "UNSUPPORTED"] as const) expect(outcomeTone(outcome)).toBe("amber");
    for (const outcome of ["FAILURE", "DEVICE_OFFLINE"] as const) expect(outcomeTone(outcome)).toBe("red");
  });
});

describe("attention and summary", () => {
  const failed = station({ id: "ps5-07", number: 7, name: "PS5-07", mode: "EXPIRED", blockingStatus: "FAILED", session: { status: "EXPIRED" } });
  const unverified = station({ id: "ps5-02", number: 2, name: "PS5-02", mode: "EXPIRED", blockingStatus: "UNVERIFIED", session: { status: "EXPIRED" } });
  const offlineRunning = active(40 * MINUTE_MS, { id: "ps5-09", number: 9, name: "PS5-09", connection: "OFFLINE" });
  const ending = active(4 * MINUTE_MS, { id: "ps5-01", number: 1, name: "PS5-01" });
  const endingSooner = active(30_000, { id: "ps5-05", number: 5, name: "PS5-05" });
  const fine = active(40 * MINUTE_MS, { id: "ps5-04", number: 4, name: "PS5-04" });
  const pausedOne = paused(3 * MINUTE_MS, { id: "ps5-06", number: 6, name: "PS5-06" });
  const idleOffline = station({ id: "ps5-08", number: 8, name: "PS5-08", connection: "OFFLINE" });
  const all = [ending, unverified, fine, endingSooner, pausedOne, failed, idleOffline, offlineRunning];

  it("lists stations needing attention in severity order", () => {
    expect(attentionItems(all, NOW).map((item) => [item.name, item.reason])).toEqual([
      ["PS5-07", "SCREEN_FAILED"],
      ["PS5-09", "OFFLINE_SESSION"],
      ["PS5-02", "SCREEN_UNVERIFIED"],
      ["PS5-05", "ENDING_SOON"],
      ["PS5-01", "ENDING_SOON"],
    ]);
  });

  it("counts paused separately from playing", () => {
    expect(summaryCounts(all, NOW)).toEqual({ playing: 4, paused: 1, idle: 1, expired: 2, offline: 2, attention: 5 });
  });
});

describe("isStale", () => {
  it("is stale when disconnected, never updated, or older than 3 s on the local clock", () => {
    expect(isStale(10_000, 9_000, true)).toBe(false);
    expect(isStale(12_000, 9_000, true)).toBe(false);
    expect(isStale(12_001, 9_000, true)).toBe(true);
    expect(isStale(9_500, 9_000, false)).toBe(true);
    expect(isStale(9_500, null, true)).toBe(true);
  });
});

describe("TV thumbnail", () => {
  const expiredTv = (extra: Overrides = {}) => station({
    mode: "EXPIRED", blockingStatus: "CONFIRMED", deviceState: { displayedMode: "EXPIRED", input: "APP:expired" }, ...extra,
    session: { status: "EXPIRED", startedAt: NOW - 3_600_000, deadlineAt: NOW - 1 },
  });
  const held = { id: "r1", ref: "BWR32B", status: "HELD" as const, durationMs: 7_200_000, createdAt: NOW, holdUntil: NOW + 600_000, phone: "0123456789" };

  it("draws what the TV reports, with the session time only while a session runs", () => {
    expect(thumbnailFor(station({ screenOnline: true }))).toEqual({ kind: "ads", title: "Ads · QR code", detail: "Free to book", screen: "open", showsTime: false, mismatch: null });
    expect(thumbnailFor(active(MINUTE_MS))).toMatchObject({ kind: "playing", title: "PS5", detail: "HDMI1", screen: null, showsTime: true });
    expect(thumbnailFor(paused(MINUTE_MS))).toMatchObject({ kind: "paused", title: "Paused", showsTime: true });
    expect(thumbnailFor(station({ reservation: held, screenOnline: true }))).toMatchObject({ kind: "reserved", title: "Reserved", showsTime: false });
  });

  it("says an expired TV offers no QR code, which is why it cannot be booked", () => {
    expect(thumbnailFor(expiredTv({ screenOnline: true }))).toMatchObject({ kind: "expired", detail: "No QR code until you end it", showsTime: false });
  });

  it("shows offline and connecting TVs as such, keeping a running session's time", () => {
    expect(thumbnailFor(active(MINUTE_MS, { connection: "OFFLINE" }))).toMatchObject({
      kind: "offline", title: "Offline", detail: "Not answering · last showed the PS5", screen: null, showsTime: true, mismatch: null,
    });
    expect(thumbnailFor(station({ connection: "OFFLINE" })).detail).toBe("Not answering · last showed ads");
    expect(thumbnailFor(station({ connection: "CONNECTING" }))).toMatchObject({ kind: "connecting", screen: null });
  });

  it("says whether the screen link is really open on the TV, and nothing when the server cannot tell", () => {
    expect(thumbnailFor(station({ screenOnline: false })).screen).toBe("not-open");
    expect(thumbnailFor(expiredTv({ screenOnline: false })).screen).toBe("not-open");
    expect(thumbnailFor(station()).screen).toBeNull();
  });

  it("keeps a TV that shows the wrong thing visible as a mismatch", () => {
    const bypassed = expiredTv({ blockingStatus: "FAILED", deviceState: { displayedMode: "PLAYING", input: "HDMI1" } });
    expect(thumbnailFor(bypassed)).toMatchObject({ kind: "playing", mismatch: "Mismatch: TV shows PLAYING, expected EXPIRED" });
  });

  it("colours the corner time like the TV's timer box", () => {
    expect(timeTone(10 * MINUTE_MS + 1)).toBe("ok");
    expect(timeTone(10 * MINUTE_MS)).toBe("amber");
    expect(timeTone(MINUTE_MS + 1)).toBe("amber");
    expect(timeTone(MINUTE_MS)).toBe("red");
    expect(timeTone(0)).toBe("red");
  });
});

describe("TV thumbnail for a live, screen-only TV", () => {
  const live = (extra: Overrides = {}) => station({ adapterKind: "screen-only", simulated: false, connection: "OFFLINE", screenOnline: false, ...extra });
  const on = { connection: "ONLINE" as const };

  it("is offline when neither its page nor its app polls", () => {
    expect(thumbnailFor(live())).toMatchObject({ kind: "offline", detail: "Screen link not open on this TV", screen: null });
    expect(thumbnailFor(live({ session: { status: "ACTIVE", remainingMs: MINUTE_MS } }))).toMatchObject({ kind: "offline", detail: "Not answering · timer still runs", showsTime: true });
  });

  it("draws what the screen page shows while it is open", () => {
    expect(thumbnailFor(live({ ...on, screenOnline: true }))).toMatchObject({ kind: "ads", detail: "Free to book", screen: "open" });
    expect(thumbnailFor(live({ ...on, screenOnline: true, mode: "PLAYING", session: { status: "ACTIVE", remainingMs: MINUTE_MS } })))
      .toMatchObject({ kind: "playing", title: "Switch to the PS5", screen: "open" });
    expect(thumbnailFor(live({ ...on, screenOnline: true, mode: "EXPIRED", session: { status: "EXPIRED" } })))
      .toMatchObject({ kind: "expired", detail: "No QR code until you end it", screen: "open" });
  });

  it("knows only that the TV is on another input when the app polls but the page is hidden", () => {
    expect(thumbnailFor(live({ ...on, mode: "PLAYING", session: { status: "ACTIVE", remainingMs: MINUTE_MS } })))
      .toMatchObject({ kind: "playing", title: "PS5", detail: "TV on another input · app running", screen: null });
    expect(thumbnailFor(live({ ...on, mode: "EXPIRED", session: { status: "EXPIRED" } })))
      .toMatchObject({ kind: "expired", detail: "TV is on another input", screen: "not-open" });
    expect(thumbnailFor(live({ ...on }))).toMatchObject({ kind: "ads", detail: "Hidden · TV is on another input", screen: "not-open" });
  });

  it("never claims a mismatch from device state a screen-only TV does not report", () => {
    const expired = live({ ...on, mode: "EXPIRED", deviceState: { displayedMode: "IDLE" }, session: { status: "EXPIRED" } });
    expect(previewMismatch(expired)).toBeNull();
    expect(thumbnailFor(expired).mismatch).toBeNull();
  });
});

describe("live view label", () => {
  it("calls the view live only while the TV's own screen page polls", () => {
    expect(liveScreenLabel(station({ screenOnline: true }))).toEqual({ tone: "live", text: "● Live: this is on the TV now" });
    expect(liveScreenLabel(active(MINUTE_MS, { screenOnline: false })).text).toContain("should be on the PS5. The game itself is never shown here.");
    expect(liveScreenLabel(station({ adapterKind: "screen-only", connection: "ONLINE", screenOnline: false })).text).toContain("on another input");
    expect(liveScreenLabel(station({ adapterKind: "screen-only", connection: "OFFLINE", screenOnline: false })).text).toBe("Not open on the TV right now. This is what its screen link shows.");
    expect(liveScreenLabel(station()).tone).toBe("amber");
  });
});

describe("formatBytes", () => {
  it("reads naturally", () => {
    expect([512, 2048, 831_488, 4_404_019, 100 * 1024 * 1024].map(formatBytes)).toEqual(["512 B", "2 KB", "812 KB", "4.2 MB", "100 MB"]);
  });
});

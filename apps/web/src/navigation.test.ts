import { describe, expect, it } from "vitest";
import type { SessionStatus, StationView } from "@ps5-cafe/contracts";
import { allowedActions, MINUTE_MS, summaryCounts } from "./logic.js";
import { type Filter, FILTERS, filterStations, NAV_ITEMS, parseRoute, remoteHref, stationHref, statusLabel, tileActions, tvShowsLabel } from "./navigation.js";

const NOW = 1_800_000_000_000;
const STATUSES: SessionStatus[] = ["NONE", "ACTIVE", "PAUSED", "EXPIRED", "ENDED"];

function station(id: string, status: SessionStatus, extra: Partial<StationView> = {}, remaining = 60 * MINUTE_MS): StationView {
  return {
    id, number: Number(id.slice(-2)), name: id.toUpperCase(), adapterKind: "mock", simulated: true, connection: "ONLINE",
    mode: status === "ACTIVE" || status === "PAUSED" ? "PLAYING" : status === "EXPIRED" ? "EXPIRED" : "IDLE",
    blockingStatus: status === "EXPIRED" ? "CONFIRMED" : "NOT_APPLICABLE", hdmiInput: "HDMI1",
    capabilities: { power: true, volume: true, mute: true, remoteKeys: true, inputSwitching: true, applicationLaunch: true, advertisingPlayback: true, stateVerification: true, secureDisplayBlocking: false },
    deviceState: { power: true, volume: 25, muted: false, input: "HDMI1", displayedMode: status === "EXPIRED" ? "EXPIRED" : status === "ACTIVE" || status === "PAUSED" ? "PLAYING" : "IDLE" },
    session: {
      status, startedAt: NOW - MINUTE_MS,
      deadlineAt: status === "ACTIVE" ? NOW + remaining : null,
      pausedRemainingMs: status === "PAUSED" ? remaining : null,
      remainingMs: status === "ACTIVE" || status === "PAUSED" ? remaining : 0,
    },
    lastCommand: null,
    ...extra,
  };
}

describe("parseRoute", () => {
  it.each([
    ["", { page: "dashboard", stationId: null }],
    ["#", { page: "dashboard", stationId: null }],
    ["#/", { page: "dashboard", stationId: null }],
    ["#/dashboard", { page: "dashboard", stationId: null }],
    ["#/station/ps5-03", { page: "dashboard", stationId: "ps5-03" }],
    ["#/remote", { page: "remote", stationId: null }],
    ["#/remote/ps5-07", { page: "remote", stationId: "ps5-07" }],
    ["#/media", { page: "media" }],
    ["#/devices", { page: "devices" }],
    ["#/settings", { page: "settings" }],
  ])("parses %j", (hash, expected) => {
    expect(parseRoute(hash)).toEqual(expected);
  });

  it("falls back to the dashboard for unknown pages and ignores malformed station ids", () => {
    expect(parseRoute("#/nope")).toEqual({ page: "dashboard", stationId: null });
    expect(parseRoute("#/station/<script>")).toEqual({ page: "dashboard", stationId: null });
    expect(parseRoute("#/remote/PS5 01")).toEqual({ page: "remote", stationId: null });
  });

  it("round-trips the hrefs it produces", () => {
    expect(parseRoute(stationHref("ps5-10"))).toEqual({ page: "dashboard", stationId: "ps5-10" });
    expect(parseRoute(remoteHref("ps5-02"))).toEqual({ page: "remote", stationId: "ps5-02" });
    for (const item of NAV_ITEMS) expect(parseRoute(item.href).page).toBe(item.page);
  });
});

describe("navigation areas", () => {
  it("keeps exactly the five required areas, in order", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual(["Dashboard", "TV Remote", "Media Manager", "Device Settings", "System Settings"]);
  });
});

describe("filterStations", () => {
  const stations = [
    station("ps5-01", "ACTIVE"),
    station("ps5-02", "ACTIVE", {}, 4 * MINUTE_MS), // ending soon -> needs attention
    station("ps5-03", "PAUSED"),
    station("ps5-04", "NONE"),
    station("ps5-05", "ENDED"),
    station("ps5-06", "EXPIRED"),
    station("ps5-07", "EXPIRED", { blockingStatus: "FAILED" }),
    station("ps5-08", "NONE", { connection: "OFFLINE" }),
  ];

  it("returns every station for All", () => {
    expect(filterStations(stations, "all", NOW)).toHaveLength(stations.length);
  });

  it("matches the summary counts for every filter", () => {
    const counts = summaryCounts(stations, NOW);
    const expected: Record<Exclude<Filter, "all">, number> = {
      reserved: stations.filter((s) => s.reservation?.status === "HELD").length,
      playing: counts.playing, paused: counts.paused, idle: counts.idle, expired: counts.expired, offline: counts.offline, attention: counts.attention,
    };
    for (const [filter, count] of Object.entries(expected)) expect(filterStations(stations, filter as Filter, NOW), filter).toHaveLength(count);
  });

  it("puts the right stations in each bucket", () => {
    const ids = (filter: Filter) => filterStations(stations, filter, NOW).map((s) => s.id);
    expect(ids("playing")).toEqual(["ps5-01", "ps5-02"]);
    expect(ids("idle")).toEqual(["ps5-04", "ps5-05", "ps5-08"]);
    expect(ids("offline")).toEqual(["ps5-08"]);
    expect(ids("attention")).toContain("ps5-07");
    expect(ids("attention")).toContain("ps5-02");
  });

  it("offers a filter for every bucket", () => {
    expect(FILTERS.map((filter) => filter.id)).toEqual(["all", "reserved", "playing", "paused", "idle", "expired", "offline", "attention"]);
  });
});

describe("tile actions", () => {
  it.each(STATUSES)("only offers actions the full card allows for %s", (status) => {
    const allowed = allowedActions(status);
    for (const action of tileActions(status)) expect(allowed).toContain(action);
  });

  it("never offers Start on a running session", () => {
    expect(tileActions("ACTIVE")).not.toContain("PRESETS");
    expect(tileActions("PAUSED")).not.toContain("PRESETS");
  });

  it("labels statuses in plain language", () => {
    expect(STATUSES.map(statusLabel)).toEqual(["Idle", "Playing", "Paused", "Expired", "Idle"]);
  });
});

describe("tvShowsLabel", () => {
  it("reports what a controllable TV says, and nothing invented for a screen-only TV", () => {
    expect(tvShowsLabel(station("ps5-01", "ACTIVE"))).toMatch(/^Playing · |^Idle · |^Expired · /);
    expect(tvShowsLabel(station("ps5-02", "NONE", { adapterKind: "screen-only", screenOnline: false }))).toBe("Not reported");
    expect(tvShowsLabel(station("ps5-03", "NONE", { adapterKind: "screen-only", screenOnline: true }))).toBe("Its screen page");
  });
});

import type { SessionStatus, StationView } from "@ps5-cafe/contracts";
import { attentionItems } from "./logic.js";

// Hash routes keep navigation inside the single page and make the browser/phone back button work, with no router library.

export type Page = "dashboard" | "remote" | "media" | "devices" | "settings";
export type Route =
  | { page: "dashboard"; stationId: string | null }
  | { page: "remote"; stationId: string | null }
  | { page: "media" | "devices" | "settings" };

export interface NavItem { page: Page; label: string; short: string; href: string; soon?: boolean }

/** The five navigation areas required by AGENTS.md. `short` is the bottom-bar label on phones. */
export const NAV_ITEMS: readonly NavItem[] = [
  { page: "dashboard", label: "Dashboard", short: "Stations", href: "#/" },
  { page: "remote", label: "TV Remote", short: "Remote", href: "#/remote" },
  { page: "media", label: "Media Manager", short: "Media", href: "#/media" },
  { page: "devices", label: "Device Settings", short: "Devices", href: "#/devices" },
  { page: "settings", label: "System Settings", short: "System", href: "#/settings" },
];

const STATION_ID = /^[a-z0-9-]{1,40}$/;

/** Parses `location.hash`. Unknown or malformed hashes fall back to the dashboard rather than a blank page. */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const [head, id] = parts;
  const stationId = id !== undefined && STATION_ID.test(id) ? id : null;
  switch (head) {
    case undefined:
    case "dashboard": return { page: "dashboard", stationId: null };
    case "station": return { page: "dashboard", stationId };
    case "remote": return { page: "remote", stationId };
    case "media":
    case "devices":
    case "settings": return { page: head };
    default: return { page: "dashboard", stationId: null };
  }
}

/** Pages for the TV itself and for customers' phones. They never use the staff token and have no staff navigation. */
export type PublicRoute =
  /** `preview`: the dashboard's live view of a TV's screen page, which must never count as the TV itself. */
  | { kind: "screen"; stationId: string; key: string; preview: boolean }
  | { kind: "book"; stationId: string; code: string };

export function parsePublicRoute(hash: string): PublicRoute | null {
  const match = /^#\/(screen|book)\/([a-z0-9-]{1,40})(?:\?(.*))?$/.exec(hash);
  if (!match) return null;
  const params = new URLSearchParams(match[3] ?? "");
  if (match[1] === "screen") {
    const key = params.get("k");
    return key ? { kind: "screen", stationId: match[2]!, key, preview: params.get("preview") === "1" } : null;
  }
  const code = params.get("c");
  return code ? { kind: "book", stationId: match[2]!, code } : null;
}

/** What each TV opens full-screen (in its browser or the companion app); `preview` is the dashboard's live view of it. */
export const screenUrl = (origin: string, stationId: string, key: string, preview = false) =>
  `${origin}/#/screen/${encodeURIComponent(stationId)}?k=${encodeURIComponent(key)}${preview ? "&preview=1" : ""}`;

/** What a TV's QR code points customers' phones at. */
export const bookingUrl = (origin: string, stationId: string, code: string) =>
  `${origin}/#/book/${encodeURIComponent(stationId)}?c=${encodeURIComponent(code)}`;

export const stationHref = (stationId: string) => `#/station/${encodeURIComponent(stationId)}`;
export const remoteHref = (stationId: string) => `#/remote/${encodeURIComponent(stationId)}`;

export type Filter = "all" | "reserved" | "playing" | "paused" | "idle" | "expired" | "offline" | "attention";

export const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "reserved", label: "Reserved" },
  { id: "playing", label: "Playing" },
  { id: "paused", label: "Paused" },
  { id: "idle", label: "Idle" },
  { id: "expired", label: "Expired" },
  { id: "offline", label: "Offline" },
  { id: "attention", label: "Needs attention" },
];

/** Same buckets as `summaryCounts`, so a tile's count always equals the number of stations its filter shows. */
export function filterStations(stations: readonly StationView[], filter: Filter, serverNow: number): StationView[] {
  if (filter === "attention") {
    const ids = new Set(attentionItems(stations, serverNow).map((item) => item.stationId));
    return stations.filter((station) => ids.has(station.id));
  }
  return stations.filter((station) => {
    const status = station.session.status;
    switch (filter) {
      case "all": return true;
      case "reserved": return station.reservation?.status === "HELD";
      case "playing": return status === "ACTIVE";
      case "paused": return status === "PAUSED";
      case "idle": return status === "NONE" || status === "ENDED";
      case "expired": return status === "EXPIRED";
      case "offline": return station.connection === "OFFLINE";
    }
  });
}

/** "PLAYING" -> "Playing", "APP:expired" stays as is only when mixed-case. For enum values shown to people. */
/** What the TV is showing, as far as anyone can tell. A screen-only TV reports nothing; only its screen page's polls say anything. */
export function tvShowsLabel(station: StationView): string {
  if (station.adapterKind === "screen-only") return station.screenOnline ? "Its screen page" : "Not reported";
  return `${sentenceCase(station.deviceState.displayedMode)} · ${station.deviceState.input}`;
}

export function sentenceCase(value: string): string {
  return value === value.toUpperCase() ? value.charAt(0) + value.slice(1).toLowerCase() : value;
}

/** "ONLINE" -> "Online": connection states in sentence case for display. */
export function connectionLabel(connection: StationView["connection"]): string {
  return connection === "ONLINE" ? "Online" : connection === "OFFLINE" ? "Offline" : "Connecting";
}

/** Plain-language session state for the compact tile. */
export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "ACTIVE": return "Playing";
    case "PAUSED": return "Paused";
    case "EXPIRED": return "Expired";
    case "NONE":
    case "ENDED": return "Idle";
  }
}

/**
 * The few actions a compact tile offers directly; everything else lives in the station's detail panel. Every one of
 * them is also in `allowedActions`, so the tile never offers something the full card would refuse.
 */
export type TileAction = "PRESETS" | "ADD_TIME" | "PAUSE" | "RESUME" | "END";

export function tileActions(status: SessionStatus): readonly TileAction[] {
  switch (status) {
    case "NONE":
    case "ENDED": return ["PRESETS"];
    case "ACTIVE": return ["ADD_TIME", "PAUSE", "END"];
    case "PAUSED": return ["RESUME", "ADD_TIME", "END"];
    case "EXPIRED": return ["ADD_TIME", "END"];
  }
}

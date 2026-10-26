import type { ReservationView } from "@ps5-cafe/contracts";
import { formatDurationLabel } from "./logic.js";

// Pure helpers for QR reservations, shared by the staff dashboard, the TV screen and the booking page.

/** "+60123456789" -> "012-345 6789"; "+601123456789" -> "011-2345 6789". Unknown shapes are shown unchanged. */
export function formatMalaysianMobile(e164: string): string {
  const match = /^\+60(1\d)(\d{3,4})(\d{4})$/.exec(e164);
  return match ? `0${match[1]}-${match[2]} ${match[3]}` : e164;
}

/** "m:ss" left, never negative. */
export function countdown(untilMs: number, nowMs: number): string {
  const total = Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The single line staff see on a reserved tile, e.g. "Reserved · 1h · 012-345 6789 · 8:12 left". */
export function reservationLine(reservation: ReservationView, serverNow: number): string {
  const parts = [reservation.status === "HELD" ? "Reserved" : "Booked session", formatDurationLabel(reservation.durationMs)];
  if (reservation.phone) parts.push(formatMalaysianMobile(reservation.phone));
  if (reservation.status === "HELD") parts.push(`${countdown(reservation.holdUntil, serverNow)} left`);
  return parts.join(" · ");
}

/**
 * The ADB command that points a TV's companion app at its screen page (copied from Device Settings). The outer double quotes
 * carry the inner single quotes through to the TV's own shell, so the URL stays one argument there too.
 */
export function adbConfigureCommand(url: string): string {
  const safe = url.replace(/[^\w.~:/?#@%&=+,;-]/g, "");
  return `adb shell "am start -n com.ps5cafe.tvcompanion/.MainActivity --es url '${safe}'"`;
}

/**
 * The origin TV links use: the server computer's `.local` name when it has one (it survives DHCP address changes, which
 * otherwise cut every TV off), else its LAN address. Same scheme and port as the dashboard.
 */
export function tvLinkOrigin(origin: string, hostName: string | null | undefined, lanAddresses: readonly string[]): string {
  if (!hostName) return lanOrigin(origin, lanAddresses);
  const url = new URL(origin);
  url.hostname = hostName;
  return url.origin;
}

/** Replaces a localhost origin with the server's LAN address, so links copied for TVs work from other devices. */
export function lanOrigin(origin: string, lanAddresses: readonly string[]): string {
  const url = new URL(origin);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || lanAddresses.length === 0) return origin;
  url.hostname = lanAddresses[0]!;
  return url.origin;
}

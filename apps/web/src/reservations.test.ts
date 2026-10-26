import { describe, expect, it } from "vitest";
import type { ReservationView } from "@ps5-cafe/contracts";
import { bookingUrl, parsePublicRoute, parseRoute, screenUrl } from "./navigation.js";
import { adbConfigureCommand, countdown, formatMalaysianMobile, lanOrigin, reservationLine, tvLinkOrigin } from "./reservations.js";

const held: ReservationView = { id: "r1", ref: "K7Q2P9", status: "HELD", durationMs: 60 * 60_000, createdAt: 0, holdUntil: 600_000, phone: "+60123456789" };

describe("reservation helpers", () => {
  it.each([["+60123456789", "012-345 6789"], ["+601123456789", "011-2345 6789"], ["+6512345678", "+6512345678"]])(
    "formats %s as %s", (input, expected) => expect(formatMalaysianMobile(input)).toBe(expected),
  );

  it("counts down in m:ss and never goes negative", () => {
    expect(countdown(600_000, 0)).toBe("10:00");
    expect(countdown(600_000, 599_001)).toBe("0:01");
    expect(countdown(600_000, 700_000)).toBe("0:00");
  });

  it("summarises a reservation for the staff tile", () => {
    expect(reservationLine(held, 108_000)).toBe("Reserved · 1h · 012-345 6789 · 8:12 left");
    expect(reservationLine({ ...held, status: "STARTED", phone: null }, 0)).toBe("Booked session · 1h");
  });

  it("builds the companion-app command without letting the URL break out of its quotes", () => {
    expect(adbConfigureCommand("http://192.168.1.5:5173/#/screen/ps5-01?k=a_b-c"))
      .toBe(`adb shell "am start -n com.ps5cafe.tvcompanion/.MainActivity --es url 'http://192.168.1.5:5173/#/screen/ps5-01?k=a_b-c'"`);
    for (const hostile of ["http://x/'; rm -rf /'", 'http://x/"; reboot; "', "http://x/$(reboot)", "http://x/`reboot`", "http://x/a b!"]) {
      expect(adbConfigureCommand(hostile)).toMatch(/^adb shell "am start -n com\.ps5cafe\.tvcompanion\/\.MainActivity --es url '[^'"$`\\\s!]*'"$/);
    }
  });

  it("swaps localhost for the LAN address so links work on TVs", () => {
    expect(lanOrigin("http://localhost:5173", ["192.168.100.65"])).toBe("http://192.168.100.65:5173");
    // TV links prefer the computer's .local name, which survives DHCP address changes; same scheme and port.
    expect(tvLinkOrigin("http://192.168.100.202:8080", "Craves-MacBook-Air.local", ["192.168.100.202"])).toBe("http://craves-macbook-air.local:8080");
    expect(tvLinkOrigin("http://localhost:5173", null, ["10.0.0.2"])).toBe("http://10.0.0.2:5173");
    expect(lanOrigin("http://127.0.0.1:5173", ["10.0.0.2"])).toBe("http://10.0.0.2:5173");
    expect(lanOrigin("http://192.168.100.65:5173", ["10.0.0.2"])).toBe("http://192.168.100.65:5173");
    expect(lanOrigin("http://localhost:5173", [])).toBe("http://localhost:5173");
  });
});

describe("public routes", () => {
  it("round-trips TV screen and booking links", () => {
    const screen = screenUrl("http://192.168.1.5:5173", "ps5-03", "Ab3_dE-f");
    expect(parsePublicRoute(new URL(screen).hash)).toEqual({ kind: "screen", stationId: "ps5-03", key: "Ab3_dE-f", preview: false });
    const preview = screenUrl("http://192.168.1.5:5173", "ps5-03", "Ab3_dE-f", true);
    expect(preview).toBe("http://192.168.1.5:5173/#/screen/ps5-03?k=Ab3_dE-f&preview=1");
    expect(parsePublicRoute(new URL(preview).hash)).toMatchObject({ kind: "screen", key: "Ab3_dE-f", preview: true });
    const book = bookingUrl("http://192.168.1.5:5173", "ps5-03", "K7Q2P9AB");
    expect(parsePublicRoute(new URL(book).hash)).toEqual({ kind: "book", stationId: "ps5-03", code: "K7Q2P9AB" });
  });

  it("ignores staff routes and malformed public ones", () => {
    for (const hash of ["", "#/", "#/station/ps5-01", "#/screen/ps5-01", "#/book/ps5-01", "#/screen/BAD ID?k=x", "#/book/ps5-01?x=1"]) {
      expect(parsePublicRoute(hash), hash).toBeNull();
    }
  });

  it("never sends a public link to a staff page", () => {
    expect(parseRoute("#/screen/ps5-01?k=abc").page).toBe("dashboard");
  });
});

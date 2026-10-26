import { describe, expect, it } from "vitest";
import { bookingOriginFor, localHostName } from "./network.js";

describe("addresses for TVs and phones", () => {
  it("recognises a Bonjour name only", () => {
    expect(localHostName("Craves-MacBook-Air.local")).toBe("Craves-MacBook-Air.local");
    for (const name of ["Craves-MacBook-Air", "evil.example.com", "a.b.local", "", "-x.local/../"]) expect(localHostName(name), name).toBeNull();
  });

  it("sends phones to the computer's current address when the TV loaded by name", () => {
    expect(bookingOriginFor("Craves-MacBook-Air.local:8080", "http", ["192.168.100.202"])).toBe("http://192.168.100.202:8080");
    expect(bookingOriginFor("localhost:5173", "http", ["10.0.0.4", "192.168.1.9"])).toBe("http://10.0.0.4:5173");
    expect(bookingOriginFor("127.0.0.1:8080", "http", ["192.168.100.202"])).toBe("http://192.168.100.202:8080");
  });

  it("keeps an address the TV already used, and degrades without one", () => {
    expect(bookingOriginFor("192.168.100.244:8080", "http", ["192.168.100.202"])).toBe("http://192.168.100.244:8080");
    expect(bookingOriginFor("Craves-MacBook-Air.local", "http", [])).toBe("http://craves-macbook-air.local"); // host names are case-insensitive
    expect(bookingOriginFor("bad host header", "http", ["192.168.1.9"])).toBe("http://192.168.1.9");
  });
});

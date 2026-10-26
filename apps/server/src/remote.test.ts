import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdbDeviceList, StationView } from "@ps5-cafe/contracts";
import { Adb, type AdbRun } from "./adb.js";
import { buildApp } from "./app.js";
import { FakeClock } from "./clock.js";

const TOKEN = "remote-test-token-0123456789";
const staff = { authorization: `Bearer ${TOKEN}` };
const TV = "adb-3TB75R2514030183NSK0-Kciem4._adb-tls-connect._tcp";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 9)]);
let keySeq = 0;
const key = () => `remote-key-${String(++keySeq).padStart(4, "0")}`;

/** A pretend adb: answers like the real tool and records every argument list it was given. */
function fakeAdb(options: { fail?: boolean; dropped?: boolean; silent?: boolean } = {}) {
  const calls: string[][] = [];
  // `silent`: the TV is connected by address only and is not announcing itself (seen on the Hisense).
  let held = options.silent ? "192.168.100.170:43499" : options.dropped ? null : TV;
  const run: AdbRun = async (args) => {
    calls.push([...args]);
    if (options.fail && args[0] === "-s") throw new Error("device offline");
    const command = args.join(" ");
    if (command === "devices") return Buffer.from(`List of devices attached\n${held ? `${held}\tdevice\n` : ""}192.168.1.9:5555\toffline\n`);
    if (args[0] === "connect") { held = args[1]!; return Buffer.from(`connected to ${args[1]}`); }
    if (command === "mdns services" && options.silent) return Buffer.from("List of discovered mdns services\n");
    if (command.endsWith("getprop ro.serialno")) return Buffer.from(args[1] === "192.168.100.170:43499" ? "3TB75R2514030183NSK0\n" : "OTHER\n");
    if (command === "mdns services") return Buffer.from(`List of discovered mdns services\nadb-3TB75R2514030183NSK0-Kciem4\t_adb-tls-connect._tcp\t192.168.100.170:43499\nadb-OTHER\t_adb-tls-connect._tcp\t192.168.100.171:40001\n`);
    if (command.endsWith("wm size")) return Buffer.from("Physical size: 3840x2160\n");
    if (command.endsWith("screencap -p")) return PNG;
    if (args[0] === "pair") return Buffer.from(args[2] === "123456" ? `Successfully paired to ${args[1]} [guid=adb-NEW]` : "Failed: Wrong password or connection was dropped.");
    return Buffer.alloc(0);
  };
  return { run, calls };
}

describe("Adb", () => {
  it("lists connected devices and those announced by wireless debugging", async () => {
    const { run } = fakeAdb();
    expect(await new Adb(run).devices()).toEqual([
      { serial: TV, address: "192.168.100.170:43499", connected: true },
      { serial: "adb-OTHER._adb-tls-connect._tcp", address: "192.168.100.171:40001", connected: false },
    ]);
  });

  it("reconnects a TV whose link dropped, by its stable wireless-debugging name", async () => {
    const fake = fakeAdb({ dropped: true });
    const adb = new Adb(fake.run);
    await adb.key(TV, "HOME");
    expect(fake.calls.filter((call) => call[0] !== "devices" && call[0] !== "mdns")).toEqual([
      ["connect", "192.168.100.170:43499"],
      ["-s", "192.168.100.170:43499", "shell", "input", "keyevent", "3"],
    ]);
    expect((await adb.devices())[0]).toEqual({ serial: TV, address: "192.168.100.170:43499", connected: true });
  });

  it("finds a TV that stopped announcing itself by its serial number, and remembers the address", async () => {
    const fake = fakeAdb({ silent: true });
    const adb = new Adb(fake.run);
    const learned: string[] = [];
    adb.onAddress = (device, address) => learned.push(`${device} ${address}`);
    expect(await adb.status(TV)).toEqual({ connected: true, address: "192.168.100.170:43499" });
    await adb.key(TV, "WAKEUP");
    expect(fake.calls.at(-1)).toEqual(["-s", "192.168.100.170:43499", "shell", "input", "keyevent", "224"]);
    expect(learned).toEqual([`${TV} 192.168.100.170:43499`]);
    expect(adb.lastAddress(TV)).toBe("192.168.100.170:43499");
  });

  it("refuses device names that could smuggle in anything else", async () => {
    const adb = new Adb(fakeAdb().run);
    for (const serial of ["x;reboot", "a b", "$(reboot)", "", "x".repeat(200)]) await expect(adb.key(serial, "HOME"), serial).rejects.toThrow("Not a valid ADB device name");
  });
});

describe("remote control of a live TV over HTTP", () => {
  let app: FastifyInstance;
  let adb: ReturnType<typeof fakeAdb>;
  const build = async (databasePath = ":memory:", options: { fail?: boolean; noAdb?: boolean; simulationMode?: boolean } = {}) => {
    adb = fakeAdb(options);
    app = await buildApp({
      databasePath, apiToken: TOKEN, simulationMode: options.simulationMode ?? false, stationCount: 2, clock: new FakeClock(1_800_000_000_000),
      ...(options.noAdb ? {} : { adbRun: adb.run }),
    });
  };
  afterEach(async () => { await app.close(); });
  const assign = (device: unknown, station = "ps5-01") => app.inject({ method: "PUT", url: `/api/stations/${station}/remote`, headers: { ...staff, "idempotency-key": key() }, payload: { device } });
  const act = (body: object, station = "ps5-01") => app.inject({ method: "POST", url: `/api/stations/${station}/actions`, headers: { ...staff, "idempotency-key": key() }, payload: body });
  const station = async (id = "ps5-01") => (await app.inject({ method: "GET", url: "/api/snapshot", headers: staff })).json<{ stations: StationView[] }>().stations.find((s) => s.id === id)!;

  describe("with adb", () => {
    beforeEach(async () => { await build(); });

    it("offers the devices this computer can reach", async () => {
      const list = (await app.inject({ method: "GET", url: "/api/adb/devices", headers: staff })).json<AdbDeviceList>();
      expect(list.available).toBe(true);
      expect(list.devices.map((device) => device.serial)).toContain(TV);
      expect((await app.inject({ method: "GET", url: "/api/adb/devices" })).statusCode).toBe(401);
    });

    it("pairs a TV from its on-screen code, checking the input first", async () => {
      const pair = (payload: object) => app.inject({ method: "POST", url: "/api/adb/pair", headers: { ...staff, "idempotency-key": key() }, payload });
      expect((await pair({ address: "192.168.100.170:35285", code: "123456" })).json()).toEqual({ paired: true });
      expect((await pair({ address: "192.168.100.170:35285", code: "999999" })).statusCode).toBe(502);
      expect((await pair({ address: "192.168.100.170:35285; reboot", code: "123456" })).statusCode).toBe(400);
      expect((await pair({ address: "192.168.100.170:35285", code: "12345" })).statusCode).toBe(400);
      expect(adb.calls.filter((call) => call[0] === "pair")).toEqual([["pair", "192.168.100.170:35285", "123456"], ["pair", "192.168.100.170:35285", "999999"]]);
    });

    it("controls nothing until the owner assigns a device to the TV", async () => {
      expect((await station()).capabilities.remoteKeys).toBe(false);
      expect((await act({ type: "REMOTE_KEY", key: "HOME" })).json<StationView>().lastCommand).toMatchObject({ outcome: "UNSUPPORTED" });
      expect(adb.calls.filter((call) => call[0] === "-s")).toEqual([]);
    });

    it("sends documented key codes and taps in the TV's own pixels, recorded as unverified", async () => {
      expect((await assign(TV)).statusCode).toBe(200);
      expect(await station()).toMatchObject({ remote: { device: TV }, capabilities: { remoteKeys: true } });
      expect((await act({ type: "REMOTE_KEY", key: "INPUT" })).json<StationView>().lastCommand).toMatchObject({ outcome: "UNVERIFIED", verified: false });
      expect((await act({ type: "REMOTE_TAP", x: 0.5, y: 0.25 })).json<StationView>().lastCommand?.outcome).toBe("UNVERIFIED");
      expect(adb.calls.filter((call) => call[0] === "-s")).toEqual([
        ["-s", TV, "shell", "input", "keyevent", "178"],
        ["-s", TV, "shell", "wm", "size"],
        ["-s", TV, "shell", "input", "tap", "1920", "540"],
      ]);
      // Screen on/off as explicit keys: a display that stays "awake" when dark only ever sleeps on POWER.
      await act({ type: "REMOTE_KEY", key: "SLEEP" });
      await act({ type: "REMOTE_KEY", key: "WAKEUP" });
      expect(adb.calls.filter((call) => call.includes("keyevent")).map((call) => call.at(-1))).toEqual(["178", "223", "224"]);
      for (const bad of [{ x: 1.5, y: 0 }, { x: -0.1, y: 0 }, { x: "0.5", y: 0.5 }, { x: 0.5 }]) {
        expect((await act({ type: "REMOTE_TAP", ...bad })).statusCode, JSON.stringify(bad)).toBe(400);
      }
    });

    it("switches inputs through the TV's companion app, including back to its screen page", async () => {
      expect((await act({ type: "SWITCH_INPUT", input: "HDMI2" })).json<StationView>().lastCommand?.outcome).toBe("UNSUPPORTED");
      await assign(TV);
      expect((await station()).capabilities.inputSwitching).toBe(true);
      expect((await act({ type: "SWITCH_INPUT", input: "HDMI2" })).json<StationView>().lastCommand).toMatchObject({ outcome: "UNVERIFIED" });
      expect((await act({ type: "SWITCH_INPUT", input: "APP" })).json<StationView>().lastCommand?.message).toContain("its screen page");
      expect((await act({ type: "SWITCH_INPUT", input: "HDMI5" })).statusCode).toBe(400);
      expect(adb.calls.filter((call) => call.includes("am"))).toEqual([
        ["-s", TV, "shell", "am", "start", "-n", "com.ps5cafe.tvcompanion/.MainActivity", "--es", "show_input", "HDMI2"],
        ["-s", TV, "shell", "am", "start", "-n", "com.ps5cafe.tvcompanion/.MainActivity", "--es", "show_input", "APP"],
      ]);
    });

    it("gives a screenshot on demand, at most one per second per TV", async () => {
      expect((await app.inject({ method: "GET", url: "/api/stations/ps5-01/screenshot", headers: staff })).statusCode).toBe(404);
      await assign(TV);
      const shot = await app.inject({ method: "GET", url: "/api/stations/ps5-01/screenshot", headers: staff });
      expect(shot.statusCode).toBe(200);
      expect(shot.headers["content-type"]).toBe("image/png");
      expect(shot.headers["cache-control"]).toBe("no-store");
      expect(shot.rawPayload.equals(PNG)).toBe(true);
      expect((await app.inject({ method: "GET", url: "/api/stations/ps5-01/screenshot", headers: staff })).statusCode).toBe(429);
      expect((await app.inject({ method: "GET", url: "/api/stations/ps5-01/screenshot" })).statusCode).toBe(401);
    });

    it("refuses bad or doubled assignments, and removing one stops control", async () => {
      expect((await assign("x;reboot")).statusCode).toBe(400);
      expect((await assign(TV)).statusCode).toBe(200);
      expect((await assign(TV, "ps5-02")).json()).toMatchObject({ error: "That device already controls PS5-01." });
      const removed = await app.inject({ method: "DELETE", url: "/api/stations/ps5-01/remote", headers: { ...staff, "idempotency-key": key() } });
      expect(removed.json<StationView>()).toMatchObject({ remote: null, capabilities: { remoteKeys: false } });
    });
  });

  it("records a TV that does not answer as a failure, and a failed screenshot as 502", async () => {
    await build(":memory:", { fail: true });
    await assign(TV);
    expect((await act({ type: "REMOTE_KEY", key: "HOME" })).json<StationView>().lastCommand).toMatchObject({ outcome: "FAILURE" });
    expect((await app.inject({ method: "GET", url: "/api/stations/ps5-01/screenshot", headers: staff })).statusCode).toBe(502);
  });

  it("is unavailable without adb, and never offered for simulated TVs", async () => {
    await build(":memory:", { noAdb: true });
    expect((await app.inject({ method: "GET", url: "/api/adb/devices", headers: staff })).json()).toEqual({ available: false, devices: [] });
    expect((await assign(TV)).statusCode).toBe(409);
    await app.close();
    await build(":memory:", { simulationMode: true });
    expect((await assign(TV)).json()).toMatchObject({ error: "Remote control is only for live TVs." });
  });

  it("keeps the assignment across a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps5-remote-"));
    try {
      await build(path.join(dir, "live.sqlite"));
      await assign(TV);
      await app.close();
      await build(path.join(dir, "live.sqlite"));
      expect((await station()).remote).toEqual({ device: TV });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

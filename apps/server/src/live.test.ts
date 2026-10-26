import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScreenLinks, StationView, SystemSnapshot } from "@ps5-cafe/contracts";
import { buildApp } from "./app.js";
import { BookingService, EXPIRED_SCREEN_GRACE_MS, SCREEN_ONLINE_MS } from "./booking.js";
import { FakeClock } from "./clock.js";
import { liveTokenProblem } from "./config.js";
import { AppDatabase } from "./database.js";
import { createSystem, type TvManagementSystem } from "./system.js";

const TOKEN = "live-test-token-0123456789";
const staff = { authorization: `Bearer ${TOKEN}` };
const MINUTE = 60_000;
let keySeq = 0;
const key = () => `live-key-${String(++keySeq).padStart(4, "0")}`;

describe("live mode (screen-only TVs)", () => {
  let db: AppDatabase;
  let clock: FakeClock;
  let system: TvManagementSystem;
  let booking: BookingService;
  const view = (id = "ps5-01"): StationView => system.viewOf(id);
  const keyOf = (id: string) => booking.screenLinks().find((screen) => screen.stationId === id)!.key;
  const screenPoll = (id = "ps5-01") => booking.screenView(id, keyOf(id));
  const overlayPoll = (id = "ps5-01") => booking.screenView(id, keyOf(id), "overlay");
  const previewPoll = (id = "ps5-01") => booking.screenView(id, keyOf(id), "preview");

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    clock = new FakeClock(1_800_000_000_000);
    system = createSystem(db, false, 3, clock);
    booking = new BookingService(db, system);
    system.setViewExtension((stationId, base) => booking.extension(stationId, base));
  });
  afterEach(() => { system.dispose(); db.close(); });

  it("seeds real, screen-only TVs that report nothing and cannot be controlled", () => {
    const station = view();
    expect(station).toMatchObject({ adapterKind: "screen-only", simulated: false, connection: "OFFLINE", screenOnline: false });
    expect(Object.entries(station.capabilities).filter(([, can]) => can).map(([name]) => name)).toEqual(["advertisingPlayback"]);
    expect(system.snapshot()).toMatchObject({ simulationMode: false, acceleratedByMs: 0 });
  });

  it("runs sessions on the server; telling the TV is recorded as unverified, never as success", async () => {
    await system.action("ps5-01", { type: "START", durationMs: 60 * MINUTE });
    expect(view().session).toMatchObject({ status: "ACTIVE", remainingMs: 60 * MINUTE });
    expect(view().lastCommand).toMatchObject({ outcome: "UNVERIFIED", verified: false });
    expect(view().lastCommand!.message).toContain("with its remote");
    await expect(system.action("ps5-01", { type: "SWITCH_INPUT", input: "HDMI2" })).resolves.toMatchObject({ lastCommand: { outcome: "UNSUPPORTED" } });
  });

  it("refuses simulation controls and time acceleration", async () => {
    await expect(system.action("ps5-01", { type: "SET_CONNECTION", connection: "ONLINE" })).rejects.toThrow("only work on simulated TVs");
    await expect(system.action("ps5-01", { type: "SIMULATE_NEXT_FAILURE" })).rejects.toThrow("only work on simulated TVs");
    expect(() => system.advanceSimulation(MINUTE)).toThrow("disabled outside simulation mode");
    expect(view().connection).toBe("OFFLINE");
  });

  it("is online only while the TV's page or app polls, and says whether the screen is showing", () => {
    screenPoll();
    expect(view()).toMatchObject({ connection: "ONLINE", screenOnline: true });
    expect(view("ps5-02")).toMatchObject({ connection: "OFFLINE", screenOnline: false });
    // On the PS5 input: the page is hidden and silent, but the timer box still polls.
    clock.advance(SCREEN_ONLINE_MS);
    overlayPoll();
    expect(booking.reconcile()).toBe(true);
    expect(view()).toMatchObject({ connection: "ONLINE", screenOnline: false });
    clock.advance(SCREEN_ONLINE_MS);
    booking.reconcile();
    expect(view()).toMatchObject({ connection: "OFFLINE", screenOnline: false });
  });

  it("never takes a staff preview of the screen page as a sign of the TV", async () => {
    expect(previewPoll().station.id).toBe("ps5-01");
    expect(view()).toMatchObject({ connection: "OFFLINE", screenOnline: false, screenSeenAt: null });
    await system.action("ps5-01", { type: "START", durationMs: MINUTE });
    clock.advance(MINUTE);
    await system.reconcileExpired();
    clock.advance(EXPIRED_SCREEN_GRACE_MS);
    previewPoll();
    booking.reconcile();
    expect(view().blockingStatus).toBe("FAILED");
  });

  it("confirms the expired screen only from the screen page itself, after a short grace", async () => {
    await system.action("ps5-01", { type: "START", durationMs: MINUTE });
    overlayPoll(); // TV on the PS5, timer box running
    clock.advance(MINUTE);
    await system.reconcileExpired();
    expect(view()).toMatchObject({ mode: "EXPIRED", blockingStatus: "PENDING" });

    clock.advance(EXPIRED_SCREEN_GRACE_MS);
    overlayPoll();
    expect(booking.reconcile()).toBe(true); // pushed: nothing but time changed
    expect(view().blockingStatus).toBe("FAILED");

    screenPoll(); // the companion app brought the page to the front, or staff switched the input
    expect(view().blockingStatus).toBe("CONFIRMED");

    clock.advance(SCREEN_ONLINE_MS); // customer switched back to the PS5
    overlayPoll();
    booking.reconcile();
    expect(view().blockingStatus).toBe("FAILED");
  });

  it("never opens a database of the other kind, and leaves that file untouched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps5-live-"));
    try {
      const simulatedFile = path.join(dir, "simulated.sqlite");
      const simulated = new AppDatabase(simulatedFile);
      createSystem(simulated, true, 2, clock).dispose();
      simulated.close();
      const reopened = new AppDatabase(simulatedFile);
      expect(() => createSystem(reopened, false, 4, clock)).toThrow("live mode needs its own PS5_CAFE_DB_PATH");
      expect((reopened.raw.prepare("SELECT COUNT(*) AS n FROM stations").get() as { n: number }).n).toBe(2);
      reopened.close();
      expect(() => createSystem(db, true, 3, clock)).toThrow("run the simulation with its own PS5_CAFE_DB_PATH");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never accelerates live time, whatever an old setting says", () => {
    const other = new AppDatabase(":memory:");
    other.setSetting("simulationClockOffsetMs", String(60 * MINUTE));
    const live = createSystem(other, false, 1, clock);
    expect(live.now()).toBe(clock.now());
    live.dispose();
    other.close();
  });

  it("requires a long staff token that is not the development one", () => {
    expect(liveTokenProblem(false, "local-dev-token")).toContain("not the development token");
    expect(liveTokenProblem(false, "short")).toContain("at least 16 characters");
    expect(liveTokenProblem(false, TOKEN)).toBeNull();
    expect(liveTokenProblem(true, "local-dev-token")).toBeNull();
  });
});

describe("serving the web app in production", () => {
  let app: FastifyInstance;
  let webRoot: string;

  beforeEach(async () => {
    webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ps5-web-"));
    fs.mkdirSync(path.join(webRoot, "assets"));
    fs.writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>PS5 Cafe</title>");
    fs.writeFileSync(path.join(webRoot, "assets", "index-AbC123.js"), "console.log('app')");
    fs.writeFileSync(path.join(webRoot, "secret.txt"), "not public");
    app = await buildApp({ databasePath: ":memory:", apiToken: TOKEN, simulationMode: false, stationCount: 2, clock: new FakeClock(1_800_000_000_000), webRoot });
  });
  afterEach(async () => { await app.close(); fs.rmSync(webRoot, { recursive: true, force: true }); });

  it("serves the page and its built assets without a token", async () => {
    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["cache-control"]).toBe("no-cache");
    const script = await app.inject({ method: "GET", url: "/assets/index-AbC123.js" });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("text/javascript");
    expect(script.headers["cache-control"]).toContain("immutable");
  });

  it("serves nothing else from the folder, and the API still needs the token", async () => {
    for (const url of ["/assets/..%2Fsecret.txt", "/assets/%2E%2E%2Fsecret.txt", "/assets/.hidden.js", "/assets/missing-1.js", "/assets/index-AbC123.txt"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
    for (const url of ["/secret.txt", "/index.html", "/api/snapshot"]) expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
  });

  it("runs live over HTTP: screen-only TVs, no simulation endpoints", async () => {
    const snapshot = (await app.inject({ method: "GET", url: "/api/snapshot", headers: staff })).json<SystemSnapshot>();
    expect(snapshot.simulationMode).toBe(false);
    expect(snapshot.stations.map((station) => station.adapterKind)).toEqual(["screen-only", "screen-only"]);
    const advance = await app.inject({ method: "POST", url: "/api/simulation/advance", headers: { ...staff, "idempotency-key": key() }, payload: { durationMs: MINUTE } });
    expect(advance.statusCode).toBe(400);
    const offline = await app.inject({ method: "POST", url: "/api/stations/ps5-01/actions", headers: { ...staff, "idempotency-key": key() }, payload: { type: "SET_CONNECTION", connection: "OFFLINE" } });
    expect(offline.statusCode).toBe(400);
    const links = (await app.inject({ method: "GET", url: "/api/screens", headers: staff })).json<ScreenLinks>();
    expect((await app.inject({ method: "GET", url: `/api/screen/ps5-01?k=${encodeURIComponent(links.screens[0]!.key)}` })).statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/api/snapshot", headers: staff })).json<SystemSnapshot>();
    expect(after.stations[0]).toMatchObject({ connection: "ONLINE", screenOnline: true });
  });
});

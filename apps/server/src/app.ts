import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { Server as SocketIoServer } from "socket.io";
import { type Clock, SystemClock } from "./clock.js";
import { BookingRejectedError, BookingService } from "./booking.js";
import { AppDatabase, type StoredResponse } from "./database.js";
import { MEDIA_MAX_BYTES, MediaLibrary, MediaRejectedError } from "./media.js";
import { bookingOriginFor, lanAddresses, localHostName } from "./network.js";
import { Adb, AdbInputError, type AdbRun, execAdb } from "./adb.js";
import { RemoteRegistry, RemoteRejectedError } from "./remote.js";
import { RateLimiter } from "./ratelimit.js";
import { ActionRejectedError, createSystem, StationNotFoundError } from "./system.js";
import { parseAdvanceRequest, parseIdempotencyKey, parseStationAction, RequestValidationError } from "./validation.js";

export interface BuildAppOptions {
  databasePath: string;
  apiToken: string;
  simulationMode: boolean;
  stationCount: number;
  /** Base wall clock; tests inject a fake one. */
  clock?: Clock;
  /** Upper bound for each adapter call in wall-clock ms (default 5000). A call that exceeds it is recorded as TIMEOUT. */
  commandTimeoutMs?: number | undefined;
  /** How long a QR reservation holds a TV before it expires (default 10 minutes). */
  reservationHoldMs?: number | undefined;
  /** Folder of the built web app (index.html + assets/) to serve at `/`; omitted in development, where Vite serves it. */
  webRoot?: string | undefined;
  /** Folder of advertising files (default: `media/` beside the database; a fresh temporary folder for in-memory tests). */
  mediaDir?: string | undefined;
  /** Path of the adb tool for opt-in TV remote control; omitted or null means remote control is unavailable. */
  adbPath?: string | null | undefined;
  /** Tests replace the adb process with a fake. */
  adbRun?: AdbRun | undefined;
}

const IDEMPOTENCY_RETAIN_MS = 24 * 60 * 60 * 1000;
/** Matched route patterns reachable without a bearer token. Everything else, unknown routes included, is denied. */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  "/health",
  // Customer booking pages: guarded by the TV's rotating QR code or the reservation's own token, and rate limited.
  "/api/public/stations/:id/booking",
  "/api/public/stations/:id/reservations",
  "/api/public/reservations/:id",
  "/api/public/reservations/:id/cancel",
  // TV screen pages: guarded by that TV's screen key.
  "/api/screen/:id",
  // The built web app itself (only registered when webRoot is set). It holds no secrets: staff sign in on the page.
  "/",
  "/assets/:file",
  // Advertising files every idle TV plays: public content, served by safe library names only.
  "/media/:name",
]);
/** Types of the files Vite writes to assets/. Anything else there is not served. */
const WEB_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2",
};
/** Remote-control screenshots are on demand; this is the least time between two for one TV. */
const SCREENSHOT_INTERVAL_MS = 1_000;
/** Public request bodies are tiny; anything bigger is refused before parsing. */
const PUBLIC_BODY_LIMIT = 2_048;
/** How long shutdown waits for queued and in-flight commands to finish and persist before closing the database. */
const SHUTDOWN_DRAIN_MS = 2_000;

interface HandlerResult { statusCode: number; body: unknown }

function errorResult(error: unknown): HandlerResult | null {
  if (error instanceof StationNotFoundError) return { statusCode: 404, body: { error: error.message } };
  if (error instanceof BookingRejectedError) return { statusCode: error.statusCode, body: { error: error.message } };
  if (error instanceof MediaRejectedError) return { statusCode: error.statusCode, body: { error: error.message } };
  if (error instanceof RemoteRejectedError) return { statusCode: error.statusCode, body: { error: error.message } };
  if (error instanceof RequestValidationError || error instanceof ActionRejectedError) return { statusCode: 400, body: { error: error.message } };
  return null;
}

/**
 * Stored idempotent responses are kept for 24 h, far longer than a phone number may be (PDPA). Every `phone` field is
 * blanked in the stored copy only; the live response and the dashboard snapshots still carry it while it is needed.
 */
function redactForStorage(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body ?? null), (key, value: unknown) => (key === "phone" && value !== null ? null : value));
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

function bearerToken(header: unknown): string | undefined {
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

/** Resolves once `work` settles or `boundMs` passes, whichever is first. Never rejects. */
async function settleWithin(work: Promise<unknown>, boundMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, boundMs); }),
  ]);
  clearTimeout(timer);
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  if (typeof options.apiToken !== "string" || options.apiToken.trim() === "") {
    throw new Error("apiToken must be a non-empty, non-whitespace string");
  }
  // trustProxy only for loopback: in development the Vite proxy forwards each phone's address in X-Forwarded-For,
  // so rate limits apply per phone instead of to everyone at once. Remote clients cannot spoof it.
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", trustProxy: ["127.0.0.1", "::1"] });
  // The dashboard is same-origin (through the Vite proxy in development), so no foreign origin gets a CORS grant.
  await app.register(cors, { origin: false });
  const clock = options.clock ?? new SystemClock();
  const db = new AppDatabase(options.databasePath);
  const adb = options.adbRun ? new Adb(options.adbRun) : options.adbPath ? new Adb(execAdb(options.adbPath)) : null;
  const remotes = new RemoteRegistry(db, adb, () => clock.now());
  const system = createSystem(db, options.simulationMode, options.stationCount, clock, {
    commandTimeoutMs: options.commandTimeoutMs, remoteFor: (stationId) => remotes.controlFor(stationId),
  });
  // No `cors` option: the dashboard connects same-origin, and every socket must still present the token.
  const io = new SocketIoServer(app.server, { path: "/socket.io" });
  const booking = new BookingService(db, system, { holdMs: options.reservationHoldMs });
  const media = new MediaLibrary(options.mediaDir
    ?? (options.databasePath === ":memory:" ? fs.mkdtempSync(path.join(os.tmpdir(), "ps5-cafe-media-")) : path.join(path.dirname(options.databasePath), "media")));
  system.setViewExtension((stationId, base) => {
    const device = remotes.deviceOf(stationId);
    return { ...booking.extension(stationId, base), remote: device ? { device } : null };
  });
  // Runs from the 1 s tick: a failure is logged and retried next tick, never allowed to crash the process.
  const reconcileBookings = () => {
    try { if (booking.reconcile()) system.notifyChanged(); }
    catch (error) { app.log.error({ err: error }, "Reservation upkeep failed"); }
  };
  const limits = {
    info: new RateLimiter(30, 60_000),
    reserve: new RateLimiter(5, 10 * 60_000),
    status: new RateLimiter(120, 60_000),
    cancel: new RateLimiter(10, 10 * 60_000),
  };
  const inFlight = new Map<string, { fingerprint: string; result: Promise<StoredResponse> }>();

  const expectedTokenDigest = sha256(options.apiToken);
  /**
   * The only token check, shared by HTTP and Socket.IO. Non-strings never match; both sides are hashed to equal-length
   * digests so the comparison is constant-time regardless of the presented token's length.
   */
  const tokenMatches = (value: unknown): boolean => typeof value === "string" && timingSafeEqual(sha256(value), expectedTokenDigest);

  /**
   * Runs a mutating handler at most once per Idempotency-Key. Deterministic outcomes (2xx/4xx) are stored and
   * replayed; unexpected errors are not stored so the client may retry. Reusing a key for a different request is 422.
   */
  async function idempotent(request: FastifyRequest, reply: FastifyReply, handler: () => Promise<unknown>): Promise<FastifyReply> {
    let key: string;
    try { key = parseIdempotencyKey(request.headers["idempotency-key"]); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    // A file upload is fingerprinted by its bytes; turning a 100 MB Buffer into JSON text would be enormous.
    const body = Buffer.isBuffer(request.body) ? createHash("sha256").update(request.body).digest("hex") : JSON.stringify(request.body ?? null);
    const fingerprint = createHash("sha256").update(`${request.method} ${request.url}\n${body}`).digest("hex");
    const mismatch = () => reply.code(422).send({ error: "Idempotency-Key was already used for a different request" });

    const stored = db.getIdempotentResponse(key);
    if (stored) {
      if (stored.requestFingerprint !== fingerprint) return mismatch();
      return reply.code(stored.statusCode).header("idempotent-replayed", "true").send(stored.body);
    }
    const running = inFlight.get(key);
    if (running) {
      if (running.fingerprint !== fingerprint) return mismatch();
      const shared = await running.result;
      return reply.code(shared.statusCode).header("idempotent-replayed", "true").send(shared.body);
    }

    const result = (async (): Promise<StoredResponse> => {
      let outcome: HandlerResult;
      try { outcome = { statusCode: 200, body: await handler() }; }
      catch (error) {
        const known = errorResult(error);
        if (!known) throw error;
        outcome = known;
      }
      const response = { requestFingerprint: fingerprint, ...outcome };
      db.saveIdempotentResponse(key, { ...response, body: redactForStorage(response.body) }, clock.now(), IDEMPOTENCY_RETAIN_MS);
      return response;
    })();
    inFlight.set(key, { fingerprint, result });
    try {
      const response = await result;
      return reply.code(response.statusCode).send(response.body);
    } finally {
      inFlight.delete(key);
    }
  }

  // Unexpected failures must not leak internals (SQL, file paths, adapter text) to clients. 4xx keep Fastify's format.
  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) return reply.send(error);
    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(500).send({ error: "Internal Server Error" });
  });

  // Default-deny on the matched route pattern, never the raw URL: "/%61pi/..." and absolute-form request targets such
  // as "GET http://host/api/..." reach /api handlers without the raw URL starting with "/api/".
  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url;
    if (route !== undefined && PUBLIC_ROUTES.has(route)) return;
    if (!tokenMatches(bearerToken(request.headers.authorization))) return reply.code(401).send({ error: "Unauthorized" });
  });

  app.get("/health", async () => ({ ok: true, simulationMode: options.simulationMode }));

  if (options.webRoot) {
    const webRoot = options.webRoot;
    const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "Not found" });
    // Read per request: a rebuild while running must not leave the page pointing at old asset names.
    app.get("/", async (_request, reply) =>
      reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(await fs.promises.readFile(path.join(webRoot, "index.html"))));
    app.get<{ Params: { file: string } }>("/assets/:file", async (request, reply) => {
      const { file } = request.params;
      const type = WEB_CONTENT_TYPES[path.extname(file)];
      // Plain build file names only: no separators, no dot files, no traversal.
      if (!type || !/^[\w-]+(\.[\w-]+)+$/.test(file)) return notFound(reply);
      try {
        const body = await fs.promises.readFile(path.join(webRoot, "assets", file));
        return reply.type(type).header("cache-control", "public, max-age=31536000, immutable").header("x-content-type-options", "nosniff").send(body);
      } catch {
        return notFound(reply);
      }
    });
  }
  app.get("/api/snapshot", async () => system.snapshot());

  app.post<{ Params: { id: string } }>("/api/stations/:id/actions", async (request, reply) =>
    idempotent(request, reply, async () => {
      const action = parseStationAction(request.body);
      const view = await system.action(request.params.id, action);
      if (action.type !== "START") return view;
      // Staff starting a held TV is the reserved customer's session starting.
      booking.onStarted(request.params.id);
      system.notifyChanged();
      return system.viewOf(request.params.id);
    }));

  app.post<{ Params: { id: string } }>("/api/stations/:id/reservation/release", async (request, reply) =>
    idempotent(request, reply, async () => {
      booking.release(request.params.id);
      system.notifyChanged();
      return system.viewOf(request.params.id);
    }));

  app.get("/api/screens", async () => ({
    screens: booking.screenLinks(),
    // So staff can build TV links even when they opened the dashboard as http://localhost.
    lanAddresses: lanAddresses(),
    // TV links use this name when there is one, so a DHCP address change does not cut every TV off.
    hostName: localHostName(),
  }));

  /** Runs a public handler under a per-IP limit and maps booking refusals to their HTTP status. */
  const publicRoute = async (request: FastifyRequest, reply: FastifyReply, limiter: RateLimiter | null, handler: () => unknown) => {
    if (limiter) {
      const retryAfter = limiter.take(request.ip);
      if (retryAfter > 0) return reply.code(429).header("retry-after", String(retryAfter)).send({ error: "Too many attempts. Please wait a moment and try again." });
    }
    try { return reply.header("cache-control", "no-store").send(await handler()); }
    catch (error) {
      if (error instanceof BookingRejectedError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  };

  // The TV app's timer overlay adds `overlay=1` (it polls while the PS5 picture is showing) and the dashboard's live view
  // adds `preview=1`; neither counts as the screen being seen, and a preview does not count as the TV being on either.
  app.get<{ Params: { id: string }; Querystring: { k?: string; overlay?: string; preview?: string } }>("/api/screen/:id", async (request, reply) =>
    publicRoute(request, reply, null, () => ({
      ...booking.screenView(request.params.id, request.query.k,
        request.query.preview === "1" ? "preview" : request.query.overlay === "1" ? "overlay" : "screen"),
      ads: media.ads(),
      bookingOrigin: bookingOriginFor(request.headers.host, request.protocol, lanAddresses()),
    })));

  // Opt-in remote control of live TVs over ADB (wireless debugging paired on this computer), set per TV in Device Settings.
  app.get("/api/adb/devices", async () => {
    if (!adb) return { available: false, devices: [] };
    const listed = await adb.devices().catch(() => []);
    // Assigned TVs first, as reachable as they really are; drop their raw address-style duplicates.
    const assigned = await remotes.assignedStatus();
    const addresses = new Set(assigned.map((device) => device.address));
    const devices = [...assigned, ...listed.filter((device) => !assigned.some((own) => own.serial === device.serial) && !addresses.has(device.serial))];
    return { available: true, devices };
  });
  app.post("/api/adb/pair", async (request, reply) => idempotent(request, reply, async () => {
    if (!adb) throw new RemoteRejectedError("This server has no ADB tool, so it cannot remote-control TVs.", 409);
    const body = typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
    try {
      await adb.pair(body.address, body.code);
    } catch (error) {
      if (error instanceof AdbInputError) throw new RemoteRejectedError(error.message, 400);
      throw new RemoteRejectedError("The TV did not accept the code. Open the pairing screen again and use the new code.", 502);
    }
    return { paired: true };
  }));
  const remoteRoute = (assign: boolean) => async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) =>
    idempotent(request, reply, async () => {
      const station = system.viewOf(request.params.id);
      if (assign) {
        if (station.adapterKind !== "screen-only") throw new RemoteRejectedError("Remote control is only for live TVs.", 409);
        const body = typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
        remotes.assign(station.id, body.device);
      } else {
        remotes.clear(station.id);
      }
      system.notifyChanged();
      return system.viewOf(station.id);
    });
  app.put<{ Params: { id: string } }>("/api/stations/:id/remote", remoteRoute(true));
  app.delete<{ Params: { id: string } }>("/api/stations/:id/remote", remoteRoute(false));
  // On demand only (never polled by the server, never stored): what Android draws on the TV right now.
  const lastScreenshot = new Map<string, number>();
  app.get<{ Params: { id: string } }>("/api/stations/:id/screenshot", async (request, reply) => {
    try {
      const station = system.viewOf(request.params.id);
      if (!remotes.deviceOf(station.id)) throw new RemoteRejectedError("No remote control is set up for this TV.", 404);
      const last = lastScreenshot.get(station.id) ?? Number.NEGATIVE_INFINITY;
      if (performance.now() - last < SCREENSHOT_INTERVAL_MS) {
        return reply.code(429).header("retry-after", "1").send({ error: "One screenshot per second per TV." });
      }
      lastScreenshot.set(station.id, performance.now());
      // Wait for the picture before setting the type: a failure must still be able to answer with JSON.
      const png = await remotes.screenshot(station.id);
      return reply.type("image/png").header("cache-control", "no-store").send(png);
    } catch (error) {
      const known = errorResult(error);
      if (known) return reply.code(known.statusCode).send(known.body);
      request.log.warn({ err: error }, "Screenshot failed");
      return reply.code(502).send({ error: "The TV did not answer. Check that it is on and Wireless debugging is still enabled." });
    }
  });

  // Advertising library. Uploads arrive as the raw file (Content-Type image/* or video/*, name in X-File-Name); the type is
  // decided from the file's own bytes, never from the name or the header.
  app.addContentTypeParser(/^(image|video)\/[\w.+-]+$/, { parseAs: "buffer", bodyLimit: MEDIA_MAX_BYTES }, (_request, body, done) => done(null, body));
  app.get("/api/media", async () => ({ items: media.list(), maxBytes: MEDIA_MAX_BYTES }));
  app.post("/api/media", { bodyLimit: MEDIA_MAX_BYTES }, async (request, reply) =>
    idempotent(request, reply, async () => {
      if (!Buffer.isBuffer(request.body)) throw new MediaRejectedError("Send the file itself with an image or video Content-Type.", 415);
      const header = request.headers["x-file-name"];
      let name = "ad";
      try { name = typeof header === "string" ? decodeURIComponent(header).slice(0, 200) : name; } catch { /* keep the default */ }
      return media.add(request.body, name);
    }));
  app.delete<{ Params: { name: string } }>("/api/media/:name", async (request, reply) =>
    idempotent(request, reply, async () => { media.remove(request.params.name); return { deleted: request.params.name }; }));
  app.get<{ Params: { name: string } }>("/media/:name", async (request, reply) => {
    let file: string;
    try { file = media.file(request.params.name); } catch { return reply.code(404).send({ error: "Not found" }); }
    const size = (await fs.promises.stat(file)).size;
    reply.type(media.mime(request.params.name)).header("accept-ranges", "bytes")
      .header("cache-control", "public, max-age=3600").header("x-content-type-options", "nosniff");
    // TV video players ask for byte ranges; answer them so playback can start and seek without the whole file.
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return reply.code(416).header("content-range", `bytes */${size}`).send();
      return reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1)
        .send(fs.createReadStream(file, { start, end }));
    }
    return reply.header("content-length", size).send(fs.createReadStream(file));
  });

  app.get<{ Params: { id: string }; Querystring: { c?: string } }>("/api/public/stations/:id/booking", async (request, reply) =>
    publicRoute(request, reply, limits.info, () => booking.bookingInfo(request.params.id, request.query.c)));

  app.post<{ Params: { id: string } }>("/api/public/stations/:id/reservations", { bodyLimit: PUBLIC_BODY_LIMIT }, async (request, reply) =>
    publicRoute(request, reply, limits.reserve, () => {
      const body = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
      const created = booking.reserve(request.params.id, { code: body.code, durationMs: body.durationMs, phone: body.phone, consent: body.consent });
      system.notifyChanged();
      reply.code(201);
      return created;
    }));

  app.get<{ Params: { id: string }; Querystring: { t?: string } }>("/api/public/reservations/:id", async (request, reply) =>
    publicRoute(request, reply, limits.status, () => booking.publicStatus(request.params.id, request.query.t)));

  app.post<{ Params: { id: string } }>("/api/public/reservations/:id/cancel", { bodyLimit: PUBLIC_BODY_LIMIT }, async (request, reply) =>
    publicRoute(request, reply, limits.cancel, () => {
      const body = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
      const cancelled = booking.cancel(request.params.id, body.token);
      system.notifyChanged();
      return cancelled;
    }));

  app.post("/api/simulation/advance", async (request, reply) =>
    idempotent(request, reply, async () => {
      system.advanceSimulation(parseAdvanceRequest(request.body).durationMs);
      await system.reconcileExpired();
      reconcileBookings();
      return system.snapshot();
    }));

  io.use((socket, next) => tokenMatches(socket.handshake.auth.token) ? next() : next(new Error("Unauthorized")));
  io.on("connection", (socket) => socket.emit("snapshot", system.snapshot()));
  system.subscribe((snapshot) => io.emit("snapshot", snapshot));

  const timer = setInterval(() => { void system.reconcileExpired().then(reconcileBookings); }, 1_000);
  timer.unref();
  // preClose runs before Fastify closes the HTTP server. An open websocket would otherwise keep server.close(), and so
  // app.close(), waiting until every dashboard disconnected on its own.
  app.addHook("preClose", async () => {
    clearInterval(timer);
    io.disconnectSockets(true);
    io.close().catch((error: unknown) => app.log.warn({ err: error }, "Socket.IO close failed"));
  });
  // Let queued and in-flight commands finish and persist (bounded) before the database closes.
  app.addHook("onClose", async () => {
    const requests = Promise.allSettled([...inFlight.values()].map(({ result }) => result));
    const [drained] = await Promise.all([system.drain(SHUTDOWN_DRAIN_MS), settleWithin(requests, SHUTDOWN_DRAIN_MS)]);
    if (!drained) app.log.warn({ boundMs: SHUTDOWN_DRAIN_MS }, "Station queues still busy at shutdown; remaining commands are abandoned");
    system.dispose();
    db.close();
  });
  return app;
}

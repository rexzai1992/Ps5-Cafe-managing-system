import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MediaItem, MediaList, ScreenLinks, ScreenView } from "@ps5-cafe/contracts";
import { buildApp } from "./app.js";
import { FakeClock } from "./clock.js";
import { detectMediaType, MEDIA_MAX_BYTES } from "./media.js";

const TOKEN = "media-test-token-0123456789";
const staff = { authorization: `Bearer ${TOKEN}` };
let keySeq = 0;
const key = () => `media-key-${String(++keySeq).padStart(4, "0")}`;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(200, 3)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(32)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32)]);

describe("detectMediaType", () => {
  it("knows images and videos by their bytes", () => {
    expect([PNG, JPEG, GIF, WEBP, MP4, WEBM].map((bytes) => detectMediaType(bytes)?.mime))
      .toEqual(["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm"]);
  });

  it("refuses anything else, whatever it is called", () => {
    for (const text of ["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "<!doctype html><script>x</script>", "MZ\x90\x00", "", "GIF8"]) {
      expect(detectMediaType(Buffer.from(text)), text).toBeNull();
    }
  });
});

describe("advertising library over HTTP", () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps5-media-test-"));
    app = await buildApp({ databasePath: ":memory:", apiToken: TOKEN, simulationMode: true, stationCount: 2, clock: new FakeClock(1_800_000_000_000), mediaDir: dir });
  });
  afterEach(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const upload = (bytes: Buffer, type: string, name = "Summer Promo!.png", idempotencyKey = key()) => app.inject({
    method: "POST", url: "/api/media", payload: bytes,
    headers: { ...staff, "content-type": type, "x-file-name": encodeURIComponent(name), "idempotency-key": idempotencyKey },
  });
  const list = async () => (await app.inject({ method: "GET", url: "/api/media", headers: staff })).json<MediaList>();

  it("stores an upload under a safe server-made name, typed by its bytes", async () => {
    const response = await upload(PNG, "image/png", "../../Summer Promo!.png");
    expect(response.statusCode).toBe(200);
    const item = response.json<MediaItem>();
    expect(item).toMatchObject({ kind: "image", mime: "image/png", bytes: PNG.length });
    expect(item.name).toMatch(/^summer-promo-[0-9a-f]{8}\.png$/);
    expect(fs.readdirSync(dir)).toEqual([item.name]);
    expect((await list()).items.map((entry) => entry.name)).toEqual([item.name]);
  });

  it("refuses files that are not images or videos, even when they claim to be", async () => {
    const html = await upload(Buffer.from("<!doctype html><script>alert(1)</script>"), "image/png", "ad.png");
    expect(html.statusCode).toBe(415);
    expect((await upload(Buffer.from("{}"), "application/json")).statusCode).toBe(415);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("needs the staff token and an idempotency key, and replays a retried upload", async () => {
    expect((await app.inject({ method: "POST", url: "/api/media", payload: PNG, headers: { "content-type": "image/png", "idempotency-key": key() } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/media", payload: PNG, headers: { ...staff, "content-type": "image/png" } })).statusCode).toBe(400);
    const retryKey = key();
    const first = await upload(MP4, "video/mp4", "clip.mp4", retryKey);
    const again = await upload(MP4, "video/mp4", "clip.mp4", retryKey);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json<MediaItem>().name).toBe(first.json<MediaItem>().name);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it("rejects files over the size limit before storing anything", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MEDIA_MAX_BYTES)]);
    expect((await upload(big, "image/png")).statusCode).toBe(413);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("serves files publicly with their real type, byte ranges, and nothing outside the library", async () => {
    const video = (await upload(MP4, "video/mp4", "clip.mp4")).json<MediaItem>();
    fs.writeFileSync(path.join(path.dirname(dir), "outside-secret.png"), PNG);
    const whole = await app.inject({ method: "GET", url: `/media/${video.name}` });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers["content-type"]).toBe("video/mp4");
    expect(whole.headers["x-content-type-options"]).toBe("nosniff");
    expect(whole.rawPayload.equals(MP4)).toBe(true);
    const part = await app.inject({ method: "GET", url: `/media/${video.name}`, headers: { range: "bytes=4-11" } });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 4-11/${MP4.length}`);
    expect(part.rawPayload.toString()).toBe("ftypisom");
    expect((await app.inject({ method: "GET", url: `/media/${video.name}`, headers: { range: `bytes=${MP4.length + 5}-` } })).statusCode).toBe(416);
    for (const url of ["/media/..%2Foutside-secret.png", "/media/.hidden.png", "/media/missing.png", "/media/Clip.MP4"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
    fs.rmSync(path.join(path.dirname(dir), "outside-secret.png"));
  });

  it("gives every TV screen the playlist in upload order, and drops deleted files", async () => {
    const first = (await upload(JPEG, "image/jpeg", "one.jpg")).json<MediaItem>();
    fs.utimesSync(path.join(dir, first.name), new Date(1_000_000), new Date(1_000_000));
    const second = (await upload(WEBM, "video/webm", "two.webm")).json<MediaItem>();
    const screens = (await app.inject({ method: "GET", url: "/api/screens", headers: staff })).json<ScreenLinks>();
    const screen = async () => (await app.inject({ method: "GET", url: `/api/screen/ps5-01?k=${encodeURIComponent(screens.screens[0]!.key)}` })).json<ScreenView>();
    expect((await screen()).ads).toEqual([{ url: `/media/${first.name}`, kind: "image" }, { url: `/media/${second.name}`, kind: "video" }]);
    const removed = await app.inject({ method: "DELETE", url: `/api/media/${first.name}`, headers: { ...staff, "idempotency-key": key() } });
    expect(removed.statusCode).toBe(200);
    expect((await screen()).ads).toEqual([{ url: `/media/${second.name}`, kind: "video" }]);
    expect((await app.inject({ method: "DELETE", url: "/api/media/..%2Fx.png", headers: { ...staff, "idempotency-key": key() } })).statusCode).toBe(404);
  });
});

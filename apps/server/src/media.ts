import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AdItem, MediaItem, MediaKind } from "@ps5-cafe/contracts";

/** Largest advertising file accepted, in bytes. */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
/** How long a cached library listing is trusted before re-reading the folder (files may be copied in by hand). */
const LIST_CACHE_MS = 30_000;

interface MediaType { ext: string; mime: string; kind: MediaKind }
const TYPES: Record<string, MediaType> = {
  jpg: { ext: "jpg", mime: "image/jpeg", kind: "image" },
  png: { ext: "png", mime: "image/png", kind: "image" },
  gif: { ext: "gif", mime: "image/gif", kind: "image" },
  webp: { ext: "webp", mime: "image/webp", kind: "image" },
  mp4: { ext: "mp4", mime: "video/mp4", kind: "video" },
  webm: { ext: "webm", mime: "video/webm", kind: "video" },
};
/** Server-made names only: no separators, no dot files, a known extension. */
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,80}\.(jpg|png|gif|webp|mp4|webm)$/;

/** A media file the server refuses; `statusCode` is the HTTP status to answer with. */
export class MediaRejectedError extends Error {
  public constructor(message: string, public readonly statusCode: number) { super(message); }
}

/**
 * The file's real type from its first bytes. The name and the client's content type are never trusted: an HTML or SVG
 * file renamed to .png is refused.
 */
export function detectMediaType(bytes: Uint8Array): MediaType | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return TYPES.jpg!;
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return TYPES.png!;
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return TYPES.gif!;
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return TYPES.webp!;
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp") return TYPES.mp4!;
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return TYPES.webm!;
  return null;
}

/** The advertising files every idle TV plays, kept as plain files in one folder (oldest first). */
export class MediaLibrary {
  private cache: { at: number; items: MediaItem[] } | null = null;

  public constructor(private readonly dir: string, private readonly now: () => number = Date.now) {
    fs.mkdirSync(dir, { recursive: true });
  }

  list(): MediaItem[] {
    if (this.cache && this.now() - this.cache.at < LIST_CACHE_MS) return this.cache.items;
    const items = fs.readdirSync(this.dir).filter((name) => SAFE_NAME.test(name)).flatMap((name): MediaItem[] => {
      const type = TYPES[path.extname(name).slice(1)];
      const stat = fs.statSync(path.join(this.dir, name), { throwIfNoEntry: false });
      return type && stat?.isFile() ? [{ name, kind: type.kind, mime: type.mime, bytes: stat.size, addedAt: Math.round(stat.mtimeMs) }] : [];
    }).sort((a, b) => a.addedAt - b.addedAt || a.name.localeCompare(b.name));
    this.cache = { at: this.now(), items };
    return items;
  }

  /** The playlist as a TV screen needs it. */
  ads(): AdItem[] {
    return this.list().map((item) => ({ url: `/media/${item.name}`, kind: item.kind }));
  }

  /** Validates and stores one upload under a new server-made name; a partial write never appears in the library. */
  add(bytes: Uint8Array, originalName: string): MediaItem {
    if (bytes.length === 0) throw new MediaRejectedError("The file is empty.", 400);
    if (bytes.length > MEDIA_MAX_BYTES) throw new MediaRejectedError("The file is too large.", 413);
    const type = detectMediaType(bytes);
    if (!type) throw new MediaRejectedError("Only JPEG, PNG, GIF and WebP images and MP4 and WebM videos can be used.", 415);
    const stem = path.parse(originalName).name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ad";
    const name = `${stem}-${randomBytes(4).toString("hex")}.${type.ext}`;
    const temporary = path.join(this.dir, `.upload-${randomBytes(6).toString("hex")}`);
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, path.join(this.dir, name));
    this.cache = null;
    return this.list().find((item) => item.name === name)!;
  }

  remove(name: string): void {
    fs.rmSync(this.file(name));
    this.cache = null;
  }

  /** Absolute path of a library file, or throws 404: only names the library itself would have made are accepted. */
  file(name: string): string {
    const full = path.join(this.dir, name);
    if (!SAFE_NAME.test(name) || !fs.statSync(full, { throwIfNoEntry: false })?.isFile()) throw new MediaRejectedError("Not found.", 404);
    return full;
  }

  mime(name: string): string { return TYPES[path.extname(name).slice(1)]!.mime; }
}

import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import type { MediaItem, MediaList } from "@ps5-cafe/contracts";
import { errorMessageFromBody, newIdempotencyKey, REQUEST_TIMEOUT_MS, staffToken, UNREACHABLE_MESSAGE } from "../api.js";
import { IMAGE_MS } from "../components/AdPlayer.js";
import { formatBytes } from "../logic.js";

const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm";
/** A large video over café Wi-Fi can take a while; the request is idempotent, so a retry never stores it twice. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

const authorization = () => ({ authorization: `Bearer ${staffToken() ?? ""}` });

/** Advertising images and videos. Every idle TV plays them beside its QR code, in this order. */
export function MediaPage() {
  const [data, setData] = useState<MediaList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/media", { headers: authorization(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(errorMessageFromBody(response.status, await response.text()));
      setData(await response.json() as MediaList);
    } catch (reason) {
      setError(reason instanceof TypeError ? UNREACHABLE_MESSAGE : reason instanceof Error ? reason.message : String(reason));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    setError(null);
    for (const file of files) {
      if (data && file.size > data.maxBytes) { setError(`${file.name} is larger than ${formatBytes(data.maxBytes)}.`); continue; }
      setBusy(`Uploading ${file.name}…`);
      try {
        const response = await fetch("/api/media", {
          method: "POST",
          body: file,
          headers: {
            ...authorization(), "content-type": file.type || "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name), "idempotency-key": newIdempotencyKey(),
          },
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
        if (!response.ok) setError(`${file.name}: ${errorMessageFromBody(response.status, await response.text())}`);
      } catch {
        setError(`${file.name}: ${UNREACHABLE_MESSAGE}`);
      }
    }
    setBusy(null);
    await load();
  };

  const remove = async (item: MediaItem) => {
    if (!window.confirm(`Delete this ${item.kind}? TVs stop showing it within a few seconds.`)) return;
    setBusy("Deleting…");
    try {
      const response = await fetch(`/api/media/${encodeURIComponent(item.name)}`, {
        method: "DELETE", headers: { ...authorization(), "idempotency-key": newIdempotencyKey() }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) setError(errorMessageFromBody(response.status, await response.text()));
    } catch {
      setError(UNREACHABLE_MESSAGE);
    }
    setBusy(null);
    await load();
  };

  return <>
    <div className="topbar"><div><h1>Media Manager</h1></div></div>
    <section className="media-intro">
      <p>Every idle TV plays these beside its QR code, in this order: images for {IMAGE_MS / 1000} seconds each, videos to the
        end with the sound off. Use 16:9 (landscape) files, such as 1920×1080.</p>
      <label className={`media-upload primary${busy ? " is-busy" : ""}`} aria-busy={busy ? true : undefined}>
        <input type="file" accept={ACCEPT} multiple onChange={upload} disabled={busy !== null} />
        {busy ?? "Add images or videos"}
      </label>
      <p className="muted">JPEG, PNG, GIF or WebP images; MP4 (H.264) or WebM videos; up to {data ? formatBytes(data.maxBytes) : "100 MB"} each.</p>
      {error && <p className="banner tone-red page-banner" role="alert"><span>{error}</span></p>}
    </section>

    {data && data.items.length === 0 && <section className="empty-page">
      <h2>No ads yet</h2>
      <p>Idle TVs show the built-in “Your ad here” panel until you add something.</p>
    </section>}
    {data && data.items.length > 0 && <ol className="media-grid" aria-label="Advertising playlist">
      {data.items.map((item, index) => <li key={item.name} className="media-card">
        <div className="media-preview">
          {item.kind === "image"
            ? <img src={`/media/${item.name}`} alt="" loading="lazy" />
            : <video src={`/media/${item.name}#t=0.5`} muted playsInline preload="metadata" controls />}
          <span className="media-order">{index + 1}</span>
        </div>
        <div className="media-meta">
          <b title={item.name}>{item.name}</b>
          <small>{item.kind === "image" ? "Image" : "Video"} · {formatBytes(item.bytes)}</small>
        </div>
        <button type="button" className="danger" onClick={() => void remove(item)} disabled={busy !== null} aria-label={`Delete ${item.name}`}>Delete</button>
      </li>)}
    </ol>}
  </>;
}

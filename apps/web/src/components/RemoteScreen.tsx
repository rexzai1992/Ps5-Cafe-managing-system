import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import type { StationAction, StationView } from "@ps5-cafe/contracts";
import { errorMessageFromBody, REQUEST_TIMEOUT_MS, staffToken } from "../api.js";
import { formatClock } from "../logic.js";
import type { PendingIntent } from "../useCommands.js";

/** After a key or touch, look again once the TV has had time to react (a page coming back reloads for a few seconds). */
const REFRESH_AFTER_MS = [900, 2_600, 5_500];
/** The server allows one screenshot per second per TV. */
const RETRY_AFTER_BUSY_MS = 1_100;

interface RemoteScreenProps {
  station: StationView;
  pending: PendingIntent | undefined;
  onAction: (station: StationView, control: string, action: StationAction) => void;
  /** Goes up each time the remote beside it sends a key or input; the screenshot looks again after each. */
  commandsSent: number;
}

/**
 * The screen half of a live TV's remote: a screenshot taken on demand (never continuously) that can be touched. The
 * PS5/HDMI picture is on a video layer that screenshots leave black, and it is never captured.
 */
export function RemoteScreen({ station, onAction, commandsSent }: RemoteScreenProps) {
  const [image, setImage] = useState<{ url: string; at: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/stations/${encodeURIComponent(station.id)}/screenshot`, {
        headers: { authorization: `Bearer ${staffToken() ?? ""}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // Another screen asked for one less than a second ago: ask again in a moment rather than showing nothing.
      if (response.status === 429) { timers.current.push(setTimeout(() => void refresh(), RETRY_AFTER_BUSY_MS)); return; }
      if (!response.ok) { setProblem(errorMessageFromBody(response.status, await response.text())); return; }
      const url = URL.createObjectURL(await response.blob());
      setImage((previous) => { if (previous) URL.revokeObjectURL(previous.url); return { url, at: Date.now() }; });
      setProblem(null);
    } catch {
      setProblem("Could not reach the server for a screenshot.");
    } finally {
      setLoading(false);
    }
  }, [station.id]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);

  const afterCommand = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = REFRESH_AFTER_MS.map((ms) => setTimeout(() => void refresh(), ms));
  }, [refresh]);
  useEffect(() => { if (commandsSent > 0) afterCommand(); }, [commandsSent, afterCommand]);
  const send = (control: string, action: StationAction) => { onAction(station, control, action); afterCommand(); };
  const touch = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    send("tap", { type: "REMOTE_TAP", x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
  };

  return <div className="remote-screen">
    <button type="button" className="remote-shot" onClick={touch} disabled={!image}
      aria-label={`Touch ${station.name}'s screen where you click`}>
      {image ? <img src={image.url} alt={`${station.name} screen at ${formatClock(image.at, true)}`} /> : <span>{problem ?? "Taking a screenshot…"}</span>}
    </button>
    <p className="remote-shot-caption">
      {image && <>Screenshot {formatClock(image.at, true)}. </>}Click the picture to touch the TV there. The PS5/HDMI picture shows black: it is never captured.
    </p>
    {problem && image && <p className="unavailable-note" role="alert">{problem}</p>}
    <button type="button" className="remote-refresh" onClick={() => void refresh()} disabled={loading}>{loading ? "Looking…" : "Refresh screenshot"}</button>
  </div>;
}

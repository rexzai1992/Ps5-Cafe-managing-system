import { useEffect, useState } from "react";
import type { ScreenLinks, StationView } from "@ps5-cafe/contracts";
import { REQUEST_TIMEOUT_MS, staffToken } from "../api.js";
import { liveScreenLabel, previewMismatch } from "../logic.js";
import { screenUrl } from "../navigation.js";
import { AlertIcon } from "./Icons.js";

let screenKeys: Promise<Map<string, string>> | null = null;

/** Screen keys never change silently, so one staff request per page load serves every live view. */
function loadScreenKeys(): Promise<Map<string, string>> {
  screenKeys ??= fetch("/api/screens", { headers: { authorization: `Bearer ${staffToken() ?? ""}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as ScreenLinks;
      return new Map(data.screens.map((screen) => [screen.stationId, screen.key]));
    })
    .catch((error: unknown) => { screenKeys = null; throw error; });
  return screenKeys;
}

/**
 * The TV's own screen page, live, in a frame: exactly what the TV shows whenever its screen page is open. The frame polls
 * as a preview, so watching never makes the TV look online. Nothing here captures the TV's picture or the game.
 */
export function LiveScreen({ station }: { station: StationView }) {
  const [key, setKey] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadScreenKeys().then((keys) => { if (!cancelled) setKey(keys.get(station.id) ?? null); }, () => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [station.id]);
  const label = liveScreenLabel(station);
  const mismatch = previewMismatch(station);
  return <figure className="live-screen">
    <div className="live-frame">
      {key
        ? <iframe title={`${station.name} screen page, live`} src={screenUrl(window.location.origin, station.id, key, true)} tabIndex={-1} />
        : <p className="live-loading">{failed ? "Could not load this TV's screen link." : "Loading the screen…"}</p>}
      {station.simulated && <span className="sim-label">Simulated</span>}
    </div>
    <figcaption className={`live-caption tone-${label.tone}`}>{label.text}</figcaption>
    {mismatch && <p className={`live-caption tone-${station.mode === "EXPIRED" ? "red" : "amber"}`}><AlertIcon /><span>{mismatch}</span></p>}
  </figure>;
}

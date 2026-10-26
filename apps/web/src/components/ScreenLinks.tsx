import { useEffect, useState } from "react";
import type { ScreenLinks as ScreenLinksData, StationView } from "@ps5-cafe/contracts";
import { errorMessageFromBody, REQUEST_TIMEOUT_MS, staffToken } from "../api.js";
import { screenUrl } from "../navigation.js";
import { adbConfigureCommand, tvLinkOrigin } from "../reservations.js";

const ONLINE_WITHIN_MS = 15_000;

/** Copies with the Clipboard API where allowed (https/localhost); on plain-http LAN pages it selects the text instead. */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (input: HTMLInputElement | null) => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1_500); }
    catch { input?.select(); }
  };
  let input: HTMLInputElement | null = null;
  return <div className="copy-field">
    <input aria-label={label} readOnly value={value} ref={(element) => { input = element; }} onFocus={(event) => event.currentTarget.select()} />
    <button type="button" onClick={() => void copy(input)}>{copied ? "Copied" : "Copy"}</button>
  </div>;
}

/** Each TV's own screen link (with its key) and the ADB command that sets it up in the companion app. */
export function ScreenLinks({ stations, serverNow }: { stations: readonly StationView[]; serverNow: number }) {
  const [data, setData] = useState<ScreenLinksData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/screens", { headers: { authorization: `Bearer ${staffToken() ?? ""}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .then(async (response) => {
        if (!response.ok) throw new Error(errorMessageFromBody(response.status, await response.text()));
        setData(await response.json() as ScreenLinksData);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load the TV screen links"));
  }, []);

  if (error) return <p className="banner tone-red page-banner"><span>{error}</span></p>;
  if (!data) return <p className="muted">Loading TV screen links…</p>;

  const origin = tvLinkOrigin(window.location.origin, data.hostName, data.lanAddresses);
  const local = origin === window.location.origin && ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const live = new Map(stations.map((station) => [station.id, station]));
  return <section className="screen-links" aria-labelledby="screens-heading">
    <h2 id="screens-heading">TV screens and QR booking</h2>
    <p className="muted">Open each link full-screen on its own TV (in the companion app, or the TV's web browser). The TV then shows ads and its own
      QR code; customers scan it to reserve that TV. Links contain a secret key — only put them on the matching TV.
      {data.hostName && <> Links use this computer&apos;s name (<code>{data.hostName}</code>), so TVs keep working when its network address
        changes; QR codes always give phones the current address.</>}</p>
    {local && <p className="banner tone-amber page-banner"><span>These links use <code>localhost</code>, which TVs cannot reach. Open the dashboard via
      this computer's network address instead.</span></p>}
    <ul className="screen-list">
      {data.screens.map((screen) => {
        const url = screenUrl(origin, screen.stationId, screen.key);
        const station = live.get(screen.stationId);
        const seenAt = station?.screenSeenAt ?? screen.seenAt;
        // The server says whether the screen is open now; older servers only send when it last checked in.
        const online = station?.screenOnline ?? (seenAt !== null && serverNow - seenAt < ONLINE_WITHIN_MS);
        return <li key={screen.stationId} className="screen-row">
          <div className="screen-row-head">
            <b>{screen.name}</b>
            <span className={online ? "conn-online" : "muted"}>{online ? "● Screen online" : seenAt ? "Screen not open now" : "Screen never opened"}</span>
            <a href={url} target="_blank" rel="noreferrer">Open screen</a>
          </div>
          <CopyField label={`${screen.name} screen link`} value={url} />
          <CopyField label={`${screen.name} ADB setup command`} value={adbConfigureCommand(url)} />
        </li>;
      })}
    </ul>
  </section>;
}

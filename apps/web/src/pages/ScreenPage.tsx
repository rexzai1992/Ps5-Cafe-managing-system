import { useEffect, useRef, useState } from "react";
import type { ScreenView } from "@ps5-cafe/contracts";
import { AdPlayer } from "../components/AdPlayer.js";
import { QrCode } from "../components/QrCode.js";
import { formatDurationLabel, formatTime } from "../logic.js";
import { bookingUrl } from "../navigation.js";
import { getPublic } from "../publicApi.js";
import { countdown } from "../reservations.js";

const POLL_MS = 2_000;
const BAD_LINK_POLL_MS = 15_000;

/**
 * The page a TV shows full-screen (browser or companion app). It shows what the server says this TV should show; it
 * is not a lock: a customer can still change input with the TV remote. Polling doubles as the TV's heartbeat.
 */
export function ScreenPage({ stationId, screenKey, preview = false }: { stationId: string; screenKey: string; preview?: boolean }) {
  const [view, setView] = useState<ScreenView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [badLink, setBadLink] = useState(false);
  const offsetRef = useRef(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    document.documentElement.classList.add("tv-screen");
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      // Each poll tells the server this screen is showing. A hidden page (TV on another input, browser in the background)
      // is not showing, so it stays quiet until it is visible again.
      if (document.visibilityState === "hidden") { timer = setTimeout(poll, POLL_MS); return; }
      const result = await getPublic<ScreenView>(`/api/screen/${encodeURIComponent(stationId)}?k=${encodeURIComponent(screenKey)}${preview ? "&preview=1" : ""}`);
      if (stopped) return;
      if (result.ok) {
        offsetRef.current = result.data.serverTime - Date.now();
        setView(result.data);
        setProblem(null);
        setBadLink(false);
      } else {
        setBadLink(result.status === 403 || result.status === 404);
        setProblem(result.message);
      }
      timer = setTimeout(poll, result.ok || (result.status !== 403 && result.status !== 404) ? POLL_MS : BAD_LINK_POLL_MS);
    };
    void poll();
    const ticker = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => { stopped = true; clearTimeout(timer); clearInterval(ticker); document.documentElement.classList.remove("tv-screen"); };
  }, [stationId, screenKey, preview]);

  if (!view) {
    return <main className="screen-page screen-message">
      <h1>{badLink ? "This TV screen link is not valid" : "Connecting to the PS5 Cafe server…"}</h1>
      {problem && <p>{badLink ? "Copy this TV's screen link again from Device Settings on the staff dashboard." : problem}</p>}
    </main>;
  }

  const now = Date.now() + offsetRef.current;
  const reservation = view.reservation;
  const stale = problem !== null;
  let body;
  if (reservation?.status === "HELD") {
    body = <section className="screen-reserved">
      <span className="screen-tag">Reserved</span>
      <h1>{view.station.name} is reserved</h1>
      <p className="screen-big">{reservation.phoneLast4 ? `For ••• ${reservation.phoneLast4}` : "Booked by QR"} · {formatDurationLabel(reservation.durationMs)}</p>
      <p>Please pay at the counter. Booking <b>{reservation.ref}</b></p>
      <p className="screen-countdown">Held for {countdown(reservation.holdUntil, now)}</p>
    </section>;
  } else if (view.mode === "EXPIRED") {
    body = <section className="screen-expired">
      <h1>Time expired</h1>
      <p>Please contact the counter to extend your gaming session.</p>
    </section>;
  } else if (view.sessionStatus === "ACTIVE" || view.sessionStatus === "PAUSED") {
    body = <section className="screen-inuse">
      <h1>{view.station.name} · {view.sessionStatus === "PAUSED" ? "Paused" : "In session"}</h1>
      <p className="screen-big">{formatTime(view.remainingMs)} left</p>
    </section>;
  } else {
    body = <section className="screen-idle">
      {view.ads?.length
        ? <div className="screen-ad has-media"><AdPlayer ads={view.ads} /></div>
        : <div className="screen-ad">
          <span className="screen-brand">PS5 Cafe</span>
          <strong>Your ad here</strong>
          <small>Add images and videos in the Media Manager.</small>
        </div>}
      {view.qr && !stale && <div className="screen-qr">
        <QrCode text={bookingUrl(view.bookingOrigin || window.location.origin, view.station.id, view.qr.code)} label={`QR code to book ${view.station.name}`} />
        <h2>Scan to book {view.station.name}</h2>
        <p>Reserve with your phone, then pay at the counter.</p>
      </div>}
    </section>;
  }

  return <main className={`screen-page${stale ? " is-stale" : ""}`}>
    {body}
    <footer className="screen-footer">
      <span>{view.station.name}</span>
      {stale && <span className="screen-offline">Reconnecting to server…</span>}
    </footer>
  </main>;
}

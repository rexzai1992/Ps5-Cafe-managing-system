import { type FormEvent, useEffect, useRef, useState } from "react";
import type { PublicBookingInfo, PublicReservation, ReservationCreated } from "@ps5-cafe/contracts";
import { formatDurationLabel, formatTime } from "../logic.js";
import { getPublic, postPublic } from "../publicApi.js";
import { countdown } from "../reservations.js";

const STATUS_POLL_MS = 4_000;
const storageKey = (stationId: string) => `ps5cafe.reservation.${stationId}`;

interface Saved { id: string; token: string }

function loadSaved(stationId: string): Saved | null {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(storageKey(stationId)) ?? "null") as Saved | null;
    return value && typeof value.id === "string" && typeof value.token === "string" ? value : null;
  } catch { return null; }
}
function save(stationId: string, value: Saved | null): void {
  try {
    if (value) globalThis.localStorage?.setItem(storageKey(stationId), JSON.stringify(value));
    else globalThis.localStorage?.removeItem(storageKey(stationId));
  } catch { /* the reservation still works; it just won't survive a refresh */ }
}

const FINAL_MESSAGES: Record<string, { title: string; text: string }> = {
  STARTED: { title: "Your session has started", text: "Enjoy your game!" },
  COMPLETED: { title: "Session finished", text: "Thanks for playing." },
  EXPIRED: { title: "Your hold has expired", text: "It was not paid in time. Scan the TV's code again to book." },
  RELEASED: { title: "Reservation released", text: "The counter released this reservation. Please ask at the counter if this is unexpected." },
  CANCELLED: { title: "Reservation cancelled", text: "You can scan the TV's code again to book." },
};

/** The customer's phone after scanning a TV's QR code: choose a time, leave a number, reserve, then pay at the counter. */
export function BookingPage({ stationId, code }: { stationId: string; code: string }) {
  const [info, setInfo] = useState<PublicBookingInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(() => loadSaved(stationId));
  const [reservation, setReservation] = useState<PublicReservation | null>(null);
  const offsetRef = useRef(0);
  const [, setTick] = useState(0);

  useEffect(() => { document.title = "Book a PS5 · PS5 Cafe"; }, []);

  // Booking info (also proves the code is fresh). Skipped while showing an existing reservation.
  useEffect(() => {
    if (saved) return;
    let cancelled = false;
    void getPublic<PublicBookingInfo>(`/api/public/stations/${encodeURIComponent(stationId)}/booking?c=${encodeURIComponent(code)}`).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        offsetRef.current = result.data.serverTime - Date.now();
        setInfo(result.data);
        setDuration((previous) => previous ?? result.data.durationsMs.find((ms) => ms === 60 * 60_000) ?? result.data.durationsMs[0] ?? null);
      } else setLoadError(result.message);
    });
    return () => { cancelled = true; };
  }, [stationId, code, saved]);

  // Live status of this phone's reservation.
  useEffect(() => {
    if (!saved) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const result = await getPublic<PublicReservation>(`/api/public/reservations/${encodeURIComponent(saved.id)}?t=${encodeURIComponent(saved.token)}`);
      if (stopped) return;
      if (result.ok) {
        offsetRef.current = result.data.serverTime - Date.now();
        setReservation(result.data);
        if (result.data.status !== "HELD" && result.data.status !== "STARTED") return; // final: stop polling
      } else if (result.status === 404) {
        save(stationId, null);
        setSaved(null);
        return;
      }
      timer = setTimeout(poll, STATUS_POLL_MS);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [saved, stationId]);

  useEffect(() => {
    const ticker = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(ticker);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || duration === null) return;
    if (!consent) { setFormError("Please tick the box to agree to how your number is used."); return; }
    setSubmitting(true);
    setFormError(null);
    const result = await postPublic<ReservationCreated>(`/api/public/stations/${encodeURIComponent(stationId)}/reservations`, {
      code, durationMs: duration, phone, consent,
    });
    setSubmitting(false);
    if (!result.ok) { setFormError(result.message); return; }
    const next = { id: result.data.id, token: result.data.token };
    save(stationId, next);
    offsetRef.current = result.data.serverTime - Date.now();
    setReservation(result.data);
    setSaved(next);
  };

  const cancel = async () => {
    if (!saved || !window.confirm("Cancel this reservation?")) return;
    const result = await postPublic<PublicReservation>(`/api/public/reservations/${encodeURIComponent(saved.id)}/cancel`, { token: saved.token });
    if (result.ok) setReservation(result.data);
    else setFormError(result.message);
  };

  const startOver = () => { save(stationId, null); setSaved(null); setReservation(null); setInfo(null); setLoadError(null); };
  const now = Date.now() + offsetRef.current;

  let content;
  if (saved && reservation) {
    const final = FINAL_MESSAGES[reservation.status];
    content = reservation.status === "HELD"
      ? <section className="book-card book-held" aria-live="polite">
        <span className="book-tag">Reserved</span>
        <h1>{reservation.station.name} is held for you</h1>
        <p className="book-ref-label">Show this at the counter</p>
        <p className="book-ref">{reservation.ref}</p>
        <p className="book-meta">{formatDurationLabel(reservation.durationMs)} · pay at the counter within <b>{countdown(reservation.holdUntil, now)}</b></p>
        <button type="button" className="book-secondary" onClick={cancel}>Cancel reservation</button>
        {formError && <p className="book-error" role="alert">{formError}</p>}
      </section>
      : <section className={`book-card book-final status-${reservation.status.toLowerCase()}`} aria-live="polite">
        <h1>{final?.title ?? reservation.status}</h1>
        {reservation.status === "STARTED" && reservation.session
          ? <>
            <p className="book-ref-label">{reservation.session.status === "PAUSED" ? "Paused · time left" : "Time left"}</p>
            <p className="book-timer" role="timer">{formatTime(reservation.session.status === "ACTIVE"
              ? reservation.session.remainingMs - (now - reservation.serverTime) : reservation.session.remainingMs)}</p>
            <p className="book-meta">On {reservation.station.name}. Keep this page open to watch your time.</p>
          </>
          : <p>{final?.text}</p>}
        {reservation.status !== "STARTED" && <p className="book-meta">Booking {reservation.ref}</p>}
        {reservation.status !== "STARTED" && <button type="button" className="book-secondary" onClick={startOver}>Done</button>}
      </section>;
  } else if (saved) {
    content = <section className="book-card"><p>Checking your reservation…</p></section>;
  } else if (loadError) {
    content = <section className="book-card"><h1>Can't book right now</h1><p>{loadError}</p></section>;
  } else if (!info) {
    content = <section className="book-card"><p>Loading…</p></section>;
  } else if (!info.available) {
    content = <section className="book-card"><h1>{info.station.name}</h1><p>{info.reason}</p><p className="book-meta">Please ask at the counter or scan another free TV.</p></section>;
  } else {
    content = <form className="book-card" onSubmit={submit} noValidate>
      <span className="book-tag">PS5 Cafe</span>
      <h1>Book {info.station.name}</h1>
      <p className="book-meta">We hold the TV for {Math.round(info.holdMs / 60_000)} minutes while you pay at the counter.</p>

      <fieldset className="book-durations">
        <legend>How long?</legend>
        <div className="segmented">
          {info.durationsMs.map((ms) => <label key={ms} className={duration === ms ? "is-selected" : undefined}>
            <input type="radio" name="duration" value={ms} checked={duration === ms} onChange={() => setDuration(ms)} />
            <span>{formatDurationLabel(ms)}</span>
          </label>)}
        </div>
      </fieldset>

      <label className="book-field">
        <span>Mobile number</span>
        <input type="tel" inputMode="tel" autoComplete="tel" placeholder="012-345 6789" value={phone} onChange={(event) => setPhone(event.target.value)} required maxLength={20} />
      </label>

      <label className="book-consent">
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        <span>I agree that the café may use this number only to contact me about this booking. It is deleted automatically when the
          booking or my session ends, and always within 24 hours.</span>
      </label>

      {formError && <p className="book-error" role="alert">{formError}</p>}
      <button type="submit" className="book-primary" aria-busy={submitting || undefined} disabled={submitting}>
        {submitting ? "Reserving…" : `Reserve ${info.station.name}`}
      </button>
    </form>;
  }

  return <main className="book-page">{content}</main>;
}

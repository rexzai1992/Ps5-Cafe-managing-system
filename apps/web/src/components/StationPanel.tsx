import { useRef } from "react";
import type { StationAction, StationView } from "@ps5-cafe/contracts";
import { formatDurationLabel } from "../logic.js";
import { countdown, formatMalaysianMobile } from "../reservations.js";
import type { PendingIntent, ScopedError } from "../useCommands.js";
import { ActionButton } from "./ActionButton.js";
import { Modal } from "./Modal.js";
import { RemotePanel } from "./RemotePanel.js";
import { type CardHandlers, StationCard } from "./StationCard.js";

interface StationPanelProps {
  station: StationView;
  serverNow: number;
  stale: boolean;
  pending: PendingIntent | undefined;
  error: ScopedError | undefined;
  handlers: Omit<CardHandlers, "onSelect">;
  onRemoteAction: (station: StationView, control: string, action: StationAction) => void;
  onStartReserved: (station: StationView) => void;
  onRelease: (station: StationView) => void;
  /** Esc, the close button, or the browser back button (the panel has its own #/station/<id> route). */
  onClose: () => void;
}

/** One station's full detail: every action, the TV preview, evidence, last command, and its remote. */
export function StationPanel(props: StationPanelProps) {
  const { station, serverNow, stale, pending, error, handlers, onRemoteAction, onStartReserved, onRelease, onClose } = props;
  const reservation = station.reservation;
  const closeRef = useRef<HTMLButtonElement>(null);
  return <Modal labelledBy="panel-title" initialFocus={closeRef} onClose={onClose} className="drawer">
    <div className="drawer-head">
      <div>
        <span className="eyebrow">Station {station.number.toString().padStart(2, "0")}</span>
        <h2 id="panel-title">{station.name}</h2>
      </div>
      <button ref={closeRef} type="button" className="drawer-close" onClick={onClose}>Done</button>
    </div>
    <div className="drawer-body">
      {reservation && <section className={`reservation-box status-${reservation.status.toLowerCase()}`} aria-label="QR reservation">
        <div>
          <span className="eyebrow">{reservation.status === "HELD" ? "QR reservation · waiting for payment" : "QR booking · session started"}</span>
          <p className="reservation-main"><b>{formatDurationLabel(reservation.durationMs)}</b> · booking <b>{reservation.ref}</b></p>
          {reservation.phone && <p><a href={`tel:${reservation.phone}`}>Call {formatMalaysianMobile(reservation.phone)}</a></p>}
          {reservation.status === "HELD" && <p>Hold ends in <b>{countdown(reservation.holdUntil, serverNow)}</b></p>}
        </div>
        {reservation.status === "HELD" && <div className="reservation-buttons">
          <ActionButton control="start-reserved" text={`Start ${formatDurationLabel(reservation.durationMs)}`} context={station.name} pending={pending}
            onActivate={() => onStartReserved(station)} className="primary" />
          <ActionButton control="release" text="Release" context={station.name} pending={pending} onActivate={() => onRelease(station)} />
        </div>}
      </section>}
      <StationCard
        domId={`detail-${station.id}`}
        station={station}
        serverNow={serverNow}
        stale={stale}
        selected={false}
        pending={pending}
        error={error}
        {...handlers}
      />
      <RemotePanel station={station} pending={pending} onAction={onRemoteAction} />
    </div>
  </Modal>;
}

import type { StationAction, StationView } from "@ps5-cafe/contracts";
import { blockingLabel, formatTime, remainingMs } from "../logic.js";
import { remoteHref, stationHref, statusLabel, tvShowsLabel } from "../navigation.js";
import type { PendingIntent } from "../useCommands.js";
import { RemotePanel } from "../components/RemotePanel.js";

interface RemotePageProps {
  stations: readonly StationView[];
  selected: StationView;
  serverNow: number;
  pending: PendingIntent | undefined;
  onAction: (station: StationView, control: string, action: StationAction) => void;
}

/** Pick a TV, see what it reports, and send keys. The picker is links, so each TV's remote has its own address. */
export function RemotePage({ stations, selected, serverNow, pending, onAction }: RemotePageProps) {
  return <>
    <div className="topbar"><div><h1>TV Remote</h1></div></div>

    <nav className="station-picker" aria-label="Choose a TV">
      {stations.map((station) => <a
        key={station.id}
        href={remoteHref(station.id)}
        className={`picker-item state-${station.session.status.toLowerCase()}${station.connection === "OFFLINE" ? " is-offline" : ""}`}
        aria-current={station.id === selected.id ? "page" : undefined}
      >
        <b>{station.name}</b>
        <small>{station.connection === "OFFLINE" ? "Offline" : statusLabel(station.session.status)}</small>
      </a>)}
    </nav>

    <section className="remote-status" aria-label={`${selected.name} status`}>
      <div><span className="eyebrow">Time left</span><b className="timer-small">{formatTime(remainingMs(selected, serverNow))}</b></div>
      <div><span className="eyebrow">Session</span><b>{statusLabel(selected.session.status)}</b></div>
      <div><span className="eyebrow">TV shows</span><b>{tvShowsLabel(selected)}</b></div>
      {selected.mode === "EXPIRED" && <div><span className="eyebrow">Expired screen</span><b className={`blocking-${selected.blockingStatus.toLowerCase()}`}>{blockingLabel(selected.blockingStatus)}</b></div>}
      <a className="remote-status-link" href={stationHref(selected.id)}>Session actions for {selected.name}</a>
    </section>

    <RemotePanel station={selected} pending={pending} onAction={onAction} />
    {selected.lastCommand && <p className="command remote-last">
      Last command: <b>{selected.lastCommand.outcome}</b> {selected.lastCommand.message}
    </p>}
  </>;
}

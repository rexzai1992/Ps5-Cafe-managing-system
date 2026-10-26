import type { DeviceCapabilities, StationView } from "@ps5-cafe/contracts";
import { formatClock, outcomeTone } from "../logic.js";
import { connectionLabel, remoteHref, stationHref, tvShowsLabel } from "../navigation.js";
import { RemoteSetup } from "../components/RemoteSetup.js";
import { ScreenLinks } from "../components/ScreenLinks.js";

const CAPABILITY_LABELS: [keyof DeviceCapabilities, string][] = [
  ["remoteKeys", "Remote keys"],
  ["inputSwitching", "HDMI switching"],
  ["advertisingPlayback", "Advertising"],
  ["stateVerification", "Reads back state"],
  ["secureDisplayBlocking", "Tamper-resistant lock"],
];

/** Read-only device inventory. Pairing and real adapters arrive only after physical verification (Phase 4). */
export function DevicesPage({ stations, serverNow }: { stations: readonly StationView[]; serverNow: number }) {
  return <>
    <div className="topbar"><div><h1>Device Settings</h1></div></div>
    <p className="banner tone-info page-banner">
      {stations.some((station) => station.simulated)
        ? <span>Every TV here is a <b>simulated</b> adapter. Real Android TV, Google TV and Samsung adapters stay disabled until each model passes the
          physical test record in <code>docs/HARDWARE_LIMITATIONS.md</code>. Pairing and adding TVs will appear here then.</span>
        : <span>Live, <b>screen only</b>: each TV shows its screen page (TV browser or companion app) and the server never sends the TV a command.
          Switch inputs with the TV remote. Control adapters stay disabled until each model passes the physical test record in{" "}
          <code>docs/HARDWARE_LIMITATIONS.md</code>.</span>}
    </p>

    <ScreenLinks stations={stations} serverNow={serverNow} />
    {stations.some((station) => station.adapterKind === "screen-only") && <RemoteSetup stations={stations} />}

    <h2 className="section-heading">TVs</h2>
    <ul className="device-list" aria-label="TVs">
      {stations.map((station) => <li key={station.id} className="device-row">
        <div className="device-id">
          <b>{station.name}</b>
          <small>{station.simulated ? "Simulated" : station.adapterKind === "screen-only" ? "Screen only · no TV control" : station.adapterKind}</small>
        </div>
        <dl className="device-facts">
          <div><dt>Connection</dt><dd className={`conn-${station.connection.toLowerCase()}`}>{connectionLabel(station.connection)}</dd></div>
          <div><dt>TV shows</dt><dd>{tvShowsLabel(station)}</dd></div>
          <div><dt>Volume</dt><dd>{station.adapterKind === "screen-only" ? "Not controlled" : station.deviceState.muted ? "Muted" : station.deviceState.volume}</dd></div>
          <div className="device-caps"><dt>Can do</dt><dd>
            {CAPABILITY_LABELS.map(([key, label]) => <span key={key} className={`cap ${station.capabilities[key] ? "cap-yes" : "cap-no"}`}>
              <span aria-hidden="true">{station.capabilities[key] ? "✓" : "✕"}</span> {label}<span className="sr-only">: {station.capabilities[key] ? "yes" : "no"}</span>
            </span>)}
          </dd></div>
          <div className="device-last"><dt>Last command</dt><dd>
            {station.lastCommand
              ? <span className={`command tone-${outcomeTone(station.lastCommand.outcome)}`}><b>{station.lastCommand.outcome}</b> {formatClock(station.lastCommand.completedAt, true)}</span>
              : "None yet"}
          </dd></div>
        </dl>
        <div className="device-links">
          <a href={stationHref(station.id)}>Details</a>
          <a href={remoteHref(station.id)}>Remote</a>
        </div>
      </li>)}
    </ul>
  </>;
}

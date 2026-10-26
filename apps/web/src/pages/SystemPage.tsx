import type { ReactNode } from "react";
import type { SystemSnapshot } from "@ps5-cafe/contracts";
import { isDevelopmentToken, setStaffToken, staffToken } from "../api.js";
import { formatClock, formatDurationLabel } from "../logic.js";

interface SystemPageProps {
  snapshot: SystemSnapshot;
  live: boolean;
  /** The simulation controls, rendered only in simulation mode. */
  simulation: ReactNode;
}

/** Server status and, in simulation mode, the fake-time and TV-fault controls. Nothing here changes real devices. */
export function SystemPage({ snapshot, live, simulation }: SystemPageProps) {
  return <>
    <div className="topbar"><div><h1>System Settings</h1></div></div>
    <section className="settings-grid" aria-label="Server status">
      <div className="settings-item"><span className="eyebrow">Live updates</span><b className={live ? "conn-online" : "conn-offline"}>{live ? "Connected" : "Reconnecting…"}</b></div>
      <div className="settings-item"><span className="eyebrow">Server clock</span><b>{formatClock(snapshot.serverTime, true)}</b>
        <small>{snapshot.acceleratedByMs > 0 ? `Simulated +${formatDurationLabel(snapshot.acceleratedByMs)}` : "No simulated offset"}</small></div>
      <div className="settings-item"><span className="eyebrow">Mode</span><b>{snapshot.simulationMode ? "Simulation" : "Live"}</b>
        <small>{snapshot.simulationMode
          ? "Hardware commands disabled"
          : "Screen-only TVs: each shows its screen page; the server does not switch TV inputs until a real adapter passes the physical test"}</small></div>
      <div className="settings-item"><span className="eyebrow">Stations</span><b>{snapshot.stations.length}</b><small>Seeded by STATION_COUNT</small></div>
    </section>
    {isDevelopmentToken(staffToken()) && <p className="banner tone-amber page-banner">
      <span>This dashboard uses the development token. Before real customers use QR booking, start the server with a long random
      <code>PS5_CAFE_API_TOKEN</code> and serve a production build (see README); staff then sign in once per device.</span>
    </p>}
    <p className="settings-actions">
      <button type="button" onClick={() => { setStaffToken(null); window.location.reload(); }}>Sign out of this device</button>
    </p>
    {simulation}
  </>;
}

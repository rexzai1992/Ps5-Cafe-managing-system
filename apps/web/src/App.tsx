import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import type { StationAction, StationView, SystemSnapshot } from "@ps5-cafe/contracts";
import {
  describeConnectError, errorMessageFromBody, releaseReservationUrl, REQUEST_TIMEOUT_MS, setStaffToken, SIMULATION_ADVANCE_URL,
  staffToken, stationActionUrl,
} from "./api.js";
import { reservationLine } from "./reservations.js";
import { StaffSignIn } from "./components/StaffSignIn.js";
import {
  actionTitle, type AnnouncedMap, attentionItems, type Confirmation, confirmationFor, formatClock, formatDurationLabel, isStale,
  nextAnnouncements, pendingLabel, remainingMs, STALE_AFTER_MS, summaryCounts,
} from "./logic.js";
import { type Intent, useCommands } from "./useCommands.js";
import { ConfirmDialog } from "./components/ConfirmDialog.js";
import { DurationDialog } from "./components/DurationDialog.js";
import { ActionButton } from "./components/ActionButton.js";
import { AlertIcon, NAV_ICONS } from "./components/Icons.js";
import { SIMULATION_SCOPE, SimulationControls } from "./components/SimulationControls.js";
import type { CardHandlers } from "./components/StationCard.js";
import { StationPanel } from "./components/StationPanel.js";
import { StationTile } from "./components/StationTile.js";
import { type Filter, FILTERS, filterStations, NAV_ITEMS, parseRoute, type Route, stationHref } from "./navigation.js";
import { DevicesPage } from "./pages/DevicesPage.js";
import { MediaPage } from "./pages/MediaPage.js";
import { RemotePage } from "./pages/RemotePage.js";
import { SystemPage } from "./pages/SystemPage.js";

type DialogState =
  | { kind: "custom"; stationId: string }
  | { kind: "set-remaining"; stationId: string }
  | { kind: "confirm"; stationId: string; confirmation: Confirmation; intent: Intent };

const PAGE_TITLES: Record<Route["page"], string> = {
  dashboard: "Stations", remote: "TV Remote", media: "Media Manager", devices: "Device Settings", settings: "System Settings",
};

function stationIntent(station: StationView, control: string, action: StationAction, title?: string): Intent {
  return {
    scope: station.id,
    control,
    title: title ?? actionTitle(action),
    pendingLabel: control === "retry-screen" ? "Retrying…" : pendingLabel(action),
    url: stationActionUrl(station.id),
    body: action,
  };
}

function isStationView(value: unknown): value is StationView {
  return typeof value === "object" && value !== null && "id" in value && "session" in value && "deviceState" in value;
}

function isSnapshot(value: unknown): value is SystemSnapshot {
  return typeof value === "object" && value !== null && "serverTime" in value && "stations" in value && Array.isArray(value.stations);
}

/**
 * Moves focus into a station, e.g. after the focused Start button disappeared because a session is now running. The
 * open detail panel wins over the dashboard tile behind it.
 */
function focusCard(stationId: string, preferAction: boolean): void {
  const card = document.getElementById(`detail-${stationId}`) ?? document.getElementById(`station-${stationId}`);
  if (!card) return;
  const action = preferAction ? card.querySelector<HTMLElement>(".actions button, .tile-actions button") : null;
  (action ?? card).focus();
}

export function App() {
  const [token, setToken] = useState<string | null>(() => staffToken());
  const [authFailed, setAuthFailed] = useState(false);
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [filter, setFilter] = useState<Filter>("all");
  const [remoteTarget, setRemoteTarget] = useState("ps5-01");
  const [simTarget, setSimTarget] = useState("ps5-01");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [lastSnapshotAt, setLastSnapshotAt] = useState<number | null>(null);
  const [nowLocal, setNowLocal] = useState(() => Date.now());
  const [mountedAt] = useState(() => Date.now());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [announcement, setAnnouncement] = useState({ id: 0, text: "" });
  /** True when the open station panel was reached by navigating inside the app, so closing it can step back in history. */
  const panelPushedRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const announcedRef = useRef<AnnouncedMap | null>(null);
  const seenReservationsRef = useRef<Set<string> | null>(null);

  const announce = useCallback((text: string) => setAnnouncement((previous) => ({ id: previous.id + 1, text })), []);

  const commands = useCommands({
    onSuccess: (intent, body) => {
      let scopeName = "Simulation";
      if (isSnapshot(body)) setSnapshot(body);
      else if (isStationView(body)) {
        scopeName = body.name;
        setSnapshot((previous) => previous && { ...previous, stations: previous.stations.map((station) => (station.id === body.id ? body : station)) });
      }
      announce(`${scopeName}: ${intent.title} done`);
      if (intent.scope === SIMULATION_SCOPE) return;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body) focusCard(intent.scope, true);
      });
    },
  });

  // Initial snapshot over HTTP, then live snapshots over Socket.IO.
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    const received = (next: SystemSnapshot) => {
      setSnapshot((previous) => (previous && previous.serverTime > next.serverTime ? previous : next));
      setLastSnapshotAt(Date.now());
      setConnectionError(null);
    };
    fetch("/api/snapshot", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .then(async (response) => {
        if (response.status === 401) { if (!cancelled) setAuthFailed(true); throw new Error("Unauthorized"); }
        if (!response.ok) throw new Error(errorMessageFromBody(response.status, await response.text()));
        const next = await response.json() as SystemSnapshot;
        if (!cancelled) received(next);
      })
      .catch((reason: unknown) => { if (!cancelled) setConnectionError(describeConnectError(reason)); });

    const socket = io({ path: "/socket.io", auth: { token } });
    socket.on("connect", () => {
      setConnected(true);
      setEverConnected(true);
      setAttempt(0);
      setConnectionError(null);
    });
    socket.on("disconnect", (reason) => {
      setConnected(false);
      // The client does not reconnect on its own after the server closed the connection deliberately.
      if (reason === "io server disconnect") socket.connect();
    });
    socket.on("connect_error", (reason) => {
      setConnected(false);
      if (reason.message === "Unauthorized") { setAuthFailed(true); socket.close(); }
      setConnectionError(describeConnectError(reason));
    });
    socket.io.on("reconnect_attempt", (count) => setAttempt(count));
    socket.on("snapshot", received);
    return () => { cancelled = true; socket.close(); };
  }, [token]);

  // One-second freshness check on the local clock.
  useEffect(() => {
    const timer = setInterval(() => setNowLocal(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  // Ending-soon announcements. The first snapshot only seeds state, so a page load does not read out every warning.
  useEffect(() => {
    if (!snapshot) return;
    const first = announcedRef.current === null;
    const result = nextAnnouncements(snapshot.stations, snapshot.serverTime, announcedRef.current ?? new Map());
    announcedRef.current = result.announced;
    if (!first && result.messages.length > 0) announce(result.messages.join(". "));
  }, [snapshot, announce]);

  // A new QR reservation is announced once (screen readers) — the first snapshot only seeds what is already open.
  useEffect(() => {
    if (!snapshot) return;
    const held = snapshot.stations.filter((station) => station.reservation?.status === "HELD");
    const ids = new Set(held.map((station) => station.reservation!.id));
    const seen = seenReservationsRef.current;
    seenReservationsRef.current = ids;
    if (!seen) return;
    const fresh = held.filter((station) => !seen.has(station.reservation!.id));
    if (fresh.length > 0) announce(fresh.map((station) => `New QR reservation: ${station.name}, ${formatDurationLabel(station.reservation!.durationMs)}`).join(". "));
  }, [snapshot, announce]);

  // Hash routing: every page and every station panel has an address, so links and the back button work.
  useEffect(() => {
    const onHashChange = () => {
      const next = parseRoute(window.location.hash);
      panelPushedRef.current = next.page === "dashboard" && next.stationId !== null;
      setRoute((previous) => {
        if (previous.page !== next.page) window.scrollTo(0, 0);
        return next;
      });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    document.title = `${PAGE_TITLES[route.page]} · PS5 Cafe Control`;
    if (route.page === "remote" && route.stationId) setRemoteTarget(route.stationId);
  }, [route]);

  if (!token || authFailed) {
    return <StaffSignIn
      rejected={authFailed}
      onSubmit={(next) => { setStaffToken(next); setAuthFailed(false); setConnectionError(null); setToken(next); }}
    />;
  }

  if (!snapshot) {
    return <main className="loading">
      <h1>PS5 Cafe Control</h1>
      <p role={connectionError ? "alert" : undefined}>{connectionError ?? "Connecting to the local management server…"}</p>
    </main>;
  }

  const serverNow = snapshot.serverTime;
  const stations = [...snapshot.stations].sort((a, b) => a.number - b.number);
  const counts = summaryCounts(stations, serverNow);
  const attention = attentionItems(stations, serverNow);
  const liveConnected = connected || (!everConnected && nowLocal - mountedAt < STALE_AFTER_MS);
  const stale = isStale(nowLocal, lastSnapshotAt, liveConnected);
  const remoteStation = stations.find((station) => station.id === remoteTarget) ?? stations[0];
  const panelStation = route.page === "dashboard" && route.stationId ? stations.find((station) => station.id === route.stationId) : undefined;
  const visible = filterStations(stations, filter, serverNow);
  const simTargetStation = stations.find((station) => station.id === simTarget) ?? stations[0];
  const dialogStation = dialog ? stations.find((station) => station.id === dialog.stationId) : undefined;

  const openDialog = (next: DialogState) => {
    // A dialog that leads to a confirmation keeps the original opener, so focus returns to the card control.
    if (!dialog) openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(next);
  };

  const closeDialog = () => {
    const opener = openerRef.current;
    const stationId = dialog?.stationId;
    openerRef.current = null;
    setDialog(null);
    requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
      else if (stationId) focusCard(stationId, true);
    });
  };

  /** Every operator action enters here: one intent, an optional confirmation, then one key and one request. */
  const requestAction = (station: StationView, control: string, action: StationAction, title?: string, confirmed = false) => {
    if (commands.isPending(station.id)) return;
    const intent = stationIntent(station, control, action, title);
    const confirmation = confirmed ? null : confirmationFor(station, action, remainingMs(station, serverNow));
    if (confirmation) {
      openDialog({ kind: "confirm", stationId: station.id, confirmation, intent });
      return;
    }
    void commands.run(intent);
  };

  /** Starting a held TV is the customer arriving and paying: start with the reserved duration. */
  const startReserved = (station: StationView) => {
    const reservation = station.reservation;
    if (!reservation) return;
    requestAction(station, "start-reserved", { type: "START", durationMs: reservation.durationMs }, `Start ${formatDurationLabel(reservation.durationMs)}`);
  };

  const releaseReservation = (station: StationView) => {
    if (commands.isPending(station.id) || !station.reservation) return;
    const intent: Intent = {
      scope: station.id, control: "release", title: "Release reservation", pendingLabel: "Releasing…", url: releaseReservationUrl(station.id), body: {},
    };
    // Confirmed through the dialog, which then runs the intent.
    openDialog({
      kind: "confirm", stationId: station.id, intent,
      confirmation: {
        title: `Release ${station.name}?`,
        body: [`The customer's hold (${reservationLine(station.reservation, serverNow)}) is cancelled and their number is deleted.`, "Their phone will show that the counter released it."],
        confirmLabel: "Release", safeLabel: "Keep reservation", tone: "warning",
      },
    });
  };
  const held = stations.filter((station) => station.reservation?.status === "HELD");

  const advance = (control: string, durationMs: number) => {
    if (commands.isPending(SIMULATION_SCOPE)) return;
    void commands.run({
      scope: SIMULATION_SCOPE,
      control,
      title: `Fast-forward ${formatDurationLabel(durationMs)}`,
      pendingLabel: "Fast-forwarding…",
      url: SIMULATION_ADVANCE_URL,
      body: { durationMs },
    });
  };

  const submitCustom = (station: StationView, durationMs: number) => {
    closeDialog();
    // The dialog itself is the confirmation, including its offline warning.
    requestAction(station, "custom", { type: "START", durationMs }, undefined, true);
  };

  const submitSetRemaining = (station: StationView, durationMs: number) => {
    const action: StationAction = { type: "SET_REMAINING", durationMs };
    const intent = stationIntent(station, "set", action);
    const confirmation = confirmationFor(station, action, remainingMs(station, serverNow));
    if (confirmation) {
      setDialog({ kind: "confirm", stationId: station.id, confirmation, intent });
      return;
    }
    closeDialog();
    void commands.run(intent);
  };

  const handlers: Omit<CardHandlers, "onSelect"> = {
    onAction: (station, control, action, title) => requestAction(station, control, action, title),
    onCustom: (station) => { if (!commands.isPending(station.id)) openDialog({ kind: "custom", stationId: station.id }); },
    onSetRemaining: (station) => { if (!commands.isPending(station.id)) openDialog({ kind: "set-remaining", stationId: station.id }); },
    onRetry: (scope) => { void commands.retry(scope); },
    onDismiss: (scope) => commands.dismiss(scope),
  };

  const filterCounts: Record<Filter, number> = {
    all: stations.length, reserved: stations.filter((station) => station.reservation?.status === "HELD").length, playing: counts.playing, paused: counts.paused, idle: counts.idle, expired: counts.expired,
    offline: counts.offline, attention: counts.attention,
  };

  const closePanel = () => {
    const stationId = route.page === "dashboard" ? route.stationId : null;
    if (panelPushedRef.current) window.history.back();
    else {
      window.history.replaceState(null, "", "#/");
      setRoute({ page: "dashboard", stationId: null });
    }
    panelPushedRef.current = false;
    requestAnimationFrame(() => { if (stationId) document.querySelector<HTMLElement>(`#station-${stationId} .tile-head`)?.focus(); });
  };

  const clockPending = commands.pending.get(SIMULATION_SCOPE);
  const simulationControls = snapshot.simulationMode && <SimulationControls
    snapshot={snapshot}
    target={simTargetStation}
    onTargetChange={setSimTarget}
    pendingFor={(scope) => commands.pending.get(scope)}
    error={commands.errors.get(SIMULATION_SCOPE)}
    onAdvance={advance}
    onAction={(station, control, action) => requestAction(station, control, action)}
    onRetry={handlers.onRetry}
    onDismiss={handlers.onDismiss}
  />;

  const dashboard = <>
    <div className="topbar">
      <div><h1>Stations</h1></div>
      <div className="topbar-side">
        <p className="server-clock">
          Server clock <b>{formatClock(serverNow, true)}</b>
          {snapshot.acceleratedByMs > 0 && <span> (simulated +{formatDurationLabel(snapshot.acceleratedByMs)})</span>}
        </p>
        {snapshot.simulationMode && <div className="quick-sim" role="group" aria-label="Simulated clock">
          <span>Simulation</span>
          <ActionButton control="ff-5m" text="+5 min" context="simulated clock" pending={clockPending} onActivate={() => advance("ff-5m", 5 * 60_000)} />
          <ActionButton control="ff-1h" text="+1 hour" context="simulated clock" pending={clockPending} onActivate={() => advance("ff-1h", 60 * 60_000)} />
        </div>}
      </div>
    </div>

    <div className="filter-bar" role="group" aria-label="Show stations">
      {FILTERS.map(({ id, label }) => <button
        key={id}
        type="button"
        className={`filter${id === "attention" && counts.attention > 0 ? " is-alert" : ""}`}
        aria-pressed={filter === id}
        onClick={() => setFilter(id)}
      ><span>{label}</span><b>{filterCounts[id]}</b></button>)}
    </div>

    {held.length > 0 && filter !== "reserved" && <section className="reservations" aria-labelledby="reservations-heading">
      <h2 id="reservations-heading">New QR reservations · start when paid</h2>
      <ul>
        {held.map((station) => <li key={station.id} className="reservation-item">
          <a href={stationHref(station.id)}><b>{station.name}</b> <span>{reservationLine(station.reservation!, serverNow)}</span></a>
          <span className="reservation-buttons">
            <ActionButton control="start-reserved" text={`Start ${formatDurationLabel(station.reservation!.durationMs)}`} context={station.name}
              pending={commands.pending.get(station.id)} onActivate={() => startReserved(station)} className="primary" />
            <ActionButton control="release" text="Release" context={station.name} pending={commands.pending.get(station.id)} onActivate={() => releaseReservation(station)} />
          </span>
        </li>)}
      </ul>
    </section>}

    {attention.length > 0 && filter !== "attention" && <section className="attention" aria-labelledby="attention-heading">
      <h2 id="attention-heading"><AlertIcon /> Needs attention</h2>
      <ul>
        {attention.map((item) => <li key={item.stationId}>
          <a className={`attention-item severity-${item.severity}`} href={stationHref(item.stationId)}>
            <b>{item.name}</b> <span>{item.text}</span>
          </a>
        </li>)}
      </ul>
    </section>}

    {visible.length > 0
      ? <section className="tile-grid" aria-label={filter === "all" ? "All stations" : `${FILTERS.find((f) => f.id === filter)?.label} stations`}>
        {visible.map((station) => <StationTile
          key={station.id}
          station={station}
          serverNow={serverNow}
          stale={stale}
          pending={commands.pending.get(station.id)}
          error={commands.errors.get(station.id)}
          onAction={handlers.onAction}
          onStartReserved={startReserved}
          onRelease={releaseReservation}
        />)}
      </section>
      : <p className="empty-filter">No stations are {FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} right now.{" "}
        <button type="button" onClick={() => setFilter("all")}>Show all {stations.length}</button></p>}
  </>;

  let page;
  switch (route.page) {
    case "dashboard": page = dashboard; break;
    case "remote": page = remoteStation && <RemotePage
      stations={stations}
      selected={remoteStation}
      serverNow={serverNow}
      pending={commands.pending.get(remoteStation.id)}
      onAction={(station, control, action) => requestAction(station, control, action)}
    />; break;
    case "media": page = <MediaPage />; break;
    case "devices": page = <DevicesPage stations={stations} serverNow={serverNow} />; break;
    case "settings": page = <SystemPage snapshot={snapshot} live={!stale} simulation={simulationControls} />; break;
  }

  return <div className="app-shell">
    <aside>
      <div className="brand"><span className="brand-mark" aria-hidden="true">P5</span><div><b>PS5 Cafe</b><small>TV Control</small></div></div>
      <nav aria-label="Main" className="main-nav">
        <ul className="nav-list">
          {NAV_ITEMS.map((item) => {
            const active = item.page === route.page;
            return <li key={item.page}>
              <a href={item.href} className={`nav-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
                {NAV_ICONS[item.page]}
                <span className="nav-label">{item.label}</span>
                <span className="nav-short" aria-hidden="true">{item.short}</span>
                {item.soon && <span className="soon">Soon</span>}
              </a>
            </li>;
          })}
        </ul>
      </nav>
      <div className="system-chip">
        <i aria-hidden="true" className={snapshot.simulationMode ? "dot-sim" : "dot-live"} />
        {snapshot.simulationMode
          ? <>Simulation mode<small>Hardware commands disabled</small></>
          : <>Live<small>TVs show their screen pages; TV inputs are not controlled yet</small></>}
      </div>
    </aside>

    <main id="main">
      <div role="status" className="sr-only"><span key={announcement.id}>{announcement.text}</span></div>

      {stale && <div className="banner tone-red page-banner" role="alert">
        <p><AlertIcon /><span>
          Live updates lost — reconnecting{attempt > 0 ? ` (attempt ${attempt})` : ""}.{" "}
          Times shown are from {formatClock(lastSnapshotAt ?? mountedAt, true)}; the server keeps time.
        </span></p>
        {connectionError && <p className="banner-detail">{connectionError}</p>}
      </div>}
      {!stale && connectionError && <div className="banner tone-amber page-banner" role="alert"><p><AlertIcon /><span>{connectionError}</span></p></div>}

      {page}
    </main>

    {panelStation && <StationPanel
      station={panelStation}
      serverNow={serverNow}
      stale={stale}
      pending={commands.pending.get(panelStation.id)}
      error={commands.errors.get(panelStation.id)}
      handlers={handlers}
      onRemoteAction={(station, control, action) => requestAction(station, control, action)}
      onStartReserved={startReserved}
      onRelease={releaseReservation}
      onClose={closePanel}
    />}

    {dialog?.kind === "confirm" && <ConfirmDialog
      confirmation={dialog.confirmation}
      onCancel={closeDialog}
      onConfirm={() => { const { intent } = dialog; closeDialog(); void commands.run(intent); }}
    />}
    {dialog && dialog.kind !== "confirm" && dialogStation && <DurationDialog
      key={`${dialog.kind}-${dialog.stationId}`}
      mode={dialog.kind === "custom" ? "start" : "set-remaining"}
      station={dialogStation}
      serverNow={serverNow}
      acceleratedByMs={snapshot.acceleratedByMs}
      onCancel={closeDialog}
      onSubmit={(durationMs) => (dialog.kind === "custom" ? submitCustom(dialogStation, durationMs) : submitSetRemaining(dialogStation, durationMs))}
    />}
  </div>;
}

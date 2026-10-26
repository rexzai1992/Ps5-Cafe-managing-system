import type { StationAction, StationView } from "@ps5-cafe/contracts";
import { blockingLabel, EXTEND_MS, formatDurationLabel, PRESETS, remainingMs, warningLevel } from "../logic.js";
import { reservationLine } from "../reservations.js";
import { connectionLabel, stationHref, statusLabel, tileActions } from "../navigation.js";
import type { PendingIntent, ScopedError } from "../useCommands.js";
import { ActionButton } from "./ActionButton.js";
import { AlertIcon, ChevronIcon, ClockIcon } from "./Icons.js";
import { TvThumbnail } from "./TvThumbnail.js";

interface StationTileProps {
  station: StationView;
  serverNow: number;
  stale: boolean;
  pending: PendingIntent | undefined;
  error: ScopedError | undefined;
  onAction: (station: StationView, control: string, action: StationAction, title?: string) => void;
  onStartReserved: (station: StationView) => void;
  onRelease: (station: StationView) => void;
}

/**
 * Compact dashboard tile: name, connection, a thumbnail of what the TV shows (status and time left in its corners), the
 * most urgent warning, and the two or three actions staff use most. The name opens the station's detail panel, which has
 * every action, the evidence and the remote.
 */
export function StationTile({ station, serverNow, stale, pending, error, onAction, onStartReserved, onRelease }: StationTileProps) {
  const { id, name } = station;
  const status = station.session.status;
  const remaining = remainingMs(station, serverNow);
  const warning = warningLevel(remaining, status);
  const offline = station.connection === "OFFLINE";
  const held = station.reservation?.status === "HELD" ? station.reservation : null;
  // A held TV offers only what the counter does next: start the paid session, or release the hold.
  const actions = held ? [] : tileActions(status);
  const act = (control: string, action: StationAction, title?: string) => () => onAction(station, control, action, title);
  const button = (control: string, text: string, onActivate: () => void, className?: string) =>
    <ActionButton key={control} control={control} text={text} context={name} pending={pending} onActivate={onActivate} className={className} />;

  // The most important thing to see on a small tile, in priority order.
  const screenProblem = station.mode === "EXPIRED" && (station.blockingStatus === "FAILED" || station.blockingStatus === "UNVERIFIED");
  const chip = error
    ? { tone: "red", text: `${error.title} failed`, icon: <AlertIcon /> }
    : held
      ? { tone: "amber", text: reservationLine(held, serverNow), icon: <ClockIcon /> }
    : screenProblem
      ? { tone: station.blockingStatus === "FAILED" ? "red" : "amber", text: `Expired screen: ${blockingLabel(station.blockingStatus)}`, icon: <AlertIcon /> }
      : offline && (status === "ACTIVE" || status === "PAUSED")
        ? { tone: "amber", text: "TV offline — timer still running", icon: <AlertIcon /> }
        : warning
          ? { tone: warning.tone, text: warning.text, icon: warning.tone === "red" ? <AlertIcon /> : <ClockIcon /> }
          : null;
  const pill = held ? "Reserved" : statusLabel(status);

  const classes = ["tile", held ? "state-reserved" : `state-${status.toLowerCase()}`, offline ? "is-offline" : "", chip?.tone === "red" ? "has-alert" : ""];
  return <article id={`station-${id}`} tabIndex={-1} aria-labelledby={`tile-${id}-name`} className={classes.filter(Boolean).join(" ")}>
    <a className="tile-head" href={stationHref(id)} aria-label={`${name} details`}>
      <span className="tile-name" id={`tile-${id}-name`}>{name}</span>
      <span className={`connection conn-${station.connection.toLowerCase()}`}>
        <span aria-hidden="true">● </span>{connectionLabel(station.connection)}
      </span>
      <ChevronIcon />
    </a>

    {/* The thumbnail opens the same panel as the name: the TV's screen live, every control, and its remote. */}
    <a className="thumb-link" href={stationHref(id)} aria-label={`${name}: live screen and controls`}>
      <TvThumbnail station={station} serverNow={serverNow} stale={stale}
        badge={<span className={`status-pill pill-${held ? "reserved" : status.toLowerCase()}`}>{pill}</span>} />
    </a>

    {chip && <p className={`tile-chip tone-${chip.tone}`} role={chip.tone === "red" ? "alert" : undefined}>{chip.icon}<span>{chip.text}</span></p>}

    <div className={`tile-actions${actions.includes("PRESETS") ? " is-presets" : ""}`}>
      {held && button("start-reserved", `Start ${formatDurationLabel(held.durationMs)}`, () => onStartReserved(station), "primary")}
      {held && button("release", "Release", () => onRelease(station))}
      {actions.includes("PRESETS") && PRESETS.map((preset) =>
        button(`preset-${preset.id}`, preset.label, act(`preset-${preset.id}`, { type: "START", durationMs: preset.ms }), "primary"))}
      {actions.includes("RESUME") && button("toggle", "Resume", act("toggle", { type: "RESUME" }), "primary")}
      {actions.includes("ADD_TIME") && button("add", "+30m", act("add", { type: "ADD_TIME", durationMs: EXTEND_MS }), status === "EXPIRED" ? "primary" : undefined)}
      {actions.includes("PAUSE") && button("toggle", "Pause", act("toggle", { type: "PAUSE" }))}
      {actions.includes("END") && button("end", "End", act("end", { type: "END" }), "danger")}
    </div>
  </article>;
}

import type { StationAction, StationView } from "@ps5-cafe/contracts";
import {
  allowedActions, blockingLabel, type CardAction, EXTEND_MS, expiredScreenBanner, formatClock, formatTime, offlineNotice,
  outcomeTone, PRESETS, remainingMs, warningLevel,
} from "../logic.js";
import type { PendingIntent, ScopedError } from "../useCommands.js";
import { connectionLabel, sentenceCase } from "../navigation.js";
import { ActionButton } from "./ActionButton.js";
import { AlertIcon, ClockIcon, InfoIcon } from "./Icons.js";
import { LiveScreen } from "./LiveScreen.js";

export interface CardHandlers {
  onAction: (station: StationView, control: string, action: StationAction, title?: string) => void;
  onCustom: (station: StationView) => void;
  onSetRemaining: (station: StationView) => void;
  /** Shows the card's "Remote" toggle. Omitted where the remote is already on screen (the station detail panel). */
  onSelect?: (station: StationView) => void;
  onRetry: (scope: string) => void;
  onDismiss: (scope: string) => void;
}

interface StationCardProps extends CardHandlers {
  station: StationView;
  serverNow: number;
  stale: boolean;
  selected: boolean;
  pending: PendingIntent | undefined;
  error: ScopedError | undefined;
  /** Element id; defaults to `station-<id>`. The detail panel passes its own so it never clashes with the dashboard tile. */
  domId?: string;
}

export function StationCard(props: StationCardProps) {
  const { station, serverNow, stale, selected, pending, error, onAction, onCustom, onSetRemaining, onSelect, onRetry, onDismiss, domId } = props;
  const { id, name } = station;
  const status = station.session.status;
  const remaining = remainingMs(station, serverNow);
  const warning = warningLevel(remaining, status);
  const banner = expiredScreenBanner(station);
  const notice = offlineNotice(station);
  const allowed = allowedActions(status);
  const has = (action: CardAction) => allowed.includes(action);
  const offline = station.connection === "OFFLINE";
  const act = (control: string, action: StationAction, title?: string) => () => onAction(station, control, action, title);
  const rendered = new Set<string>();
  const button = (control: string, text: string, onActivate: () => void, className?: string) => {
    rendered.add(control);
    return <ActionButton key={control} control={control} text={text} context={name} pending={pending} onActivate={onActivate} className={className} />;
  };

  // Built before the rest of the card so `rendered` is complete when the pending line is decided.
  const bannerElement = banner && <div className={`banner tone-${banner.tone}`} role={banner.tone === "red" ? "alert" : undefined}>
    <p>{banner.tone === "info" ? <InfoIcon /> : <AlertIcon />}<span>{banner.text}</span></p>
    {banner.retry && button("retry-screen", "Retry expired screen", act("retry-screen", { type: "LOCK" }, "Retry expired screen"), "danger-solid")}
  </div>;
  const actions = <div className="actions">
    {has("PRESETS") && <div className="action-group" role="group" aria-labelledby={`${id}-start-label`}>
      <span id={`${id}-start-label`} className="group-label">
        {status === "EXPIRED" ? "New session" : "Start session"}<span className="sr-only"> on {name}</span>
      </span>
      <div className="preset-row">
        {PRESETS.map((preset) => button(`preset-${preset.id}`, preset.label, act(`preset-${preset.id}`, { type: "START", durationMs: preset.ms }), "primary"))}
      </div>
      {has("CUSTOM") && <div className="action-row">{button("custom", "Custom…", () => onCustom(station))}</div>}
    </div>}
    <div className="action-row">
      {(has("PAUSE") || has("RESUME")) && button("toggle", has("PAUSE") ? "Pause" : "Resume", act("toggle", { type: has("PAUSE") ? "PAUSE" : "RESUME" }))}
      {has("ADD_TIME") && button("add", status === "EXPIRED" ? "Extend +30m" : "+30m", act("add", { type: "ADD_TIME", durationMs: EXTEND_MS }))}
      {has("SET_REMAINING") && button("set", "Set remaining…", () => onSetRemaining(station))}
      {has("ADVERTISING") && button("ads", "Advertising", act("ads", { type: "SHOW_ADVERTISING" }))}
      {has("RETRY_EXPIRED_SCREEN") && !banner?.retry && button("retry-screen", "Retry expired screen", act("retry-screen", { type: "LOCK" }, "Retry expired screen"))}
    </div>
    {(has("END") || has("EXPIRE_NOW")) && <div className="action-row danger-zone">
      {has("END") && button("end", "End session", act("end", { type: "END" }), "danger")}
      {has("EXPIRE_NOW") && button("expire", "Expire now", act("expire", { type: "LOCK" }, "Expire now"), "danger")}
    </div>}
  </div>;
  // The control that started the intent may not be on the card: a live snapshot can remove it (Start buttons vanish
  // once a session runs) before the HTTP answer arrives, or it lives in the remote or simulation panel. Keep the
  // pending state visible on the card until the answer arrives.
  if (error?.retry) rendered.add("retry");
  const pendingElsewhere = pending !== undefined && !rendered.has(pending.control);

  const classes = ["station-card", `state-${status.toLowerCase()}`, offline ? "is-offline" : "", selected ? "is-selected" : ""];
  return <article id={domId ?? `station-${id}`} tabIndex={-1} aria-labelledby={`${id}-name`} className={classes.filter(Boolean).join(" ")}>
    <header>
      <div>
        <span className="eyebrow">Station {station.number.toString().padStart(2, "0")}</span>
        <h2 id={`${id}-name`}>{name}</h2>
      </div>
      <div className="card-tools">
        <span className={`connection conn-${station.connection.toLowerCase()}`}>
          <span aria-hidden="true">● </span><span className="sr-only">TV </span>{connectionLabel(station.connection)}
        </span>
        {onSelect && <button
          type="button"
          className="remote-toggle"
          aria-pressed={selected}
          aria-controls="remote-panel"
          aria-label={`Remote ${name}`}
          onClick={() => onSelect(station)}
        >Remote</button>}
      </div>
    </header>

    <LiveScreen station={station} />

    <div className="timer-row">
      <div role="timer" aria-label={`${name} time remaining`} className={`timer${stale ? " is-stale" : ""}`}>{formatTime(remaining)}</div>
      {(status === "PAUSED" || stale) && <div className="timer-tags">
        {status === "PAUSED" && <span className="tag tag-paused">Paused</span>}
        {stale && <span className="tag tag-stale">Stale</span>}
      </div>}
    </div>
    {warning && <p className={`warning tone-${warning.tone}`}>{warning.tone === "red" ? <AlertIcon /> : <ClockIcon />}<span>{warning.text}</span></p>}

    <dl className="status-grid">
      <div><dt>Mode</dt><dd>{sentenceCase(station.mode)}</dd></div>
      <div><dt>Session</dt><dd>{sentenceCase(status)}</dd></div>
      <div><dt>Expired screen</dt><dd className={`blocking-${station.blockingStatus.toLowerCase()}`}>{blockingLabel(station.blockingStatus)}</dd></div>
      <div><dt>Input</dt><dd>{station.adapterKind === "screen-only" ? "Not controlled" : station.deviceState.input}</dd></div>
    </dl>

    {bannerElement}
    {notice && <p className="banner tone-amber"><AlertIcon /><span>{notice}</span></p>}

    {station.lastCommand && <p className={`command tone-${outcomeTone(station.lastCommand.outcome)}`}>
      <b>{station.lastCommand.outcome}</b> {station.lastCommand.message}
    </p>}

    {error && <div className="card-error" role="alert">
      <p><b>{name}</b> — {error.title}: {error.message} <span className="error-time">({formatClock(error.at, true)})</span></p>
      {error.retry && <p className="retry-hint">Retry resends the same request with the same key, so it cannot run twice.</p>}
      <div className="card-error-actions">
        {error.retry && <ActionButton control="retry" text="Retry" context={`${error.title} on ${name}`} pending={pending} onActivate={() => onRetry(id)} />}
        <button type="button" aria-label={`Dismiss ${name} error`} onClick={() => onDismiss(id)}>Dismiss</button>
      </div>
    </div>}

    {pendingElsewhere && <p className="pending-line" aria-busy="true">{pending.label}</p>}
    {actions}
  </article>;
}

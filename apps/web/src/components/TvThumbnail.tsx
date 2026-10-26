import type { ReactNode } from "react";
import type { StationView } from "@ps5-cafe/contracts";
import { formatTime, remainingMs, type ThumbnailKind, thumbnailFor, timeTone } from "../logic.js";
import { AlertIcon, ClockIcon, GamepadIcon, QrIcon, TvOffIcon } from "./Icons.js";

const PICTURES: Partial<Record<ThumbnailKind, () => ReactNode>> = {
  offline: TvOffIcon, ads: QrIcon, reserved: ClockIcon, playing: GamepadIcon, paused: GamepadIcon, expired: ClockIcon,
};

interface TvThumbnailProps {
  station: StationView;
  serverNow: number;
  stale: boolean;
  /** Top-left corner, e.g. the tile's status pill. */
  badge?: ReactNode;
}

/**
 * A small drawing of what the TV is showing, from what it reports and whether its screen page is open. Nothing here
 * captures the TV's picture.
 */
export function TvThumbnail({ station, serverNow, stale, badge }: TvThumbnailProps) {
  const thumb = thumbnailFor(station);
  const remaining = remainingMs(station, serverNow);
  const Picture = PICTURES[thumb.kind];
  return <div className={`thumb thumb-${thumb.kind}`}>
    {badge && <span className="thumb-badge">{badge}</span>}
    {thumb.showsTime && <span role="timer" aria-label={`${station.name} time remaining`}
      className={`thumb-time tone-${timeTone(remaining)}${stale ? " is-stale" : ""}`}>{formatTime(remaining)}</span>}
    <div className="thumb-picture">
      {Picture && <Picture />}
      <strong><span className="sr-only">TV shows: </span>{thumb.title}</strong>
      <small>{thumb.detail}</small>
    </div>
    {thumb.mismatch
      ? <p className={`thumb-strip tone-${station.mode === "EXPIRED" ? "red" : "amber"}`}><AlertIcon /><span>{thumb.mismatch}</span></p>
      : thumb.screen === "open"
        ? <p className="thumb-strip is-open"><span aria-hidden="true">● </span>Screen open on the TV</p>
        : thumb.screen === "not-open" && <p className="thumb-strip">Screen not showing on the TV</p>}
  </div>;
}

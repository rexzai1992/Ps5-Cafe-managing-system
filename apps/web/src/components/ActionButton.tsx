import type { MouseEvent } from "react";
import type { PendingIntent } from "../useCommands.js";

interface ActionButtonProps {
  /** Identifies this control within its scope; the pending label shows only on the control that started the intent. */
  control: string;
  text: string;
  /** Appended to the visible text in the accessible name, e.g. "PS5-03" gives "Pause PS5-03". */
  context: string;
  /** The scope's in-flight intent, if any. Every control in the scope is then aria-disabled. */
  pending: PendingIntent | undefined;
  onActivate: () => void;
  /** Not available on this device (capability). Stays focusable and explains itself. */
  unavailable?: string;
  className?: string;
}

/**
 * Busy and unavailable states use aria-disabled, never the native disabled attribute, so keyboard focus is kept.
 * The second click of a double-click (event.detail > 1) is ignored so one gesture is one intent.
 */
export function ActionButton({ control, text, context, pending, onActivate, unavailable, className }: ActionButtonProps) {
  const busy = pending !== undefined;
  const mine = pending?.control === control;
  const visible = mine ? pending.label : text;
  const inactive = busy || unavailable !== undefined;
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail > 1 || inactive) return;
    onActivate();
  };
  return <button
    type="button"
    className={[className, mine ? "is-pending" : ""].filter(Boolean).join(" ") || undefined}
    aria-disabled={inactive ? "true" : undefined}
    aria-busy={mine ? "true" : undefined}
    aria-label={`${visible} ${context}`}
    title={unavailable}
    onClick={onClick}
  >
    {visible}
  </button>;
}

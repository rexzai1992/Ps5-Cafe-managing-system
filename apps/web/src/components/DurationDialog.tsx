import { type FormEvent, useId, useRef, useState } from "react";
import type { StationView } from "@ps5-cafe/contracts";
import {
  allowedActions, durationFields, endsAtText, formatDurationLabel, formatHM, formatTime, minutesText, parseCustomDuration,
  remainingMs, setRemainingChange,
} from "../logic.js";
import { Modal } from "./Modal.js";

interface DurationDialogProps {
  mode: "start" | "set-remaining";
  /** The live station from the latest snapshot, so the summary tracks the server while the dialog is open. */
  station: StationView;
  serverNow: number;
  acceleratedByMs: number;
  onSubmit: (durationMs: number) => void;
  onCancel: () => void;
}

/** Custom-duration start and set-remaining. Hours and minutes are text inputs with a numeric keypad, not type=number. */
export function DurationDialog({ mode, station, serverNow, acceleratedByMs, onSubmit, onCancel }: DurationDialogProps) {
  const id = useId();
  const remaining = remainingMs(station, serverNow);
  const [fields, setFields] = useState(() => (mode === "set-remaining" ? durationFields(remaining) : { hours: "", minutes: "" }));
  const [attempted, setAttempted] = useState(false);
  const hoursRef = useRef<HTMLInputElement>(null);

  const parsed = parseCustomDuration(fields.hours, fields.minutes);
  const status = station.session.status;
  const paused = status === "PAUSED";
  const stillAllowed = allowedActions(status).includes(mode === "start" ? "CUSTOM" : "SET_REMAINING");

  let title: string;
  let submitLabel: string;
  let canSubmit = stillAllowed && parsed.ok;
  const details: string[] = [];
  let consequence: string | null = null;

  if (mode === "start") {
    title = `${status === "EXPIRED" ? "New session" : "Custom session"} — ${station.name}`;
    submitLabel = parsed.ok ? `Start ${formatDurationLabel(parsed.ms)} on ${station.name}` : `Start on ${station.name}`;
    if (parsed.ok) details.push(endsAtText(serverNow, parsed.ms, acceleratedByMs));
  } else {
    title = `Set remaining time — ${station.name}`;
    submitLabel = `Set ${station.name}`;
    if (parsed.ok) {
      const change = setRemainingChange(remaining, parsed.ms);
      if (change.kind === "lower") {
        submitLabel = `Reduce ${station.name} to ${formatHM(parsed.ms)}`;
        consequence = `Customer loses ${minutesText(change.deltaMinutes)}`;
      } else if (change.kind === "raise") {
        submitLabel = `Set ${station.name} to ${formatHM(parsed.ms)}`;
        details.push(`Adds ${minutesText(change.deltaMinutes)}`);
      } else {
        submitLabel = "No change";
        canSubmit = false;
        details.push("Same as the current remaining time.");
      }
      if (!paused) details.push(endsAtText(serverNow, parsed.ms, acceleratedByMs));
    }
    if (paused) details.push("Session stays paused");
  }

  const showError = !parsed.ok && (attempted || parsed.code !== "EMPTY");
  let fieldMessage = "Whole minutes, from 1 minute to 24 hours.";
  if (!parsed.ok && showError) {
    fieldMessage = parsed.error;
    if (mode === "set-remaining" && parsed.code === "TOO_SHORT") {
      fieldMessage += paused ? " To stop this session, use End session." : " To stop play now, use Expire now.";
    }
  }
  const blockedMessage = stillAllowed ? null : mode === "start"
    ? `A session is already running on ${station.name}.`
    : `The session on ${station.name} is no longer running.`;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    if (!canSubmit || !parsed.ok) { hoursRef.current?.focus(); return; }
    onSubmit(parsed.ms);
  };

  const update = (field: "hours" | "minutes", value: string) => setFields((previous) => ({ ...previous, [field]: value }));

  return <Modal labelledBy={`${id}-title`} describedBy={`${id}-summary`} initialFocus={hoursRef} onClose={onCancel} className="duration">
    <form noValidate onSubmit={submit}>
      <h2 id={`${id}-title`}>{title}</h2>
      {mode === "set-remaining" && <p className="dialog-current">
        Now: <b>{formatTime(remaining)}</b> remaining{paused ? " (paused)" : ""}
      </p>}
      {mode === "start" && station.connection === "OFFLINE" && <p className="dialog-warning">
        TV offline: the timer starts on the server but the TV will not switch.
      </p>}
      <div className="duration-fields">
        <label>
          <span>Hours</span>
          <input
            ref={hoursRef}
            name="hours"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            maxLength={4}
            value={fields.hours}
            placeholder="0"
            aria-invalid={showError ? true : undefined}
            aria-describedby={`${id}-hint`}
            onChange={(event) => update("hours", event.target.value)}
          />
        </label>
        <label>
          <span>Minutes</span>
          <input
            name="minutes"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            maxLength={4}
            value={fields.minutes}
            placeholder="0"
            aria-invalid={showError ? true : undefined}
            aria-describedby={`${id}-hint`}
            onChange={(event) => update("minutes", event.target.value)}
          />
        </label>
      </div>
      <p id={`${id}-hint`} className={showError ? "field-error" : "field-hint"}>{fieldMessage}</p>
      <div id={`${id}-summary`} className="dialog-summary" aria-live="polite">
        {details.map((line) => <p key={line}>{line}</p>)}
        {blockedMessage && <p className="field-error">{blockedMessage}</p>}
      </div>
      <div className="dialog-actions">
        <button type="button" className="safe" onClick={onCancel}>Cancel</button>
        <div className="submit-stack">
          <button
            type="submit"
            className={consequence ? "danger-solid" : "primary"}
            aria-disabled={canSubmit ? undefined : "true"}
            aria-describedby={consequence ? `${id}-consequence` : undefined}
          >
            {submitLabel}
          </button>
          {consequence && <p id={`${id}-consequence`} className="consequence">{consequence}</p>}
        </div>
      </div>
    </form>
  </Modal>;
}

import type { StationAction, StationView, SystemSnapshot } from "@ps5-cafe/contracts";
import { formatDurationLabel, simulatingUnsupported } from "../logic.js";
import type { PendingIntent, ScopedError } from "../useCommands.js";
import { ActionButton } from "./ActionButton.js";

export const SIMULATION_SCOPE = "simulation";

interface SimulationControlsProps {
  snapshot: SystemSnapshot;
  target: StationView | undefined;
  onTargetChange: (stationId: string) => void;
  pendingFor: (scope: string) => PendingIntent | undefined;
  error: ScopedError | undefined;
  onAdvance: (control: string, durationMs: number) => void;
  onAction: (station: StationView, control: string, action: StationAction) => void;
  onRetry: (scope: string) => void;
  onDismiss: (scope: string) => void;
}

/** Fake time and TV faults. Rendered only when the server reports simulation mode; never part of the operator actions. */
export function SimulationControls(props: SimulationControlsProps) {
  const { snapshot, target, onTargetChange, pendingFor, error, onAdvance, onAction, onRetry, onDismiss } = props;
  const clockPending = pendingFor(SIMULATION_SCOPE);
  const targetPending = target ? pendingFor(target.id) : undefined;
  const unsupported = target ? simulatingUnsupported(target) : false;
  return <section className="sim-controls" aria-labelledby="sim-heading">
    <div className="sim-intro">
      <span className="eyebrow">Simulation only</span>
      <h2 id="sim-heading">Simulation controls</h2>
      <p>These controls fake time and TV faults on the mock adapters. They never contact a real TV.</p>
    </div>

    <div className="sim-group" role="group" aria-labelledby="sim-clock-label">
      <h3 id="sim-clock-label">Server clock</h3>
      <p className="sim-meta">Offset: {snapshot.acceleratedByMs > 0 ? `+${formatDurationLabel(snapshot.acceleratedByMs)}` : "none"}</p>
      <div className="sim-buttons">
        <ActionButton control="ff-5m" text="Fast-forward 5m" context="simulated clock" pending={clockPending} onActivate={() => onAdvance("ff-5m", 5 * 60_000)} />
        <ActionButton control="ff-1h" text="Fast-forward 1h" context="simulated clock" pending={clockPending} onActivate={() => onAdvance("ff-1h", 60 * 60_000)} />
      </div>
    </div>

    <div className="sim-group" role="group" aria-labelledby="sim-faults-label">
      <h3 id="sim-faults-label">TV faults</h3>
      <label className="sim-target">
        <span>Station</span>
        <select value={target?.id ?? ""} onChange={(event) => onTargetChange(event.target.value)}>
          {snapshot.stations.map((station) => <option key={station.id} value={station.id}>{station.name} ({station.connection})</option>)}
        </select>
      </label>
      {target && <div className="sim-buttons">
        <ActionButton
          control="sim-connection"
          text={target.connection === "ONLINE" ? "Disconnect TV" : "Reconnect TV"}
          context={target.name}
          pending={targetPending}
          onActivate={() => onAction(target, "sim-connection", { type: "SET_CONNECTION", connection: target.connection === "ONLINE" ? "OFFLINE" : "ONLINE" })}
        />
        <ActionButton
          control="sim-fail"
          text="Fail next command"
          context={target.name}
          pending={targetPending}
          onActivate={() => onAction(target, "sim-fail", { type: "SIMULATE_NEXT_FAILURE" })}
        />
        <ActionButton
          control="sim-unsupported"
          text={unsupported ? "Restore capabilities" : "Simulate unsupported"}
          context={target.name}
          pending={targetPending}
          onActivate={() => onAction(target, "sim-unsupported", { type: "SIMULATE_UNSUPPORTED", enabled: !unsupported })}
        />
      </div>}
      <p className="sim-meta">Fault results and errors appear on the station's card.</p>
    </div>

    {error && <div className="card-error" role="alert">
      <p><b>Simulation</b> — {error.title}: {error.message}</p>
      <div className="card-error-actions">
        {error.retry && <ActionButton control="retry" text="Retry" context={error.title} pending={clockPending} onActivate={() => onRetry(SIMULATION_SCOPE)} />}
        <button type="button" aria-label="Dismiss simulation error" onClick={() => onDismiss(SIMULATION_SCOPE)}>Dismiss</button>
      </div>
    </div>}
  </section>;
}

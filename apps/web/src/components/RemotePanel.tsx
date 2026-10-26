import { useState } from "react";
import type { RemoteKey, StationAction, StationView } from "@ps5-cafe/contracts";
import type { PendingIntent } from "../useCommands.js";
import { ActionButton } from "./ActionButton.js";
import { RemoteScreen } from "./RemoteScreen.js";

type KeyRow = { label: string; className: string; keys: { key: RemoteKey; text: string; area?: string }[] };
const NAVIGATION_KEYS: KeyRow["keys"] = [{ key: "HOME", text: "Home" }, { key: "BACK", text: "Back" }, { key: "INPUT", text: "Sources" }];
/**
 * A live display may stay "awake" when its screen is off, so a Power toggle could only turn it off: live TVs get explicit
 * Screen on / Screen off keys instead.
 */
const SYSTEM_ROW = (live: boolean): KeyRow => ({
  label: "System keys", className: "remote-row",
  keys: live ? [{ key: "WAKEUP", text: "Screen on" }, { key: "SLEEP", text: "Screen off" }, ...NAVIGATION_KEYS] : [{ key: "POWER", text: "Power" }, ...NAVIGATION_KEYS],
});
/** Laid out like a physical remote: (system keys,) a D-pad cross, volume, then menu and media keys. */
const KEY_ROWS: KeyRow[] = [
  { label: "Direction pad", className: "remote-dpad", keys: [
    { key: "UP", text: "Up", area: "up" }, { key: "LEFT", text: "Left", area: "left" }, { key: "OK", text: "OK", area: "ok" },
    { key: "RIGHT", text: "Right", area: "right" }, { key: "DOWN", text: "Down", area: "down" },
  ] },
  { label: "Volume", className: "remote-row", keys: [
    { key: "VOLUME_DOWN", text: "Volume −" }, { key: "MUTE", text: "Mute" }, { key: "VOLUME_UP", text: "Volume +" },
  ] },
  { label: "Menu and media keys", className: "remote-row", keys: [
    { key: "MENU", text: "Menu" }, { key: "SETTINGS", text: "Settings" }, { key: "PLAY", text: "Play" }, { key: "PAUSE", text: "Pause" },
  ] },
];
const HDMI_INPUTS = ["HDMI1", "HDMI2", "HDMI3", "HDMI4"] as const;

interface RemotePanelProps {
  station: StationView;
  pending: PendingIntent | undefined;
  onAction: (station: StationView, control: string, action: StationAction) => void;
}

/**
 * A full remote. On a simulated TV the keys change the mock; on a live TV they go over the owner's opt-in remote channel,
 * with a screenshot above them that refreshes after each key and can be touched.
 */
export function RemotePanel({ station, pending, onAction }: RemotePanelProps) {
  // Counts commands sent from here so the live screenshot can look again once the TV has reacted.
  const [sent, setSent] = useState(0);
  const live = station.adapterKind === "screen-only";

  // A live TV without a remote channel: say so plainly instead of showing a wall of disabled keys.
  if (live && !station.remote) {
    return <section id="remote-panel" className="remote-panel is-live" aria-labelledby="remote-heading">
      <div className="remote-info">
        <span className="eyebrow">Remote</span>
        <h2 id="remote-heading" tabIndex={-1}>{station.name}</h2>
        <p>No remote control is set up for this TV, so use its own remote. The session buttons above still change what its
          screen page shows.</p>
        <p className="unavailable-note">To control it from here, pair it in <a href="#/devices">Device Settings → Remote control</a>.</p>
      </div>
    </section>;
  }

  const send = (control: string, action: StationAction) => { onAction(station, control, action); setSent((count) => count + 1); };
  const keysUnavailable = station.capabilities.remoteKeys ? undefined : "Remote keys are not supported by this TV";
  const inputsUnavailable = station.capabilities.inputSwitching ? undefined : "Input switching is not supported by this TV";
  const inputs: { input: string; text: string }[] = [
    ...(live ? [{ input: "APP", text: "PS5 Cafe screen" }] : []),
    ...HDMI_INPUTS.map((input) => ({ input, text: input.replace("HDMI", "HDMI ") })),
  ];
  return <section id="remote-panel" className={`remote-panel${live ? " is-live" : ""}`} aria-labelledby="remote-heading">
    <div className="remote-info">
      <span className="eyebrow">Remote</span>
      <h2 id="remote-heading" tabIndex={-1}>{station.name}</h2>
      {live
        ? <p>Over Wireless debugging. Keys reach the TV, but what they did is only seen in the next screenshot. Inputs are shown by
          the TV&apos;s PS5 Cafe app.</p>
        : <p>Commands are serialized through this station&apos;s adapter queue.</p>}
      {station.simulated && <p className="sim-note">Simulated TV: these keys change the mock only.</p>}
      {(keysUnavailable || inputsUnavailable) && <p className="unavailable-note">{keysUnavailable ?? inputsUnavailable}</p>}
    </div>
    {live && <RemoteScreen station={station} pending={pending} onAction={onAction} commandsSent={sent} />}
    <div className="remote-keys">
      {[SYSTEM_ROW(live), ...KEY_ROWS].map((row) => <div key={row.label} className={row.className} role="group" aria-label={`${row.label} for ${station.name}`}>
        {row.keys.map(({ key, text, area }) => <ActionButton
          key={key}
          control={`key-${key}`}
          text={text}
          context={station.name}
          pending={pending}
          unavailable={keysUnavailable}
          className={area ? `dpad-${area}` : undefined}
          onActivate={() => send(`key-${key}`, { type: "REMOTE_KEY", key })}
        />)}
      </div>)}
    </div>
    <div className="hdmi-keys" role="group" aria-label={`Inputs for ${station.name}`}>
      {inputs.map(({ input, text }) => <ActionButton
        key={input}
        control={`input-${input}`}
        text={text}
        context={station.name}
        pending={pending}
        unavailable={inputsUnavailable}
        onActivate={() => send(`input-${input}`, { type: "SWITCH_INPUT", input })}
      />)}
    </div>
  </section>;
}

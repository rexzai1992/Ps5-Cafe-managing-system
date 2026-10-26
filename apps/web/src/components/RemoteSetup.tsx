import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { AdbDeviceList, StationView } from "@ps5-cafe/contracts";
import { errorMessageFromBody, newIdempotencyKey, REQUEST_TIMEOUT_MS, staffToken, UNREACHABLE_MESSAGE } from "../api.js";

/** Pairing takes a moment to show up in adb's device list after the TV accepts the code. */
const RELOAD_AFTER_PAIR_MS = 3_000;

async function staffRequest(url: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: unknown): Promise<{ ok: boolean; message: string; data?: unknown }> {
  try {
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${staffToken() ?? ""}`, ...(method === "GET" ? {} : { "idempotency-key": newIdempotencyKey() }), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    return response.ok ? { ok: true, message: "", data: text ? JSON.parse(text) as unknown : undefined } : { ok: false, message: errorMessageFromBody(response.status, text) };
  } catch {
    return { ok: false, message: UNREACHABLE_MESSAGE };
  }
}

/**
 * Opt-in remote control for live TVs: pair a TV's Wireless debugging with this server, then choose which TV it is.
 * Nothing is controlled until a device is assigned to a TV here.
 */
export function RemoteSetup({ stations }: { stations: readonly StationView[] }) {
  const [list, setList] = useState<AdbDeviceList | null>(null);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<{ tone: "info" | "red"; text: string } | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await staffRequest("/api/adb/devices", "GET");
    if (result.ok) setList(result.data as AdbDeviceList);
    else setMessage({ tone: "red", text: result.message });
  }, []);
  useEffect(() => { void load(); }, [load]);

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await staffRequest("/api/adb/pair", "POST", { address: address.trim(), code: code.trim() });
    setBusy(false);
    setMessage(result.ok ? { tone: "info", text: "Paired. The TV appears in the list below in a few seconds; then choose which station it is." } : { tone: "red", text: result.message });
    if (result.ok) { setCode(""); setTimeout(() => void load(), RELOAD_AFTER_PAIR_MS); }
  };
  const assign = async (station: StationView, device: string | null) => {
    setBusy(true);
    const result = device === null
      ? await staffRequest(`/api/stations/${encodeURIComponent(station.id)}/remote`, "DELETE")
      : await staffRequest(`/api/stations/${encodeURIComponent(station.id)}/remote`, "PUT", { device });
    setBusy(false);
    setMessage(result.ok ? { tone: "info", text: device ? `${station.name} is now remote-controlled.` : `${station.name}: remote control removed.` } : { tone: "red", text: result.message });
  };

  if (list && !list.available) {
    return <section className="remote-setup"><h2 className="section-heading">Remote control</h2>
      <p className="muted">This computer has no Android Debug Bridge (adb), so TVs cannot be remote-controlled from here.</p></section>;
  }
  const devices = list?.devices ?? [];
  const live = stations.filter((station) => station.adapterKind === "screen-only");
  return <section className="remote-setup" aria-labelledby="remote-setup-heading">
    <h2 id="remote-setup-heading" className="section-heading">Remote control</h2>
    <p className="muted">Optional, per TV. On the TV: Settings → Developer options → <b>Wireless debugging</b> on → <b>Pair device with
      pairing code</b>, then type what it shows here. Keep TVs on a staff-only network and turn Wireless debugging off on a TV you stop
      controlling. This is remote control, not a lock.</p>
    <form className="pair-form" onSubmit={pair}>
      <label><span>IP address and port</span>
        <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="192.168.100.170:35285" inputMode="decimal" autoComplete="off" /></label>
      <label><span>Pairing code</span>
        <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="6 digits" inputMode="numeric" maxLength={6} autoComplete="off" /></label>
      <button type="submit" className="primary" disabled={busy}>Pair</button>
    </form>
    {message && <p className={`banner tone-${message.tone} page-banner`} role={message.tone === "red" ? "alert" : "status"}><span>{message.text}</span></p>}
    <ul className="remote-assign-list" aria-label="Which device controls each TV">
      {live.map((station) => {
        const current = station.remote?.device ?? "";
        const selected = choice[station.id] ?? current;
        const online = devices.find((device) => device.serial === current)?.connected;
        return <li key={station.id} className="remote-assign">
          <b>{station.name}</b>
          <span className={current ? (online ? "conn-online" : "muted") : "muted"}>
            {current ? (online ? "● Remote connected" : "Remote set up · not reachable now") : "No remote control"}
          </span>
          <select aria-label={`Device for ${station.name}`} value={selected} onChange={(event) => setChoice({ ...choice, [station.id]: event.target.value })}>
            <option value="">Choose a device…</option>
            {devices.map((device) => <option key={device.serial} value={device.serial}>
              {device.address ?? device.serial}{device.connected ? "" : " (paired? not connected)"}
            </option>)}
            {current && !devices.some((device) => device.serial === current) && <option value={current}>{current}</option>}
          </select>
          <button type="button" disabled={busy || !selected || selected === current} onClick={() => void assign(station, selected)}>Use</button>
          {current && <button type="button" className="danger" disabled={busy} onClick={() => void assign(station, null)}>Remove</button>}
        </li>;
      })}
    </ul>
    <button type="button" onClick={() => void load()} disabled={busy}>Refresh device list</button>
  </section>;
}

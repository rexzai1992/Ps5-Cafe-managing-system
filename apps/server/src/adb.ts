import { execFile } from "node:child_process";
import type { AdbDevice, RemoteKey } from "@ps5-cafe/contracts";

/** Android key codes (android.view.KeyEvent) for the dashboard's remote keys: documented platform constants. */
export const ANDROID_KEYCODES: Readonly<Record<RemoteKey, number>> = {
  POWER: 26, HOME: 3, BACK: 4, UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22, OK: 23,
  VOLUME_UP: 24, VOLUME_DOWN: 25, MUTE: 164, INPUT: 178, PLAY: 126, PAUSE: 127, MENU: 82, SETTINGS: 176,
  WAKEUP: 224, SLEEP: 223,
};
/** ADB serials: host:port, or a wireless-debugging mDNS name such as adb-XXXX._adb-tls-connect._tcp. */
export const ADB_SERIAL = /^[A-Za-z0-9._:@-]{1,128}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SIZE_CACHE_MS = 60_000;
const COMPANION_ACTIVITY = "com.ps5cafe.tvcompanion/.MainActivity";
const PAIR_ADDRESS = /^(\d{1,3}\.){3}\d{1,3}:\d{2,5}$/;

/** Input from the dashboard that adb was never given (bad address or code). */
export class AdbInputError extends Error {}

/** Runs the adb tool with an argument list (never through a shell) and returns stdout. */
export type AdbRun = (args: readonly string[]) => Promise<Buffer>;

export function execAdb(binary: string, timeoutMs = 8_000): AdbRun {
  return (args) => new Promise((resolve, reject) => {
    execFile(binary, [...args], { timeout: timeoutMs, maxBuffer: 48 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr.toString().trim() || error.message).slice(0, 200)));
      else resolve(stdout);
    });
  });
}

/**
 * The server's side of Android Debug Bridge, limited to documented platform tools: `input keyevent`, `input tap`,
 * `wm size` and `screencap`. ADB itself is a debugging interface authorised on the TV; it is not a lock.
 */
export class Adb {
  private readonly sizes = new Map<string, { at: number; width: number; height: number }>();
  /** Last address seen for each wireless-debugging service: TVs stop announcing themselves now and then. */
  private readonly known = new Map<string, string>();
  /** Device serial number (ro.serialno) behind each address-style connection, read once. */
  private readonly serialNumbers = new Map<string, string>();
  /** Called when a service turns up at a new address, so the owner of the setting can keep it. */
  public onAddress: ((device: string, address: string) => void) | null = null;

  /** The last address seen for a device, if any. */
  lastAddress(device: string): string | null { return this.known.get(device) ?? null; }

  /** Whether a device can be used right now without connecting anew, and at which address. */
  async status(device: string): Promise<{ connected: boolean; address: string | null }> {
    const connected = await this.connected();
    if (connected.includes(device)) return { connected: true, address: this.known.get(device) ?? null };
    const address = (await this.announced()).find((service) => service.serial === device)?.address
      ?? await this.matchConnected(device, connected) ?? this.known.get(device) ?? null;
    return { connected: address !== null && connected.includes(address), address };
  }

  /** Seeds the last known address of a device (from storage, after a restart). */
  remember(device: string, address: string | null): void {
    if (address && ADB_SERIAL.test(address)) this.known.set(device, address);
  }

  public constructor(private readonly run: AdbRun, private readonly now: () => number = Date.now) {}

  /**
   * Connected devices plus wireless-debugging services announced on the LAN (which may still need pairing). An announced
   * TV is listed by its service name, which stays the same when its port changes; it counts as connected whether adb
   * holds it under that name or under its current address.
   */
  async devices(): Promise<AdbDevice[]> {
    const connected = await this.connected();
    const list = new Map<string, AdbDevice>();
    await this.announced(); // refreshes `known`
    for (const [serial, address] of this.known) {
      list.set(serial, { serial, address, connected: connected.includes(serial) || connected.includes(address) });
    }
    const covered = new Set([...list.values()].flatMap((device) => [device.serial, device.address]));
    for (const serial of connected) if (!covered.has(serial)) list.set(serial, { serial, address: null, connected: true });
    return [...list.values()];
  }

  private async connected(): Promise<string[]> {
    return (await this.run(["devices"])).toString().split("\n").slice(1)
      .map((line) => line.trim().split(/\s+/)).filter(([serial, state]) => serial && state === "device").map(([serial]) => serial!);
  }

  private async announced(): Promise<{ serial: string; address: string }[]> {
    let services: { serial: string; address: string }[] = [];
    try {
      services = (await this.run(["mdns", "services"])).toString().split("\n")
        .map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 3 && parts[1] === "_adb-tls-connect._tcp")
        .map(([name, type, address]) => ({ serial: `${name}.${type}`, address: address! }));
    } catch { /* older adb without mDNS: connected devices only */ }
    for (const { serial, address } of services) {
      if (this.known.get(serial) !== address && ADB_SERIAL.test(address)) { this.known.set(serial, address); this.onAddress?.(serial, address); }
    }
    return services;
  }

  /**
   * The serial adb can use right now for a stored device, reconnecting if the link dropped (TVs drop idle wireless
   * debugging connections, and their port changes when debugging restarts).
   */
  private async reach(device: string): Promise<string> {
    checkSerial(device);
    const connected = await this.connected();
    if (connected.includes(device)) return device;
    // The announced address if the TV is announcing itself right now, else a connection to the same TV (matched by serial
    // number), else the last address seen.
    const address = device.endsWith("._adb-tls-connect._tcp")
      ? (await this.announced()).find((service) => service.serial === device)?.address
        ?? await this.matchConnected(device, connected) ?? this.known.get(device)
      : device;
    if (!address) throw new Error("This TV has not been seen yet. Check that it is on and Wireless debugging is enabled.");
    if (connected.includes(address)) return address;
    const output = (await this.run(["connect", checkSerial(address)])).toString();
    if (!/connected to/i.test(output)) {
      throw new Error(`The TV did not answer at ${address}. Check that it is on and Wireless debugging is still enabled (its port changes when it restarts).`);
    }
    return address;
  }

  /**
   * Pairs with a TV showing Settings → Developer options → Wireless debugging → "Pair device with pairing code".
   * The code only works while that screen is open on the TV, so only someone at the TV can pair it.
   */
  async pair(address: unknown, code: unknown): Promise<void> {
    if (typeof address !== "string" || !PAIR_ADDRESS.test(address)) throw new AdbInputError("Enter the IP address and port shown on the TV, like 192.168.1.20:37011.");
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw new AdbInputError("Enter the 6-digit code shown on the TV.");
    const output = (await this.run(["pair", address, code])).toString();
    if (!/Successfully paired/i.test(output)) throw new Error(output.trim().slice(0, 200) || "Pairing failed");
  }

  /**
   * A wireless-debugging name is "adb-<serial number>-<suffix>"; an address-style connection to the same TV reports that
   * serial number. Lets a TV that stopped announcing itself be found among the connections.
   */
  private async matchConnected(device: string, connected: readonly string[]): Promise<string | null> {
    const wanted = /^adb-([A-Za-z0-9]+)-/.exec(device)?.[1];
    if (!wanted) return null;
    for (const serial of connected) {
      if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(serial)) continue;
      let number = this.serialNumbers.get(serial);
      if (number === undefined) {
        try { number = (await this.run(["-s", serial, "shell", "getprop", "ro.serialno"])).toString().trim(); } catch { number = ""; }
        this.serialNumbers.set(serial, number);
      }
      if (number === wanted) {
        if (this.known.get(device) !== serial) { this.known.set(device, serial); this.onAddress?.(device, serial); }
        return serial;
      }
    }
    return null;
  }

  async key(device: string, key: RemoteKey): Promise<void> {
    await this.run(["-s", await this.reach(device), "shell", "input", "keyevent", String(ANDROID_KEYCODES[key])]);
  }

  /**
   * Asks the PS5 Cafe companion app to show an input itself (Android's `am start` with an intent extra; the app tunes the
   * HDMI input through the TV Input Framework, or returns to its screen page for APP).
   */
  async showInput(device: string, input: string): Promise<void> {
    if (!/^(HDMI[1-4]|APP)$/.test(input)) throw new Error("Not a known input");
    await this.run(["-s", await this.reach(device), "shell", "am", "start", "-n", COMPANION_ACTIVITY, "--es", "show_input", input]);
  }

  /** A tap at fractions (0-1) of the screen, converted to the TV's own pixels. */
  async tap(device: string, x: number, y: number): Promise<void> {
    const serial = await this.reach(device);
    const { width, height } = await this.size(serial);
    const px = Math.min(width - 1, Math.max(0, Math.round(x * width)));
    const py = Math.min(height - 1, Math.max(0, Math.round(y * height)));
    await this.run(["-s", serial, "shell", "input", "tap", String(px), String(py)]);
  }

  /** One PNG of what Android draws. TVs usually show HDMI on a video layer that the capture leaves black. */
  async screenshot(device: string): Promise<Buffer> {
    const png = await this.run(["-s", await this.reach(device), "exec-out", "screencap", "-p"]);
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("The TV did not return a screenshot");
    return png;
  }

  private async size(serial: string): Promise<{ width: number; height: number }> {
    const cached = this.sizes.get(serial);
    if (cached && this.now() - cached.at < SIZE_CACHE_MS) return cached;
    const output = (await this.run(["-s", serial, "shell", "wm", "size"])).toString();
    // "Override size" wins over "Physical size" when both are present.
    const match = /Override size: (\d+)x(\d+)/.exec(output) ?? /Physical size: (\d+)x(\d+)/.exec(output);
    if (!match) throw new Error("Could not read the TV's screen size");
    const size = { at: this.now(), width: Number(match[1]), height: Number(match[2]) };
    this.sizes.set(serial, size);
    return size;
  }
}

function checkSerial(serial: string): string {
  if (!ADB_SERIAL.test(serial)) throw new Error("Not a valid ADB device name");
  return serial;
}

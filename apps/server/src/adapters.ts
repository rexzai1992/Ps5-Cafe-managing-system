import { randomUUID } from "node:crypto";
import type {
  AdapterKind, CommandResult, ConnectionState, DeviceCapabilities, DeviceState, RemoteKey,
} from "@ps5-cafe/contracts";
import type { Clock } from "./clock.js";

const allMockCapabilities: DeviceCapabilities = {
  power: true,
  volume: true,
  mute: true,
  remoteKeys: true,
  inputSwitching: true,
  applicationLaunch: true,
  advertisingPlayback: true,
  stateVerification: true,
  secureDisplayBlocking: false,
};

const unverifiedCapabilities: DeviceCapabilities = {
  power: false,
  volume: false,
  mute: false,
  remoteKeys: false,
  inputSwitching: false,
  applicationLaunch: false,
  advertisingPlayback: false,
  stateVerification: false,
  secureDisplayBlocking: false,
};

/** The screen page shows ads; nothing else about the TV can be controlled or read. */
const screenOnlyCapabilities: DeviceCapabilities = { ...unverifiedCapabilities, advertisingPlayback: true };

/** Remote control of one TV over a channel the owner set up (today: ADB with wireless debugging). */
export interface RemoteControl {
  key(key: RemoteKey): Promise<void>;
  /** A touch at fractions (0-1) of the screen. */
  tap(x: number, y: number): Promise<void>;
  /** Asks the TV's companion app to show an input itself: HDMI1-HDMI4, or APP for its screen page. */
  showInput(input: string): Promise<void>;
}

export interface TvAdapter {
  readonly kind: AdapterKind;
  connect(): Promise<CommandResult>;
  disconnect(): Promise<CommandResult>;
  getCapabilities(): DeviceCapabilities;
  getDeviceStatus(): Promise<DeviceState>;
  powerOn(): Promise<CommandResult>;
  powerOff(): Promise<CommandResult>;
  setVolume(volume: number): Promise<CommandResult>;
  mute(): Promise<CommandResult>;
  sendRemoteKey(key: RemoteKey): Promise<CommandResult>;
  tap(x: number, y: number): Promise<CommandResult>;
  switchInput(input: string): Promise<CommandResult>;
  launchApp(appId: string): Promise<CommandResult>;
  enterIdleMode(): Promise<CommandResult>;
  enterGamingMode(input: string): Promise<CommandResult>;
  enterExpiredMode(): Promise<CommandResult>;
}

abstract class BaseAdapter implements TvAdapter {
  public abstract readonly kind: AdapterKind;
  public constructor(protected readonly clock: Clock) {}
  protected result(outcome: CommandResult["outcome"], message: string, verified = false): CommandResult {
    return { commandId: randomUUID(), outcome, message, verified, completedAt: this.clock.now() };
  }
  abstract getCapabilities(): DeviceCapabilities;
  abstract getDeviceStatus(): Promise<DeviceState>;
  async connect(): Promise<CommandResult> { return this.result("UNSUPPORTED", "Adapter is not configured"); }
  /** An unverified adapter has nothing to disconnect from, so it must not claim a verified success. */
  async disconnect(): Promise<CommandResult> { return this.result("UNSUPPORTED", "Disconnect is unsupported"); }
  async powerOn(): Promise<CommandResult> { return this.result("UNSUPPORTED", "Power on is unsupported"); }
  async powerOff(): Promise<CommandResult> { return this.result("UNSUPPORTED", "Power off is unsupported"); }
  async setVolume(_volume: number): Promise<CommandResult> { return this.result("UNSUPPORTED", "Volume control is unsupported"); }
  async mute(): Promise<CommandResult> { return this.result("UNSUPPORTED", "Mute is unsupported"); }
  async sendRemoteKey(_key: RemoteKey): Promise<CommandResult> { return this.result("UNSUPPORTED", "Remote keys are unsupported"); }
  async tap(_x: number, _y: number): Promise<CommandResult> { return this.result("UNSUPPORTED", "Touch is unsupported"); }
  async switchInput(_input: string): Promise<CommandResult> { return this.result("UNSUPPORTED", "Input switching is unsupported"); }
  async launchApp(_appId: string): Promise<CommandResult> { return this.result("UNSUPPORTED", "Application launch is unsupported"); }
  async enterIdleMode(): Promise<CommandResult> { return this.result("UNSUPPORTED", "Idle mode is unsupported"); }
  async enterGamingMode(_input: string): Promise<CommandResult> { return this.result("UNSUPPORTED", "Gaming mode is unsupported"); }
  async enterExpiredMode(): Promise<CommandResult> { return this.result("UNSUPPORTED", "Expired mode is unsupported"); }
}

export class MockTvAdapter extends BaseAdapter {
  public readonly kind = "mock" as const;
  private connection: ConnectionState = "ONLINE";
  private failNext = false;
  private unsupported = false;

  public constructor(clock: Clock, private readonly state: DeviceState) { super(clock); }
  getCapabilities(): DeviceCapabilities { return this.unsupported ? unverifiedCapabilities : allMockCapabilities; }
  async getDeviceStatus(): Promise<DeviceState> { return { ...this.state }; }
  setConnection(value: ConnectionState): void { this.connection = value; }
  simulateNextFailure(): void { this.failNext = true; }
  simulateUnsupported(value: boolean): void { this.unsupported = value; }

  private guard(action: string): CommandResult | null {
    if (this.connection !== "ONLINE") return this.result("DEVICE_OFFLINE", `Cannot ${action}: simulated TV is offline`);
    if (this.failNext) {
      this.failNext = false;
      return this.result("FAILURE", `Simulated failure while attempting to ${action}`);
    }
    if (this.unsupported) return this.result("UNSUPPORTED", `${action} is simulated as unsupported`);
    return null;
  }

  override async connect(): Promise<CommandResult> { this.connection = "ONLINE"; return this.result("SUCCESS", "Simulated TV connected", true); }
  override async disconnect(): Promise<CommandResult> { this.connection = "OFFLINE"; return this.result("SUCCESS", "Simulated TV disconnected", true); }
  override async powerOn(): Promise<CommandResult> { const g = this.guard("power on"); if (g) return g; this.state.power = true; return this.result("SUCCESS", "Power on", true); }
  override async powerOff(): Promise<CommandResult> { const g = this.guard("power off"); if (g) return g; this.state.power = false; return this.result("SUCCESS", "Power off", true); }
  override async setVolume(volume: number): Promise<CommandResult> { const g = this.guard("set volume"); if (g) return g; this.state.volume = Math.max(0, Math.min(100, volume)); return this.result("SUCCESS", `Volume ${this.state.volume}`, true); }
  override async mute(): Promise<CommandResult> { const g = this.guard("toggle mute"); if (g) return g; this.state.muted = !this.state.muted; return this.result("SUCCESS", this.state.muted ? "Muted" : "Unmuted", true); }
  override async sendRemoteKey(key: RemoteKey): Promise<CommandResult> {
    if (key === "VOLUME_UP") return this.setVolume(this.state.volume + 1);
    if (key === "VOLUME_DOWN") return this.setVolume(this.state.volume - 1);
    if (key === "MUTE") return this.mute();
    if (key === "POWER") return this.state.power ? this.powerOff() : this.powerOn();
    const g = this.guard(`send ${key}`); return g ?? this.result("SUCCESS", `${key} accepted`, true);
  }
  /**
   * Switching to an HDMI input shows the console, whatever screen was up before. This models the remote-button bypass
   * of a software-only expired screen: the server must notice it on readback instead of still reporting CONFIRMED.
   */
  override async switchInput(input: string): Promise<CommandResult> {
    const g = this.guard("switch input"); if (g) return g;
    this.state.input = input;
    if (/^HDMI\d+$/.test(input)) this.state.displayedMode = "PLAYING";
    else if (input === "APP") this.state.displayedMode = "IDLE";
    return this.result("SUCCESS", `Input changed to ${input}`, true);
  }
  override async launchApp(appId: string): Promise<CommandResult> { const g = this.guard("launch application"); if (g) return g; this.state.input = `APP:${appId}`; return this.result("SUCCESS", `Launched ${appId}`, true); }
  override async enterIdleMode(): Promise<CommandResult> { const g = this.guard("enter idle mode"); if (g) return g; this.state.displayedMode = "IDLE"; this.state.input = "APP:advertising"; return this.result("SUCCESS", "Advertising screen verified", true); }
  override async enterGamingMode(input: string): Promise<CommandResult> { const g = this.guard("enter gaming mode"); if (g) return g; this.state.displayedMode = "PLAYING"; this.state.input = input; return this.result("SUCCESS", `Gaming input ${input} verified`, true); }
  override async enterExpiredMode(): Promise<CommandResult> { const g = this.guard("enter expired mode"); if (g) return g; this.state.displayedMode = "EXPIRED"; this.state.input = "APP:expired"; return this.result("SUCCESS", "Expired screen verified; software-only block", true); }
}

/**
 * Live mode until a real adapter passes the physical test: the TV shows its screen page (browser or companion app) and
 * follows the server by polling. Nothing is ever sent to the TV, so no mode change can be verified from here.
 */
export class ScreenOnlyAdapter extends BaseAdapter {
  public readonly kind = "screen-only";
  /** `remote` is the owner's opt-in remote control for this TV, if one is set up; it can change while running. */
  public constructor(clock: Clock, private readonly remote: () => RemoteControl | null = () => null) { super(clock); }
  getCapabilities(): DeviceCapabilities {
    return this.remote() ? { ...screenOnlyCapabilities, remoteKeys: true, inputSwitching: true } : screenOnlyCapabilities;
  }
  override async switchInput(input: string): Promise<CommandResult> {
    const remote = this.remote();
    if (!remote) return this.result("UNSUPPORTED", "No remote control is set up for this TV");
    await remote.showInput(input);
    const shown = input === "APP" ? "its screen page" : input.replace("HDMI", "HDMI ");
    return this.result("UNVERIFIED", `Asked the TV's app to show ${shown}; check the next screenshot`);
  }
  /** Keys and touches are delivered, but what they did on the TV cannot be read back: never SUCCESS. */
  override async sendRemoteKey(key: RemoteKey): Promise<CommandResult> {
    const remote = this.remote();
    if (!remote) return this.result("UNSUPPORTED", "No remote control is set up for this TV");
    await remote.key(key);
    return this.result("UNVERIFIED", `Sent ${key} to the TV; its effect is not read back`);
  }
  override async tap(x: number, y: number): Promise<CommandResult> {
    const remote = this.remote();
    if (!remote) return this.result("UNSUPPORTED", "No remote control is set up for this TV");
    await remote.tap(x, y);
    return this.result("UNVERIFIED", `Touched the TV screen at ${Math.round(x * 100)}%, ${Math.round(y * 100)}%; its effect is not read back`);
  }
  async getDeviceStatus(): Promise<DeviceState> { throw new Error("A screen-only TV does not report its state"); }
  override async enterIdleMode(): Promise<CommandResult> {
    return this.result("UNVERIFIED", "The TV's screen page shows ads and its QR code while it is open; the TV itself is not controlled");
  }
  override async enterGamingMode(input: string): Promise<CommandResult> {
    return this.result("UNVERIFIED", `Switch the TV to the PS5 (${input}) with its remote; the TV itself is not controlled`);
  }
  override async enterExpiredMode(): Promise<CommandResult> {
    return this.result("UNVERIFIED", "The TV's screen page shows Time expired while it is open; the TV itself is not controlled");
  }
}

export class UnverifiedTvAdapter extends BaseAdapter {
  public constructor(public readonly kind: Exclude<AdapterKind, "mock" | "screen-only">, clock: Clock) { super(clock); }
  getCapabilities(): DeviceCapabilities { return unverifiedCapabilities; }
  async getDeviceStatus(): Promise<DeviceState> { throw new Error(`${this.kind} requires physical device verification`); }
}


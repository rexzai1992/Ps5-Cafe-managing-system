export const TV_MODES = ["IDLE", "PLAYING", "EXPIRED"] as const;
export type TvMode = (typeof TV_MODES)[number];

export const SESSION_STATUSES = ["NONE", "ACTIVE", "PAUSED", "EXPIRED", "ENDED"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type ConnectionState = "ONLINE" | "OFFLINE" | "CONNECTING";
export type BlockingStatus = "NOT_APPLICABLE" | "PENDING" | "CONFIRMED" | "FAILED" | "UNVERIFIED";
/**
 * `screen-only` (live mode): the TV only runs its screen page in a browser or the companion app. The server sends the TV
 * nothing; what it knows comes from the page's own polls.
 */
export type AdapterKind = "mock" | "screen-only" | "android-tv" | "google-tv" | "samsung-tizen" | "generic-remote" | "hdmi-hardware";
export type CommandOutcome = "SUCCESS" | "FAILURE" | "UNSUPPORTED" | "TIMEOUT" | "UNVERIFIED" | "DEVICE_OFFLINE";

export type RemoteKey =
  | "POWER" | "HOME" | "BACK" | "UP" | "DOWN" | "LEFT" | "RIGHT" | "OK"
  | "VOLUME_UP" | "VOLUME_DOWN" | "MUTE" | "INPUT" | "PLAY" | "PAUSE" | "MENU" | "SETTINGS"
  /** Explicit screen on/off: some displays keep Android awake when "off", so POWER can only ever turn them off. */
  | "WAKEUP" | "SLEEP";

export interface DeviceCapabilities {
  power: boolean;
  volume: boolean;
  mute: boolean;
  remoteKeys: boolean;
  inputSwitching: boolean;
  applicationLaunch: boolean;
  advertisingPlayback: boolean;
  stateVerification: boolean;
  secureDisplayBlocking: boolean;
}

export interface DeviceState {
  power: boolean;
  volume: number;
  muted: boolean;
  input: string;
  displayedMode: TvMode;
}

export interface SessionView {
  status: SessionStatus;
  startedAt: number | null;
  deadlineAt: number | null;
  pausedRemainingMs: number | null;
  remainingMs: number;
}

export interface StationView {
  id: string;
  number: number;
  name: string;
  adapterKind: AdapterKind;
  simulated: boolean;
  connection: ConnectionState;
  mode: TvMode;
  blockingStatus: BlockingStatus;
  hdmiInput: string;
  capabilities: DeviceCapabilities;
  deviceState: DeviceState;
  session: SessionView;
  lastCommand: CommandResult | null;
  /** The station's open QR reservation (staff-only view; includes the phone number). Absent on older servers. */
  reservation?: ReservationView | null;
  /** When the TV's screen page last polled the server (epoch ms), or null if never. */
  screenSeenAt?: number | null;
  /** The ADB device that remote-controls this TV (opt-in, set in Device Settings), or null. Absent on older servers. */
  remote?: { device: string } | null;
  /**
   * The TV's screen page is open and polling right now (it checked in within the last 15 s). This is the only signal
   * that comes from the real TV while adapters are simulated. Absent on older servers.
   */
  screenOnline?: boolean;
}

export interface CommandResult {
  commandId: string;
  outcome: CommandOutcome;
  message: string;
  verified: boolean;
  completedAt: number;
}

export type StationAction =
  | { type: "START"; durationMs: number }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "ADD_TIME"; durationMs: number }
  | { type: "SET_REMAINING"; durationMs: number }
  | { type: "END" }
  | { type: "LOCK" }
  | { type: "SHOW_ADVERTISING" }
  | { type: "SWITCH_INPUT"; input: string }
  | { type: "REMOTE_KEY"; key: RemoteKey }
  /** A touch at a point on the TV's screen, as fractions (0-1) of its width and height. Remote-controlled TVs only. */
  | { type: "REMOTE_TAP"; x: number; y: number }
  | { type: "SET_CONNECTION"; connection: ConnectionState }
  | { type: "SIMULATE_NEXT_FAILURE" }
  | { type: "SIMULATE_UNSUPPORTED"; enabled: boolean };

export interface SystemSnapshot {
  serverTime: number;
  simulationMode: boolean;
  acceleratedByMs: number;
  stations: StationView[];
}


// --- QR reservations -------------------------------------------------------------------------------------------------

/** HELD: TV held for the customer until holdUntil. STARTED: staff started the session. The rest are final. */
export const RESERVATION_STATUSES = ["HELD", "STARTED", "COMPLETED", "RELEASED", "EXPIRED", "CANCELLED"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Staff view of an open reservation. `phone` is removed from storage as soon as the reservation closes. */
export interface ReservationView {
  id: string;
  /** Short code the customer shows at the counter, e.g. "K7Q2P9". */
  ref: string;
  status: ReservationStatus;
  durationMs: number;
  createdAt: number;
  holdUntil: number;
  /** E.164, e.g. "+60123456789". */
  phone: string | null;
}

/** Shown on the customer's phone after scanning a TV's QR code. No other customer's data is ever included. */
export interface PublicBookingInfo {
  station: { id: string; name: string };
  available: boolean;
  /** Why the TV cannot be reserved right now, in plain words. */
  reason: string | null;
  durationsMs: number[];
  holdMs: number;
  serverTime: number;
}

export interface PublicReservation {
  id: string;
  ref: string;
  status: ReservationStatus;
  station: { id: string; name: string };
  durationMs: number;
  holdUntil: number;
  serverTime: number;
  /** Present once staff have started the booked session, so the phone can show time left. */
  session?: { status: SessionStatus; remainingMs: number } | null;
}

/** Created once; the token lets only this phone check or cancel the reservation. */
export interface ReservationCreated extends PublicReservation { token: string }

/** What a TV's own screen page needs. Fetched with that TV's screen key. */
export interface ScreenView {
  station: { id: string; name: string; number: number };
  serverTime: number;
  mode: TvMode;
  sessionStatus: SessionStatus;
  remainingMs: number;
  reservation: { ref: string; status: ReservationStatus; durationMs: number; holdUntil: number; phoneLast4: string | null } | null;
  /** Present only while the TV can be booked. The code rotates; old codes stop working. */
  qr: { code: string; rotatesAt: number } | null;
  /** The advertising playlist an idle TV plays, in order. Absent on older servers. */
  ads?: AdItem[];
  /** Origin the QR code should send phones to (the server's current LAN address). Absent on older servers. */
  bookingOrigin?: string;
}

/** An Android device the server's ADB can reach: connected now, or announced on the LAN (wireless debugging). */
export interface AdbDevice { serial: string; address: string | null; connected: boolean }
/** `available` is false when the server has no ADB tool; remote control is then unavailable. */
export interface AdbDeviceList { available: boolean; devices: AdbDevice[] }

export type MediaKind = "image" | "video";
/** One advertising file in the media library. `name` is the server's safe file name. */
export interface MediaItem { name: string; kind: MediaKind; mime: string; bytes: number; addedAt: number }
export interface MediaList { items: MediaItem[]; maxBytes: number }
/** What a TV screen plays: a public URL under /media/. */
export interface AdItem { url: string; kind: MediaKind }

export interface ScreenLink { stationId: string; name: string; key: string; seenAt: number | null }
/** `hostName`: the server computer's `.local` name, which TV links prefer because it survives address changes. */
export interface ScreenLinks { screens: ScreenLink[]; lanAddresses: string[]; hostName?: string | null }

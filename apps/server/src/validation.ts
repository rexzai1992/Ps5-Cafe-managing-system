import type { ConnectionState, RemoteKey, StationAction } from "@ps5-cafe/contracts";

/** The request body or headers are malformed. */
export class RequestValidationError extends Error {}

const REMOTE_KEYS: readonly RemoteKey[] = [
  "POWER", "HOME", "BACK", "UP", "DOWN", "LEFT", "RIGHT", "OK",
  "VOLUME_UP", "VOLUME_DOWN", "MUTE", "INPUT", "PLAY", "PAUSE", "MENU", "SETTINGS", "WAKEUP", "SLEEP",
];
/** CONNECTING is a state the server observes, not one an operator can request. */
const REQUESTABLE_CONNECTION_STATES: readonly ConnectionState[] = ["ONLINE", "OFFLINE"];
/** HDMI1-HDMI4, or APP: the TV's own screen page (live TVs show it through the companion app). */
const INPUT_PATTERN = /^(HDMI[1-4]|APP)$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

function record(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RequestValidationError("Body must be a JSON object");
  return body as Record<string, unknown>;
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new RequestValidationError(`Unexpected field(s): ${extra.join(", ")}`);
}

/** Durations are whole milliseconds; fractions such as 1.5 or 1e-300 are malformed, not rounded. */
function duration(body: Record<string, unknown>): number {
  const value = body.durationMs;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new RequestValidationError("durationMs must be a whole number of milliseconds");
  return value;
}

/** Strictly parses a station action. Range checks stay in the domain layer. */
export function parseStationAction(input: unknown): StationAction {
  const body = record(input);
  switch (body.type) {
    case "START":
    case "ADD_TIME":
    case "SET_REMAINING":
      onlyKeys(body, ["type", "durationMs"]);
      return { type: body.type, durationMs: duration(body) };
    case "PAUSE":
    case "RESUME":
    case "END":
    case "LOCK":
    case "SHOW_ADVERTISING":
    case "SIMULATE_NEXT_FAILURE":
      onlyKeys(body, ["type"]);
      return { type: body.type };
    case "SWITCH_INPUT":
      onlyKeys(body, ["type", "input"]);
      if (typeof body.input !== "string" || !INPUT_PATTERN.test(body.input)) throw new RequestValidationError("input must be HDMI1-HDMI4 or APP");
      return { type: "SWITCH_INPUT", input: body.input };
    case "REMOTE_KEY":
      onlyKeys(body, ["type", "key"]);
      if (!REMOTE_KEYS.includes(body.key as RemoteKey)) throw new RequestValidationError("key is not a supported remote key");
      return { type: "REMOTE_KEY", key: body.key as RemoteKey };
    case "REMOTE_TAP": {
      onlyKeys(body, ["type", "x", "y"]);
      const inside = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
      if (!inside(body.x) || !inside(body.y)) throw new RequestValidationError("x and y must be fractions of the screen from 0 to 1");
      return { type: "REMOTE_TAP", x: body.x as number, y: body.y as number };
    }
    case "SET_CONNECTION":
      onlyKeys(body, ["type", "connection"]);
      if (!REQUESTABLE_CONNECTION_STATES.includes(body.connection as ConnectionState)) throw new RequestValidationError("connection must be ONLINE or OFFLINE");
      return { type: "SET_CONNECTION", connection: body.connection as ConnectionState };
    case "SIMULATE_UNSUPPORTED":
      onlyKeys(body, ["type", "enabled"]);
      if (typeof body.enabled !== "boolean") throw new RequestValidationError("enabled must be a boolean");
      return { type: "SIMULATE_UNSUPPORTED", enabled: body.enabled };
    default:
      throw new RequestValidationError("Unknown action type");
  }
}

export function parseAdvanceRequest(input: unknown): { durationMs: number } {
  const body = record(input);
  onlyKeys(body, ["durationMs"]);
  return { durationMs: duration(body) };
}

export function parseIdempotencyKey(header: string | string[] | undefined): string {
  if (header === undefined) throw new RequestValidationError("Idempotency-Key header is required for mutating requests");
  if (Array.isArray(header) || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new RequestValidationError("Idempotency-Key must be 8-128 characters of letters, digits, '_', '.', ':' or '-'");
  }
  return header;
}

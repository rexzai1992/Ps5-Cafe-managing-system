// HTTP request layer for operator commands. Pure helpers are exported for unit tests (api.test.ts).

const TOKEN_STORAGE_KEY = "ps5cafe.staffToken";

/**
 * The staff access token. It is entered once per staff device and kept in that browser, never compiled into the app:
 * customers' phones load this same bundle for the QR booking page. Development builds fall back to the local dev
 * token so `npm run dev` needs no setup; production builds contain no token at all.
 */
export function staffToken(): string | null {
  try {
    const stored = globalThis.localStorage?.getItem(TOKEN_STORAGE_KEY);
    if (stored) return stored;
  } catch { /* storage blocked (private mode): fall through */ }
  return import.meta.env.DEV ? (import.meta.env.VITE_API_TOKEN ?? "local-dev-token") : null;
}

export function setStaffToken(token: string | null): void {
  try {
    if (token) globalThis.localStorage?.setItem(TOKEN_STORAGE_KEY, token);
    else globalThis.localStorage?.removeItem(TOKEN_STORAGE_KEY);
  } catch { /* storage blocked: the token lasts for this page only */ }
}

export const isDevelopmentToken = (token: string | null) => token === "local-dev-token";
export const REQUEST_TIMEOUT_MS = 15_000;
export const UNREACHABLE_MESSAGE = "Cannot reach the management server";

/** Mirrors the server's accepted Idempotency-Key format (apps/server/src/validation.ts). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

/** randomUUID needs a secure context; LAN dashboards are often served over plain http, so fall back to getRandomValues. */
export function newIdempotencyKey(cryptoImpl: CryptoLike = globalThis.crypto): string {
  if (typeof cryptoImpl.randomUUID === "function") return cryptoImpl.randomUUID();
  return Array.from(cryptoImpl.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * One request per operator intent. The key is created once, here, and a retry resends this same object,
 * so the server replays the stored outcome instead of executing the command twice.
 */
export interface CommandRequest {
  readonly url: string;
  readonly body: unknown;
  readonly key: string;
}

export function createCommandRequest(url: string, body: unknown, key: string = newIdempotencyKey()): CommandRequest {
  return { url, body, key };
}

export function stationActionUrl(stationId: string): string {
  return `/api/stations/${encodeURIComponent(stationId)}/actions`;
}

export const SIMULATION_ADVANCE_URL = "/api/simulation/advance";

export function releaseReservationUrl(stationId: string): string {
  return `/api/stations/${encodeURIComponent(stationId)}/reservation/release`;
}

export function commandInit(request: CommandRequest, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${staffToken() ?? ""}`,
      "idempotency-key": request.key,
    },
    body: JSON.stringify(request.body),
    ...(signal ? { signal } : {}),
  };
}

/** Error bodies are not always JSON (proxies return HTML or plain text); never let parsing hide the status. */
export function errorMessageFromBody(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {
    // Not JSON; fall through to the status message.
  }
  return `Server returned ${status}`;
}

export type FetchFailure = "timeout" | "network";

/** AbortSignal.timeout rejects with a TimeoutError DOMException; a refused or dropped connection is a TypeError. */
export function classifyFetchError(error: unknown): FetchFailure {
  if (error && typeof error === "object" && "name" in error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  return "network";
}

export type SendResult =
  /** 2xx. `body` is the parsed JSON response, or null when it is not JSON. */
  | { kind: "ok"; status: number; body: unknown; replayed: boolean }
  /** 4xx. The server decided; retrying the same request would replay the same answer. */
  | { kind: "rejected"; status: number; message: string }
  /** No usable answer: timeout, network failure, or a 5xx that the server did not store. Safe to retry with the same key. */
  | { kind: "retryable"; reason: FetchFailure | "server-error"; status: number | null; message: string };

export function noResponseMessage(reason: FetchFailure, timeoutMs = REQUEST_TIMEOUT_MS): string {
  return reason === "timeout"
    ? `No response within ${Math.round(timeoutMs / 1000)} s — it may or may not have run`
    : `No response — ${UNREACHABLE_MESSAGE.toLowerCase()}`;
}

export interface SendOptions {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export async function sendCommand(request: CommandRequest, options: SendOptions = {}): Promise<SendResult> {
  const fetchImpl = options.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(request.url, commandInit(request, AbortSignal.timeout(timeoutMs)));
    text = await response.text();
  } catch (error) {
    const reason = classifyFetchError(error);
    return { kind: "retryable", reason, status: null, message: noResponseMessage(reason, timeoutMs) };
  }
  if (response.ok) {
    let body: unknown = null;
    try { body = text ? JSON.parse(text) as unknown : null; } catch { body = null; }
    return { kind: "ok", status: response.status, body, replayed: response.headers.get("idempotent-replayed") === "true" };
  }
  const message = errorMessageFromBody(response.status, text);
  if (response.status >= 500) return { kind: "retryable", reason: "server-error", status: response.status, message };
  return { kind: "rejected", status: response.status, message };
}

/** Socket.IO and fetch errors carry raw transport text ("xhr poll error"); operators get one plain sentence. */
export function describeConnectError(error: unknown): string {
  const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "";
  if (message === "Unauthorized") return "The management server rejected this dashboard's access token";
  return UNREACHABLE_MESSAGE;
}

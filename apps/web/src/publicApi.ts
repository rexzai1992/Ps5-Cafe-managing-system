import { errorMessageFromBody } from "./api.js";

// Requests made by the TV screen and the customer's phone. They never send the staff token.

export type PublicResult<T> = { ok: true; data: T } | { ok: false; status: number | null; message: string };

const TIMEOUT_MS = 8_000;

async function request<T>(url: string, init: RequestInit = {}): Promise<PublicResult<T>> {
  try {
    const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await response.text();
    if (!response.ok) return { ok: false, status: response.status, message: errorMessageFromBody(response.status, text) };
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: null, message: "Cannot reach the café's server. Check that you are on the café Wi-Fi." };
  }
}

export const getPublic = <T>(url: string) => request<T>(url);

export const postPublic = <T>(url: string, body: unknown) =>
  request<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

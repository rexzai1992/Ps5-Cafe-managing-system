import { describe, expect, it } from "vitest";
import {
  classifyFetchError, commandInit, createCommandRequest, describeConnectError, errorMessageFromBody, IDEMPOTENCY_KEY_PATTERN,
  newIdempotencyKey, sendCommand, stationActionUrl, UNREACHABLE_MESSAGE,
} from "./api.js";

function response(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

describe("newIdempotencyKey", () => {
  it("matches the server's accepted format and is unique", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(200);
    for (const key of keys) expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });

  it("falls back to getRandomValues when randomUUID is unavailable (plain-http LAN origin)", () => {
    const key = newIdempotencyKey({ getRandomValues: (array) => { new Uint8Array(array.buffer).fill(171); return array; } });
    expect(key).toBe("ab".repeat(16));
    expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });
});

describe("createCommandRequest / commandInit", () => {
  it("creates one key per request and sends it with the bearer token", () => {
    const first = createCommandRequest(stationActionUrl("ps5-03"), { type: "PAUSE" });
    const second = createCommandRequest(stationActionUrl("ps5-03"), { type: "PAUSE" });
    expect(first.key).not.toBe(second.key);
    const init = commandInit(first);
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("POST");
    expect(headers["idempotency-key"]).toBe(first.key);
    expect(headers.authorization).toMatch(/^Bearer /);
    expect(init.body).toBe(JSON.stringify({ type: "PAUSE" }));
  });

  it("encodes the station id into the URL", () => {
    expect(stationActionUrl("ps5-01")).toBe("/api/stations/ps5-01/actions");
    expect(stationActionUrl("a/b")).toBe("/api/stations/a%2Fb/actions");
  });
});

describe("errorMessageFromBody", () => {
  it("uses the JSON error field", () => {
    expect(errorMessageFromBody(400, JSON.stringify({ error: "Only an active session can be paused" }))).toBe("Only an active session can be paused");
  });

  it("falls back to the status for non-JSON, empty, or error-less bodies", () => {
    expect(errorMessageFromBody(502, "<html>Bad Gateway</html>")).toBe("Server returned 502");
    expect(errorMessageFromBody(500, "")).toBe("Server returned 500");
    expect(errorMessageFromBody(400, JSON.stringify({ message: "x" }))).toBe("Server returned 400");
    expect(errorMessageFromBody(400, JSON.stringify({ error: "  " }))).toBe("Server returned 400");
    expect(errorMessageFromBody(400, "null")).toBe("Server returned 400");
  });
});

describe("classifyFetchError", () => {
  it("separates timeouts from network failures", () => {
    expect(classifyFetchError(new DOMException("timed out", "TimeoutError"))).toBe("timeout");
    expect(classifyFetchError(new DOMException("aborted", "AbortError"))).toBe("timeout");
    expect(classifyFetchError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyFetchError("weird")).toBe("network");
  });
});

describe("sendCommand", () => {
  const request = createCommandRequest("/api/stations/ps5-03/actions", { type: "ADD_TIME", durationMs: 1_800_000 });

  it("returns ok with the parsed body and the replay flag", async () => {
    const result = await sendCommand(request, { fetchImpl: async () => response(200, JSON.stringify({ id: "ps5-03" }), { "idempotent-replayed": "true" }) });
    expect(result).toEqual({ kind: "ok", status: 200, body: { id: "ps5-03" }, replayed: true });
  });

  it("treats a 4xx as a final rejection with the server's message", async () => {
    const result = await sendCommand(request, { fetchImpl: async () => response(400, JSON.stringify({ error: "No session to extend" })) });
    expect(result).toEqual({ kind: "rejected", status: 400, message: "No session to extend" });
  });

  it("treats a non-JSON 5xx as retryable", async () => {
    const result = await sendCommand(request, { fetchImpl: async () => response(502, "Bad Gateway") });
    expect(result).toEqual({ kind: "retryable", reason: "server-error", status: 502, message: "Server returned 502" });
  });

  it("treats a network TypeError as retryable with plain wording", async () => {
    const result = await sendCommand(request, { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
    expect(result.kind).toBe("retryable");
    if (result.kind !== "retryable") return;
    expect(result.reason).toBe("network");
    expect(result.message).toContain("No response");
    expect(result.message).not.toContain("Failed to fetch");
  });

  it("aborts after the timeout and reports it as retryable", async () => {
    const hang = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    const result = await sendCommand(request, { fetchImpl: hang, timeoutMs: 20 });
    expect(result.kind).toBe("retryable");
    if (result.kind === "retryable") expect(result.reason).toBe("timeout");
  });

  it("resends the same key and body on retry", async () => {
    const seen: { key: string; body: string }[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seen.push({ key: (init.headers as Record<string, string>)["idempotency-key"] ?? "", body: String(init.body) });
      if (seen.length === 1) throw new TypeError("Failed to fetch");
      return response(200, "{}");
    };
    expect((await sendCommand(request, { fetchImpl })).kind).toBe("retryable");
    expect((await sendCommand(request, { fetchImpl })).kind).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]?.key).toBe(request.key);
  });
});

describe("describeConnectError", () => {
  it("hides raw transport strings", () => {
    expect(describeConnectError(new Error("xhr poll error"))).toBe(UNREACHABLE_MESSAGE);
    expect(describeConnectError(new TypeError("Failed to fetch"))).toBe(UNREACHABLE_MESSAGE);
    expect(describeConnectError(new Error("Unauthorized"))).toMatch(/rejected/);
  });
});

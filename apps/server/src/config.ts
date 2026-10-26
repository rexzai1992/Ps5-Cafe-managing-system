import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

try {
  loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
}

const isProduction = process.env.NODE_ENV === "production";
const simulationMode = process.env.SIMULATION_MODE !== "false";
// Live mode keeps its own file by default, so the café never opens the simulation's data (and the server refuses a mix).
const defaultDatabasePath = fileURLToPath(new URL(`../../../data/${simulationMode ? "ps5-cafe" : "ps5-cafe-live"}.sqlite`, import.meta.url));
// The dashboard, TV screen and booking pages, built by `npm run build -w @ps5-cafe/web`.
const webBuild = fileURLToPath(new URL("../../web/dist", import.meta.url));
export const LIVE_TOKEN_MIN_LENGTH = 16;
const defaultAdb = path.join(os.homedir(), "Library/Android/sdk/platform-tools/adb");

export const COMMAND_TIMEOUT_ENV_RANGE = { min: 100, max: 60_000 } as const;

/** Parses the optional PS5_CAFE_COMMAND_TIMEOUT_MS value. Unset or blank means "use the default". */
export function parseCommandTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const { min, max } = COMMAND_TIMEOUT_ENV_RANGE;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`PS5_CAFE_COMMAND_TIMEOUT_MS must be a whole number of milliseconds from ${min} to ${max}`);
  }
  return value;
}

/** Parses the optional PS5_CAFE_RESERVATION_HOLD_MINUTES value (1-60). Unset or blank means the 10-minute default. */
export function parseReservationHoldMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const minutes = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new Error("PS5_CAFE_RESERVATION_HOLD_MINUTES must be a whole number of minutes from 1 to 60");
  }
  return minutes * 60_000;
}

/** Live mode serves real customers on the café network: the staff token must be long and never the development one. */
export function liveTokenProblem(simulationMode: boolean, token: string): string | null {
  if (simulationMode) return null;
  if (token === "local-dev-token" || token.trim().length < LIVE_TOKEN_MIN_LENGTH) {
    return `Live mode (SIMULATION_MODE=false) needs PS5_CAFE_API_TOKEN of at least ${LIVE_TOKEN_MIN_LENGTH} characters, not the development token`;
  }
  return null;
}

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
  // `||`, not `??`: a blank PS5_CAFE_API_TOKEN counts as unset rather than as an empty token.
  apiToken: process.env.PS5_CAFE_API_TOKEN || (isProduction ? "" : "local-dev-token"),
  databasePath: process.env.PS5_CAFE_DB_PATH ? path.resolve(process.env.PS5_CAFE_DB_PATH) : defaultDatabasePath,
  // adb tool for opt-in TV remote control: PS5_CAFE_ADB, else the Android SDK's copy if present; null disables it.
  adbPath: process.env.PS5_CAFE_ADB || (fs.existsSync(defaultAdb) ? defaultAdb : null),
  // Advertising files; unset means `media/` beside the database file.
  mediaDir: process.env.PS5_CAFE_MEDIA_DIR ? path.resolve(process.env.PS5_CAFE_MEDIA_DIR) : undefined,
  simulationMode,
  stationCount: Math.max(1, Number(process.env.STATION_COUNT ?? 10)),
  commandTimeoutMs: parseCommandTimeoutMs(process.env.PS5_CAFE_COMMAND_TIMEOUT_MS),
  reservationHoldMs: parseReservationHoldMs(process.env.PS5_CAFE_RESERVATION_HOLD_MINUTES),
  // In production the server serves the web build itself: one address for staff, TVs and phones, and each phone's own IP
  // reaches the per-IP rate limits (behind the dev proxy every customer would share one).
  webRoot: isProduction && fs.existsSync(path.join(webBuild, "index.html")) ? webBuild : undefined,
  isProduction,
};

if (isProduction && !config.apiToken.trim()) {
  throw new Error("PS5_CAFE_API_TOKEN is required in production");
}
const tokenProblem = liveTokenProblem(simulationMode, config.apiToken);
if (tokenProblem) throw new Error(tokenProblem);

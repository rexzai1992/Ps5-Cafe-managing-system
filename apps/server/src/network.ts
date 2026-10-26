import os, { networkInterfaces } from "node:os";

/** This computer's LAN IPv4 addresses. They can change: DHCP gave the café Mac three in one day. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry!.address);
}

/** The computer's Bonjour name (e.g. Craves-MacBook-Air.local), which survives address changes; null if it has none. */
export function localHostName(name = os.hostname()): string | null {
  return /^[A-Za-z0-9-]{1,63}\.local$/.test(name) ? name : null;
}

const IPV4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Where a TV's QR code sends phones. A TV may load its page by the computer's name; not every phone can resolve a
 * `.local` name, so phones get the current LAN address (same port). A TV that loaded by address keeps that address.
 */
export function bookingOriginFor(hostHeader: string | undefined, protocol: string, addresses: readonly string[]): string {
  let hostname = "";
  let port = "";
  try { ({ hostname, port } = new URL(`http://${hostHeader ?? ""}`)); } catch { /* unusable Host header: fall through */ }
  const suffix = port ? `:${port}` : "";
  const ip = IPV4.exec(hostname);
  if (ip && ip[1] !== "127") return `${protocol}://${hostname}${suffix}`;
  const lan = addresses[0];
  if (lan) return `${protocol}://${lan}${suffix}`;
  return hostname ? `${protocol}://${hostname}${suffix}` : "";
}

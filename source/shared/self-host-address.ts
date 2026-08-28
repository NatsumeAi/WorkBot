/**
 * Guard for the self-host box address entered on the Connect page.
 *
 * On a phone, 127.0.0.1 is the phone itself — entering it as the box address
 * connects to the wrong machine exactly like typing the wrong IP on desktop.
 * The Android shell additionally rejects loopback targets before they reach
 * the forwarder; desktop keeps its own behaviour.
 */

export const SELF_HOST_LOOPBACK_HINT =
  "127.0.0.1 and localhost are this device itself, not the box. Enter the box's LAN address, for example http://192.168.1.8:1340.";

export const SELF_HOST_ADDRESS_INVALID_HINT =
  "Enter the box gateway address as a full URL, for example http://192.168.1.8:1340.";

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

export function isLoopbackGatewayHost(hostname: string): boolean {
  const value = normalizeHostname(hostname);
  if (value.length === 0) return false;
  return value === "localhost"
    || value === "::1"
    || value === "::"
    || value === "0.0.0.0"
    || value.endsWith(".localhost")
    || value.endsWith(".localdomain")
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

export type ParsedSelfHostGatewayAddress =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: string };

export function parseSelfHostGatewayAddress(value: unknown): ParsedSelfHostGatewayAddress {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: SELF_HOST_ADDRESS_INVALID_HINT };
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, reason: SELF_HOST_ADDRESS_INVALID_HINT };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: SELF_HOST_ADDRESS_INVALID_HINT };
  }
  if (normalizeHostname(url.hostname).length === 0) {
    return { ok: false, reason: SELF_HOST_ADDRESS_INVALID_HINT };
  }
  if (isLoopbackGatewayHost(url.hostname)) {
    return { ok: false, reason: SELF_HOST_LOOPBACK_HINT };
  }
  return { ok: true, url };
}

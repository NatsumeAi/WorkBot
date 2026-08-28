/**
 * Typed access to the Android `SandNative` JavaScript interface.
 *
 * The gateway token never crosses this boundary: it is written into the
 * Android Keystore through upsertSecrets and is only ever read back natively
 * by GatewayForwarder. The page can ask whether a token exists (hasGatewayToken)
 * but can never read it.
 */

export interface SandNativeBridge {
  openExternal?(url: string): void;
  listSecrets?(): string;
  revealSecret?(key: string): string | null;
  upsertSecrets?(entriesJson: string): void;
  removeSecrets?(keysJson: string): void;
  getPref?(key: string): string | null;
  setPref?(key: string, value: string): void;
  clearPref?(key: string): void;
  getForwarderPort?(): number;
  hasGatewayToken?(): boolean;
  probeGateway?(gatewayUrl: string, token: string): string;
}

export const GATEWAY_TOKEN_SECRET_KEY = "gatewayToken";
export const BOX_BASE_URL_PREF = "boxBaseUrl";

export function sandNative(): SandNativeBridge | null {
  const native = (window as { SandNative?: SandNativeBridge }).SandNative;
  return typeof native === "object" && native != null ? native : null;
}

export function isAndroidShell(): boolean {
  return sandNative() != null;
}

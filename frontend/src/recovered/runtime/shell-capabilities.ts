import type { DesktopBridge } from "../contracts/desktop-bridge";

export const SAND_SHELL_CAPABILITIES = [
  "conversation",
  "auth",
  "inferenceRouter",
  "secrets",
  "mcp",
  "remoteBox",
  "localDockerVm",
  "vncComputer",
  "windowChrome",
  "webauthnSigner",
] as const;

export type SandShellCapability = (typeof SAND_SHELL_CAPABILITIES)[number];

export function shellCapabilities(bridge: DesktopBridge | null | undefined): Record<string, string> | null {
  if (bridge == null || typeof bridge !== "object") return null;
  const caps = (bridge as { capabilities?: unknown }).capabilities;
  if (typeof caps !== "object" || caps == null || Array.isArray(caps)) return null;
  return caps as Record<string, string>;
}

export function shellSupports(bridge: DesktopBridge | null | undefined, capability: SandShellCapability): boolean {
  if (bridge == null) return false;
  const caps = shellCapabilities(bridge);
  if (caps == null) return true;
  return caps[capability] === "live";
}

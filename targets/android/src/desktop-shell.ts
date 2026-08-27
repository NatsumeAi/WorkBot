import type { SandPlatformTarget } from "../../../source/shared/platform-targets.js";

/** Capability row for an Android remote-control shell. Bots live on the box gateway, not on a desktop WebSocket. */
export const ANDROID_PLATFORM_TARGET = {
  id: "android",
  family: "thin-client",
  status: "implemented",
  hostOs: "android",
  arch: "arm64",
  packager: "scripts/package-android.mjs",
  electronShell: null,
  upstreamArtifact: null,
  capabilities: {
    conversation: "live",
    auth: "live",
    inferenceRouter: "live",
    secrets: "live",
    mcp: "unsupported",
    remoteBox: "live",
    localDockerVm: "unsupported",
    vncComputer: "unsupported",
    windowChrome: "unsupported",
    webauthnSigner: "unsupported",
  },
} as const satisfies SandPlatformTarget;

interface SandNativeBridge {
  openExternal?(url: string): void;
  listSecrets?(): string;
  revealSecret?(key: string): string | null;
  upsertSecrets?(entriesJson: string): void;
  removeSecrets?(keysJson: string): void;
}

export function sandNative(): SandNativeBridge | null {
  const native = (globalThis as { SandNative?: SandNativeBridge }).SandNative;
  return native ?? null;
}

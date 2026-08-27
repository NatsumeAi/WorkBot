export const SAND_CAPABILITIES = [
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

export type SandCapability = (typeof SAND_CAPABILITIES)[number];
export type SandCapabilityState = "live" | "unsupported";
export type SandPlatformFamily = "electron-desktop" | "thin-client";
export type SandPlatformStatus = "implemented" | "planned";

export const UNSUPPORTED_CAPABILITY = "unsupported-capability";

export interface UnsupportedCapabilityFailure {
  readonly code: typeof UNSUPPORTED_CAPABILITY;
  readonly capability: SandCapability;
  readonly message: string;
}

export function isSandCapability(value: unknown): value is SandCapability {
  return typeof value === "string" && (SAND_CAPABILITIES as readonly string[]).includes(value);
}

export function unsupportedCapability(capability: SandCapability, detail?: string): UnsupportedCapabilityFailure {
  return {
    code: UNSUPPORTED_CAPABILITY,
    capability,
    message: detail ?? `Capability ${capability} is not available on this shell.`,
  };
}

export function isUnsupportedCapabilityFailure(value: unknown): value is UnsupportedCapabilityFailure {
  if (typeof value !== "object" || value == null) return false;
  const record = value as Record<string, unknown>;
  return record.code === UNSUPPORTED_CAPABILITY && isSandCapability(record.capability) && typeof record.message === "string";
}

export class UnsupportedCapabilityError extends Error {
  readonly code = UNSUPPORTED_CAPABILITY;
  constructor(readonly capability: SandCapability, detail?: string) {
    super(unsupportedCapability(capability, detail).message);
    this.name = "UnsupportedCapabilityError";
  }
  toFailure(): UnsupportedCapabilityFailure {
    return unsupportedCapability(this.capability, this.message);
  }
}

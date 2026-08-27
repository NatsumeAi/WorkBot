import catalogJson from "../../manifests/platforms.json" with { type: "json" };

import {
  SAND_CAPABILITIES,
  type SandCapability,
  type SandCapabilityState,
  type SandPlatformFamily,
  type SandPlatformStatus,
} from "./capabilities.js";

export interface SandPlatformTarget {
  readonly id: string;
  readonly family: SandPlatformFamily;
  readonly status: SandPlatformStatus;
  readonly hostOs: string;
  readonly arch: string;
  readonly packager: string;
  readonly electronShell: string | null;
  readonly upstreamArtifact: string | null;
  readonly capabilities: Record<SandCapability, SandCapabilityState>;
}

export interface SandPlatformCatalog {
  readonly schemaVersion: 1;
  readonly capabilities: readonly SandCapability[];
  readonly targets: readonly SandPlatformTarget[];
}

const catalog = catalogJson as SandPlatformCatalog;

export function loadPlatformCatalog(): SandPlatformCatalog {
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.targets) || catalog.targets.length === 0) {
    throw new Error("manifests/platforms.json is not a valid platform catalog.");
  }
  return catalog;
}

export function listPlatformTargets(): readonly SandPlatformTarget[] {
  return loadPlatformCatalog().targets;
}

export function platformTargetById(id: string): SandPlatformTarget {
  const target = listPlatformTargets().find((candidate) => candidate.id === id);
  if (target == null) throw new Error(`Unknown platform target: ${id}`);
  return target;
}

export function detectHostPlatformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): SandPlatformTarget {
  const requested = env.GROK_BOT_TARGET?.trim();
  if (requested) return platformTargetById(requested);
  const match = listPlatformTargets().find((target) => target.hostOs === platform && target.arch === arch);
  if (match != null) return match;
  if (platform === "linux") return platformTargetById("linux-x64");
  if (platform === "win32") return platformTargetById("windows-x64");
  if (platform === "darwin") return platformTargetById("macos-arm64");
  throw new Error(`No platform target is registered for ${platform}/${arch}.`);
}

export function liveCapabilities(target: SandPlatformTarget): readonly SandCapability[] {
  return SAND_CAPABILITIES.filter((capability) => target.capabilities[capability] === "live");
}

export function targetSupports(target: SandPlatformTarget, capability: SandCapability): boolean {
  return target.capabilities[capability] === "live";
}

export function isElectronDesktopFamily(target: SandPlatformTarget): boolean {
  return target.family === "electron-desktop";
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const catalogPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../manifests/platforms.json");

export function loadPlatformCatalog() {
  const parsed = JSON.parse(readFileSync(catalogPath, "utf8"));
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.targets)) {
    throw new Error("manifests/platforms.json is not a valid platform catalog.");
  }
  return parsed;
}

export function listPlatformTargets() {
  return loadPlatformCatalog().targets;
}

export function platformTargetById(id) {
  const target = listPlatformTargets().find((candidate) => candidate.id === id);
  if (target == null) throw new Error(`Unknown platform target: ${id}`);
  return target;
}

export function detectHostPlatformTarget(platform = process.platform, arch = process.arch, env = process.env) {
  const requested = env.GROK_BOT_TARGET?.trim();
  if (requested) return platformTargetById(requested);
  const match = listPlatformTargets().find((target) => target.hostOs === platform && target.arch === arch);
  if (match != null) return match;
  if (platform === "linux") return platformTargetById("linux-x64");
  if (platform === "win32") return platformTargetById("windows-x64");
  if (platform === "darwin") return platformTargetById("macos-arm64");
  throw new Error(`No platform target is registered for ${platform}/${arch}.`);
}

export function targetSupports(target, capability) {
  return target.capabilities?.[capability] === "live";
}

export function isElectronDesktopFamily(target) {
  return target.family === "electron-desktop";
}

export function unimplementedTargetError(target) {
  return new Error(
    `Platform target ${target.id} (${target.family}) is ${target.status}. Packager ${target.packager} is not implemented yet.`,
  );
}

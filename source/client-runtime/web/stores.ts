import { normalizeSandAutoReviewInstructions } from "../../shared/sand-auto-review-instructions.js";
import { SAND_DEFAULT_LOCAL_TOOL_PERMISSION, normalizeSandLocalToolPermission, type SandLocalToolPermission } from "../../shared/local-tool-permission.js";
import { isSandThemePreference, type SandThemePreference } from "../../shared/desktop.js";

/**
 * Browser-backed stores that satisfy the `MainEdgeDeps` store surfaces with
 * the same semantics as their Electron counterparts, backed by localStorage
 * (swappable for tests). Everything is per-origin, i.e. per device install.
 */

export type WebStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function browserStorage(): WebStorage {
  return localStorage;
}

export function memoryStorage(): WebStorage {
  const map = new Map<string, string>();
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: key => { map.delete(key); },
  };
}

const PREFIX = "sand.web.";

function readJson<T>(storage: WebStorage, key: string): T | undefined {
  const raw = storage.getItem(PREFIX + key);
  if (raw == null) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

function writeJson(storage: WebStorage, key: string, value: unknown): void {
  storage.setItem(PREFIX + key, JSON.stringify(value === undefined ? null : value));
}

export type WebThemeState = {
  readonly preference: SandThemePreference;
  readonly resolved: "light" | "dark";
}

function resolveTheme(preference: SandThemePreference): "light" | "dark" {
  if (preference === "system") return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  return preference;
}

export function createWebThemeController(storage: WebStorage, onChanged: (state: WebThemeState) => void): {
  getState(): WebThemeState;
  setPreference(preference: SandThemePreference): WebThemeState;
} {
  const read = (): WebThemeState => {
    const stored = readJson<unknown>(storage, "themePreference");
    const preference = isSandThemePreference(stored) ? stored : "system";
    return { preference, resolved: resolveTheme(preference) };
  };
  return {
    getState: read,
    setPreference(preference) {
      writeJson(storage, "themePreference", preference);
      const state = read();
      onChanged(state);
      return state;
    },
  };
}

export type WebSettingsStore = {
  getUserTimeZoneOverride(): string | undefined;
  setUserTimeZoneOverride(value: string | undefined): void;
  getAutoReviewInstructions(): ReturnType<typeof normalizeSandAutoReviewInstructions>;
  setAutoReviewInstructions(value: ReturnType<typeof normalizeSandAutoReviewInstructions>): void;
  getLocalToolPermission(): SandLocalToolPermission;
  getLocalToolPermissionCeiling(): SandLocalToolPermission | undefined;
  setLocalToolPermission(value: SandLocalToolPermission): void;
  getInferenceEndpoints(): unknown;
  setInferenceEndpoints(value: unknown): void;
  getInferenceProvider(): string | undefined;
  setInferenceProvider(value: string): void;
  getInferenceRouterUsage(): unknown;
  getPinnedAgentIds(): readonly string[] | undefined;
  setPinnedAgentIds(value: readonly string[] | undefined): void;
  getSidebarSections(): unknown;
  setSidebarSections(value: unknown): void;
  readonly settingsPath: string;
}

export function createWebSettingsStore(storage: WebStorage): WebSettingsStore {
  return {
    getUserTimeZoneOverride: () => readJson<string>(storage, "userTimeZoneOverride"),
    setUserTimeZoneOverride: value => value === undefined ? storage.removeItem(PREFIX + "userTimeZoneOverride") : writeJson(storage, "userTimeZoneOverride", value),
    getAutoReviewInstructions: () => normalizeSandAutoReviewInstructions(readJson<Parameters<typeof normalizeSandAutoReviewInstructions>[0]>(storage, "autoReviewInstructions")),
    setAutoReviewInstructions: value => writeJson(storage, "autoReviewInstructions", value),
    getLocalToolPermission: () => normalizeSandLocalToolPermission(readJson<unknown>(storage, "localToolPermission") ?? SAND_DEFAULT_LOCAL_TOOL_PERMISSION),
    getLocalToolPermissionCeiling: () => readJson<SandLocalToolPermission>(storage, "localToolPermissionCeiling"),
    setLocalToolPermission: value => writeJson(storage, "localToolPermission", value),
    getInferenceEndpoints: () => readJson<unknown>(storage, "inferenceEndpoints"),
    setInferenceEndpoints: value => writeJson(storage, "inferenceEndpoints", value),
    getInferenceProvider: () => readJson<string>(storage, "inferenceProvider"),
    setInferenceProvider: value => writeJson(storage, "inferenceProvider", value),
    getInferenceRouterUsage: () => readJson<unknown>(storage, "inferenceRouterUsage"),
    getPinnedAgentIds: () => readJson<readonly string[]>(storage, "pinnedAgentIds"),
    setPinnedAgentIds: value => value === undefined ? storage.removeItem(PREFIX + "pinnedAgentIds") : writeJson(storage, "pinnedAgentIds", value),
    getSidebarSections: () => readJson<unknown>(storage, "sidebarSections"),
    setSidebarSections: value => writeJson(storage, "sidebarSections", value),
    settingsPath: "",
  };
}

export type WebAgentPrefsStore = {
  getAgentDefaultModel(): unknown;
  setAgentDefaultModel(value: unknown): void;
  getComputerUseModel(): unknown;
  setComputerUseModel(value: unknown): void;
}

export function createWebAgentPrefsStore(storage: WebStorage): WebAgentPrefsStore {
  return {
    getAgentDefaultModel: () => readJson<unknown>(storage, "agentDefaultModel"),
    setAgentDefaultModel: value => value === undefined ? storage.removeItem(PREFIX + "agentDefaultModel") : writeJson(storage, "agentDefaultModel", value),
    getComputerUseModel: () => readJson<unknown>(storage, "computerUseModel"),
    setComputerUseModel: value => value === undefined ? storage.removeItem(PREFIX + "computerUseModel") : writeJson(storage, "computerUseModel", value),
  };
}

export type WebBoxToggleStore = {
  getEgressTunnelEnabled(): boolean;
  setEgressTunnelEnabled(value: boolean): void;
  getWebauthnProxyEnabled(): boolean;
  setWebauthnProxyEnabled(value: boolean): void;
}

export function createWebBoxToggleStore(storage: WebStorage): WebBoxToggleStore {
  return {
    getEgressTunnelEnabled: () => readJson<boolean>(storage, "egressTunnelEnabled") === true,
    setEgressTunnelEnabled: value => writeJson(storage, "egressTunnelEnabled", value),
    getWebauthnProxyEnabled: () => readJson<boolean>(storage, "webauthnProxyEnabled") === true,
    setWebauthnProxyEnabled: value => writeJson(storage, "webauthnProxyEnabled", value),
  };
}

export type WebOnboardingSeen = {
  reconcile(): boolean;
  apply(seen: boolean): void;
}

export function createWebOnboardingSeen(storage: WebStorage): WebOnboardingSeen {
  return {
    reconcile: () => readJson<boolean>(storage, "onboardingSeen") === true,
    apply: seen => writeJson(storage, "onboardingSeen", seen),
  };
}

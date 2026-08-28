import { createMainEdgeHandlers, EdgeCallFailure, MAIN_EDGE_UNSERVED } from "../../electron-main/main-edge.js";
import { coerceAttachmentBytes, normalizeAttachmentFilename, resolveStageAttachmentArgs } from "../../shared/media/attachment-bytes.js";
import { UnsupportedCapabilityError } from "../../shared/capabilities.js";
import { audioMimeFromPath, videoMimeFromPath } from "../../shared/media/image-mime.js";
import { parseSelfHostGatewayAddress } from "../../shared/self-host-address.js";
import { createWebAgentPrefsStore, createWebBoxToggleStore, createWebOnboardingSeen, createWebSettingsStore, createWebThemeController, type WebStorage, type WebThemeState } from "./stores.js";
import { BOX_BASE_URL_PREF, GATEWAY_TOKEN_SECRET_KEY, sandNative } from "./sand-native.js";

/**
 * The same main-edge handler logic the Electron desktop serves, backed by web
 * stores and the on-device gateway forwarder. Chat/box work still rides the
 * gateway; this file only swaps the desktop-only backends.
 */

export interface GatewayCommandClient {
  dispatchCommand(method: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface MainChannelEvents {
  postEvent(family: string, payload: unknown): void;
}

const GATEWAY_READ_CHUNK_BYTES = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index] as number);
  return btoa(binary);
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function normalizeAttachmentSource(source: unknown): string | null {
  if (typeof source !== "string" || source.length === 0) return null;
  if (source.startsWith("file:")) return null;
  return source;
}

function nativeProbe(gatewayUrl: string, token: string): { ok: boolean; message: string } {
  const native = sandNative();
  if (native?.probeGateway == null) return { ok: false, message: "Can't reach that URL." };
  try {
    const raw = native.probeGateway(gatewayUrl, token);
    const parsed = isRecord(JSON.parse(raw)) ? JSON.parse(raw) as { ok?: unknown; message?: unknown } : {};
    return { ok: parsed.ok === true, message: typeof parsed.message === "string" ? parsed.message : "Can't reach that URL." };
  } catch {
    return { ok: false, message: "Can't reach that URL." };
  }
}

export interface WebMainEdgeDepsOptions {
  readonly storage: WebStorage;
  readonly gateway: GatewayCommandClient;
  /** Desktop maps this to a coordinator restart; the web runtime forces the SSE reconnect. */
  readonly restartGateway?: () => void;
  readonly events: MainChannelEvents;
}

export function createWebMainEdgeDeps(options: WebMainEdgeDepsOptions) {
  const stagedAttachments = new Map<string, { filename: string; bytes: Uint8Array }>();
  const themeChanged = (state: WebThemeState): void => options.events.postEvent("theme-changed", state);
  const native = (): NonNullable<ReturnType<typeof sandNative>> => {
    const bridge = sandNative();
    if (bridge == null) throw new EdgeCallFailure({ code: MAIN_EDGE_UNSERVED, detail: "The Android native bridge is unavailable." });
    return bridge;
  };
  const storedBoxBaseUrl = (): string => (native().getPref?.(BOX_BASE_URL_PREF) ?? "").replace(/\/$/, "");
  const hasGatewayToken = (): boolean => native().hasGatewayToken === undefined ? true : native().hasGatewayToken?.() === true;

  return {
    readLiveUpdateService: () => null,
    readThemeController: () => createWebThemeController(options.storage, themeChanged),
    readEgressTunnelController: () => ({
      setEnabled: () => {},
      getStatus: () => ({ enabled: false, state: "unsupported", detail: "Egress tunnel is a desktop capability." }),
    }),
    settingsStore: createWebSettingsStore(options.storage),
    agentPrefsStore: createWebAgentPrefsStore(options.storage),
    boxToggleStore: createWebBoxToggleStore(options.storage),
    onboardingSeen: createWebOnboardingSeen(options.storage),
    shell: {
      openExternalUrl: (url: unknown) => { if (typeof url === "string" && url.length > 0) native().openExternal?.(url); },
      openInSystemBrowser: (url: unknown) => { if (typeof url === "string" && url.length > 0) native().openExternal?.(url); },
      submitFeedback: () => { throw new UnsupportedCapabilityError("windowChrome", "Feedback submission is a desktop capability."); },
      markDeepLinksReady: () => {},
    },
    boxRecovery: {
      readBoxMigrationStatus: () => null,
      restartCoordinator: () => options.restartGateway?.(),
      forceRecreateComputer: () => { throw new UnsupportedCapabilityError("vncComputer", "Recreating the computer is a desktop capability."); },
      recreateComputer: () => { throw new UnsupportedCapabilityError("vncComputer", "Recreating the computer is a desktop capability."); },
      updateForeverBox: (args: unknown) => options.gateway.dispatchCommand("updateForeverBox", args),
    },
    windowChrome: {
      getWindowState: () => ({ isFullscreen: false, isMaximized: false }),
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => {},
      setTitleBarOverlayTone: () => {},
      resizeWidth: () => 0,
    },
    avatarImages: {
      pickSource: () => null,
      pickFile: () => { throw new UnsupportedCapabilityError("windowChrome", "Picking avatar files is a desktop capability."); },
      generateImage: () => { throw new UnsupportedCapabilityError("vncComputer", "Generating avatar images is a desktop capability."); },
    },
    attachments: {
      async resolveMedia(source: unknown) {
        const path = normalizeAttachmentSource(source);
        if (path == null) return null;
        if (videoMimeFromPath(path) != null || audioMimeFromPath(path) != null) return null;
        const image = await options.gateway.dispatchCommand("readAttachmentImage", { path }) as { dataUrl?: unknown; width?: unknown; height?: unknown } | null;
        if (image == null || typeof image.dataUrl !== "string") return null;
        return {
          kind: "image" as const,
          dataUrl: image.dataUrl,
          ...(typeof image.width === "number" ? { width: image.width } : {}),
          ...(typeof image.height === "number" ? { height: image.height } : {}),
        };
      },
      async readText(source: unknown): Promise<string | null> {
        const path = normalizeAttachmentSource(source);
        if (path == null) return null;
        try { return await options.gateway.dispatchCommand("readAttachmentText", { path }) as string | null; } catch { return null; }
      },
      async readBytes(source: unknown, maxBytes?: unknown) {
        const path = normalizeAttachmentSource(source);
        if (path == null) return null;
        const cap = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 8 * 1024 * 1024;
        let totalSize: number;
        try {
          const probe = await options.gateway.dispatchCommand("readAttachmentChunk", { path, offset: 0, length: 0 }) as { totalSize?: unknown } | null;
          if (probe == null || typeof probe.totalSize !== "number") return null;
          totalSize = probe.totalSize;
        } catch { return null; }
        if (totalSize > cap) return { kind: "too-large" as const, size: totalSize };
        const bytes = new Uint8Array(totalSize);
        let offset = 0;
        while (offset < totalSize) {
          const chunk = await options.gateway.dispatchCommand("readAttachmentChunk", { path, offset, length: GATEWAY_READ_CHUNK_BYTES }) as { bytesBase64?: unknown } | null;
          if (chunk == null || typeof chunk.bytesBase64 !== "string") return null;
          const part = bytesFromBase64(chunk.bytesBase64);
          if (part.length === 0) break;
          bytes.set(part, offset);
          offset += part.length;
        }
        return offset < totalSize ? null : { kind: "bytes" as const, bytes };
      },
      async stageBytes(filename: unknown, bytes?: unknown) {
        const args = resolveStageAttachmentArgs(filename, bytes);
        const safeName = normalizeAttachmentFilename(args.filename);
        const payload = coerceAttachmentBytes(args.bytes);
        if (safeName == null || payload == null) return { ok: false as const, reason: "failed" as const };
        if (payload.byteLength === 0) return { ok: false as const, reason: "empty" as const };
        const path = `staged://${Date.now()}-${Math.random().toString(16).slice(2)}`;
        stagedAttachments.set(path, { filename: safeName, bytes: payload });
        return { ok: true as const, path };
      },
      async download() { return false; },
      async commitStaged(rawPaths: unknown, rawFilenames: unknown) {
        const paths = Array.isArray(rawPaths) ? rawPaths : [];
        const filenames = Array.isArray(rawFilenames) ? rawFilenames : [];
        const committed: string[] = [];
        for (let index = 0; index < paths.length; index += 1) {
          const stagedPath = paths[index];
          const staged = typeof stagedPath === "string" ? stagedAttachments.get(stagedPath) : undefined;
          const filename = normalizeAttachmentFilename(filenames[index]) ?? staged?.filename;
          if (staged == null || filename == null) return null;
          try {
            const uploaded = await options.gateway.dispatchCommand("uploadAttachment", { filename, bytesBase64: base64FromBytes(staged.bytes) }) as { path?: unknown } | null;
            if (uploaded == null || typeof uploaded.path !== "string") return null;
            committed.push(uploaded.path);
            stagedAttachments.delete(stagedPath);
          } catch { return null; }
        }
        return committed;
      },
      async discardStaged(stagedPath: unknown) {
        if (typeof stagedPath === "string") stagedAttachments.delete(stagedPath);
      },
      async getLinkMetadata() { return null; },
    },
    cursorAccount: {
      getAuthStatus: () => ({ kind: "logged-out" as const }),
      login: () => Promise.resolve({ kind: "logged-out" as const, errorMessage: "Sign in on the desktop app that owns this box; the phone shares it." }),
      cancelLogin: () => {},
      logout: () => {},
      updateAccountName: () => {},
      getAvatar: () => null,
      getWeeklyUsage: () => null,
      getUsageSummary: () => null,
      getPrReviewPreferences: () => null,
      getPrivacyModeEnabled: () => false,
      getSandAccess: () => null,
      getSandAccessFresh: () => null,
      invokeDashboardAction: () => { throw new UnsupportedCapabilityError("auth", "Dashboard actions are a desktop capability."); },
      cancelTrial: () => {},
    },
    experiments: {
      ensureService: () => ({ getSnapshot: () => ({}) }),
      isTelemetryDisabled: () => true,
      startRpcTraceWindow: () => false,
    },
    syncHostSettingsToBox: async (settings: Record<string, unknown>) => {
      try { return await options.gateway.dispatchCommand("setHostSettings", settings) as Record<string, unknown> | null; }
      catch { return null; }
    },
    readHostSettingsFromBox: async () => await options.gateway.dispatchCommand("getHostSettings", {}) as Record<string, unknown>,
    recordLocalToolApproval: async () => {},
    clearLocalToolApprovals: async () => {},
    getComputerUseModelOverride: () => null,
    fetchAvailableModels: () => Promise.resolve([]),
    emitEgressTunnelChanged: (enabled: boolean) => options.events.postEvent("egress-tunnel-changed", enabled),
    emitWebauthnProxyChanged: (enabled: boolean) => options.events.postEvent("webauthn-proxy-changed", enabled),
    ensureTranscriptionManager: () => { throw new UnsupportedCapabilityError("windowChrome", "Audio transcription is a desktop capability."); },
    platform: "linux" as const,
    selfHost: {
      getConnection: async () => {
        const gatewayUrl = storedBoxBaseUrl();
        const hasToken = hasGatewayToken();
        const probed = gatewayUrl.length > 0 ? nativeProbe(gatewayUrl, "") : { ok: false, message: "Not connected." };
        return {
          envOverrides: false,
          gatewayUrl,
          hasToken,
          host: "",
          username: "",
          sshPort: 22,
          gatewayPort: 1340,
          status: gatewayUrl.length === 0 ? "missing" : probed.ok ? "connected" : "saved",
          statusMessage: probed.message,
          dockerInstallUrl: "https://docs.docker.com/engine/install/",
          defaultGatewayPort: 1340,
          defaultSshPort: 22,
        };
      },
      setConnection: async (raw: unknown) => {
        const request = isRecord(raw) ? raw : {};
        const bridge = native();
        const parse = parseSelfHostGatewayAddress(asString(request.gatewayUrl));
        if (request.clear === true) {
          bridge.clearPref?.(BOX_BASE_URL_PREF);
          bridge.removeSecrets?.(JSON.stringify([GATEWAY_TOKEN_SECRET_KEY]));
          return { gatewayUrl: "", hasToken: false, status: "missing", statusMessage: "Not connected." };
        }
        if (!parse.ok && request.gatewayUrl !== "") {
          return { gatewayUrl: asString(request.gatewayUrl) ?? "", hasToken: hasGatewayToken(), status: "saved", statusMessage: parse.reason, message: parse.reason };
        }
        const gatewayUrl = parse.ok ? parse.url.origin : storedBoxBaseUrl();
        const token = asString(request.token);
        if (gatewayUrl.length === 0 || (token == null && !hasGatewayToken())) {
          return { gatewayUrl, hasToken: hasGatewayToken(), status: gatewayUrl.length === 0 ? "missing" : "saved", statusMessage: "Enter an access URL and token.", message: "Enter an access URL and token." };
        }
        bridge.setPref?.(BOX_BASE_URL_PREF, gatewayUrl);
        if (token != null) bridge.upsertSecrets?.(JSON.stringify({ [GATEWAY_TOKEN_SECRET_KEY]: token }));
        const probed = nativeProbe(gatewayUrl, token ?? "");
        return { gatewayUrl, hasToken: true, status: probed.ok ? "connected" : "saved", statusMessage: probed.ok ? probed.message : probed.message === "Wrong token." ? probed.message : "Saved. The box is unreachable right now." };
      },
      getInstallCommand: () => { throw new UnsupportedCapabilityError("localDockerVm", "Installing the box happens on the box machine itself."); },
      install: () => { throw new UnsupportedCapabilityError("localDockerVm", "Installing the box happens on the box machine itself."); },
      testGateway: async (raw: unknown) => {
        const request = isRecord(raw) ? raw : {};
        const gatewayUrl = asString(request.gatewayUrl) ?? "";
        if (gatewayUrl.length > 0) {
          const parse = parseSelfHostGatewayAddress(gatewayUrl);
          if (!parse.ok) return { ok: false, message: parse.reason };
        }
        return nativeProbe(gatewayUrl, asString(request.token) ?? "");
      },
      pickKeyFile: () => { throw new UnsupportedCapabilityError("windowChrome", "Picking key files is a desktop capability."); },
      openDocs: () => native().openExternal?.("https://github.com"),
    },
  };
}

export type WebMainEdgeDeps = ReturnType<typeof createWebMainEdgeDeps>;

export function createWebMainEdgeHandlers(deps: WebMainEdgeDeps) {
  return createMainEdgeHandlers(deps);
}

/** Hand-wired fallbacks that ride dedicated channels on desktop. */
export function createWebMainFallbacks(storage: WebStorage) {
  const native = (): ReturnType<typeof sandNative> => sandNative();
  return {
    listSecrets: async () => JSON.parse(native()?.listSecrets?.() ?? "[]") as string[],
    revealSecret: async (args: unknown) => {
      const key = isRecord(args) ? asString(args.key) : undefined;
      return key == null ? null : native()?.revealSecret?.(key) ?? null;
    },
    upsertSecrets: async (args: unknown) => { native()?.upsertSecrets?.(JSON.stringify(isRecord(args) ? args.entries ?? {} : {})); },
    removeSecrets: async (args: unknown) => { native()?.removeSecrets?.(JSON.stringify(isRecord(args) && Array.isArray(args.keys) ? args.keys : [])); },
    clientPersistenceRead: async (args: unknown) => storage.getItem(`clientPersistence:${isRecord(args) ? String(args.key ?? "") : ""}`),
    clientPersistenceWrite: async (args: unknown) => { if (isRecord(args) && typeof args.key === "string") storage.setItem(`clientPersistence:${args.key}`, String(args.value ?? "")); },
    clientPersistenceRemove: async (args: unknown) => { if (isRecord(args) && typeof args.key === "string") storage.removeItem(`clientPersistence:${args.key}`); },
    clientPersistenceListKeys: async () => [] as string[],
    clientPersistenceMigrate: async () => false,
  };
}

export type WebMainFallbacks = ReturnType<typeof createWebMainFallbacks>;

export function isWebMainFallbackMethod(method: string): method is keyof WebMainFallbacks {
  return method === "listSecrets" || method === "revealSecret" || method === "upsertSecrets" || method === "removeSecrets"
    || method === "clientPersistenceRead" || method === "clientPersistenceWrite" || method === "clientPersistenceRemove"
    || method === "clientPersistenceListKeys" || method === "clientPersistenceMigrate";
}

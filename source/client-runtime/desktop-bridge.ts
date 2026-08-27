import type { SandCapability } from "../shared/capabilities.js";
import { UnsupportedCapabilityError, unsupportedCapability } from "../shared/capabilities.js";
import { capabilityForMainMethod } from "../shared/capability-methods.js";
import { targetSupports, type SandPlatformTarget } from "../shared/platform-targets.js";
import { MAIN_METHOD_TABLE } from "../shared/rpc/main.js";
import { createChannelClient } from "./coordinator-client.js";
import type { Transport } from "./transport.js";

export const DESKTOP_BRIDGE_TOP_LEVEL_KEYS = [
  "resolveAttachmentMedia", "readAttachmentText", "readAttachmentBytes", "downloadAttachment",
  "getLinkMetadata", "openExternal", "openCloudAgent", "stageAttachmentBytes",
  "commitStagedAttachments", "discardStagedAttachment", "mcp", "forceGatewayReconnect",
  "pickAvatarSource", "pickAvatarFile", "generateAgentAvatarImage", "onFocusAgent",
  "onDeepLink", "deepLinksReady", "getBoxMigrationStatus", "onBoxMigration",
  "onDevBoxRebuild", "onOpenFeedback", "onOpenAbout", "submitFeedback", "onWidgetGallery",
  "onForceOnboarding", "transcribeAudio", "cursorAccount", "experiments", "platform", "isDev",
  "getWindowState", "onWindowStateEvent", "getZoomFactor", "onZoomFactorEvent", "windowControls",
  "foreverBox", "onboarding", "telemetry", "timeZone", "autoReviewInstructions",
  "localToolPermission", "theme", "secrets", "agent", "update", "devRestart", "attachProdBox",
] as const;

export type DesktopBridgeTopLevelKey = (typeof DESKTOP_BRIDGE_TOP_LEVEL_KEYS)[number];

export interface DesktopBridgeFactoryOptions {
  readonly transport: Transport;
  readonly target: SandPlatformTarget;
  readonly platform?: NodeJS.Platform;
  readonly isDev?: boolean;
  readonly zoomFactor?: () => number;
  readonly initialState?: {
    readonly experimentSnapshot?: unknown;
    readonly themeState?: unknown;
    readonly egressTunnelEnabled?: boolean;
    readonly webauthnProxyEnabled?: boolean;
    readonly egressTunnelStatus?: unknown;
  };
}

const noopUnsubscribe = (): (() => void) => () => {};

function nodePlatformForTarget(target: SandPlatformTarget): NodeJS.Platform {
  if (target.hostOs === "darwin" || target.hostOs === "win32" || target.hostOs === "linux") return target.hostOs;
  return "linux";
}

export function createDesktopBridge(options: DesktopBridgeFactoryOptions): Record<string, unknown> {
  const target = options.target;
  const rpc = createChannelClient(options.transport, "main");
  const call = async (method: string, args: unknown = {}): Promise<unknown> => {
    const capability = capabilityForMainMethod(method);
    if (capability != null && !targetSupports(target, capability)) {
      throw new UnsupportedCapabilityError(capability);
    }
    if (!Object.hasOwn(MAIN_METHOD_TABLE, method)) {
      throw new Error(`Unknown main method: ${method}`);
    }
    return rpc.request(method, args);
  };
  const gatedCall = (capability: SandCapability, method: string, args: unknown = {}): Promise<unknown> => {
    if (!targetSupports(target, capability)) return Promise.reject(new UnsupportedCapabilityError(capability));
    return call(method, args);
  };
  const subscribe = (family: string, listener: (payload: unknown) => void): () => void => rpc.subscribe(family, listener);
  const telemetry = (method: string) => (report: unknown) => { void call(method, report).catch(() => undefined); };
  const initial = options.initialState ?? {};
  const desktop: Record<string, unknown> = {
    capabilities: target.capabilities,
    targetId: target.id,
    resolveAttachmentMedia: (url: string) => call("resolveAttachmentMedia", { source: url }),
    readAttachmentText: (path: string) => call("readAttachmentText", { path }),
    readAttachmentBytes: (path: string, maxBytes: number) => call("readAttachmentBytes", { path, maxBytes }),
    downloadAttachment: (path: string, suggestedName?: string) => call("downloadAttachment", { path, suggestedName }),
    getLinkMetadata: (url: string) => call("getLinkMetadata", { url }),
    async openExternal(url: string) { await call("openExternal", { url }); },
    async openCloudAgent(bcId: string) { await call("openCloudAgent", { bcId }); },
    stageAttachmentBytes: (filename: string, bytes: Uint8Array) => call("stageAttachmentBytes", { filename, bytes }),
    commitStagedAttachments: (paths: readonly string[], filenames: readonly string[]) => call("commitStagedAttachments", { paths, filenames }),
    async discardStagedAttachment(path: string) { await call("discardStagedAttachment", { path }); },
    mcp: {
      list: () => gatedCall("mcp", "getMcpState"),
      effectivePlugins: () => gatedCall("mcp", "getEffectivePlugins"),
      catalog: () => gatedCall("mcp", "getMcpCatalog"),
      teamPopularity: () => gatedCall("mcp", "getMcpTeamPopularity"),
      pluginLogo: (url: string) => gatedCall("mcp", "getMcpPluginLogo", { url }),
      install: (request: unknown) => gatedCall("mcp", "installEntry", request),
      updatePluginInstall: (request: unknown) => gatedCall("mcp", "updatePluginInstall", request),
      remove: (serverId: string) => gatedCall("mcp", "removeMcpServer", { serverId }),
      uninstallPlugin: (pluginId: string) => gatedCall("mcp", "uninstallPlugin", { pluginId }),
      authenticate: (serverId: string, accountKey?: unknown, trigger?: unknown) => gatedCall("mcp", "authenticateMcpServer", {
        serverId,
        ...(accountKey != null ? { accountKey } : {}),
        ...(trigger != null ? { trigger } : {}),
      }),
      renameAccount: (args: unknown) => gatedCall("mcp", "renameMcpAccount", args),
      removeAccount: (args: unknown) => gatedCall("mcp", "removeMcpAccount", args),
      setCustomInstructions: (args: unknown) => gatedCall("mcp", "setMcpCustomInstructions", args),
      listServerTools: (serverId: string) => gatedCall("mcp", "listMcpServerTools", { serverId }),
      toggleToolDisabled: (args: unknown) => gatedCall("mcp", "toggleMcpToolDisabled", args),
      onAuthCompleted: (listener: (payload: unknown) => void) => subscribe("mcp-auth", listener),
    },
    async forceGatewayReconnect() { await gatedCall("remoteBox", "forceReconnectGateway"); },
    pickAvatarSource: () => call("pickAvatarSource"),
    pickAvatarFile: () => call("pickAvatarFile"),
    generateAgentAvatarImage: (description: string) => call("generateAgentAvatarImage", { description }),
    onFocusAgent: (listener: (payload: unknown) => void) => subscribe("focus-agent", listener),
    onDeepLink: (listener: (payload: unknown) => void) => subscribe("deep-link", listener),
    async deepLinksReady() { await call("markDeepLinksReady"); },
    getBoxMigrationStatus: () => gatedCall("remoteBox", "getBoxMigrationStatus"),
    onBoxMigration: (listener: (payload: unknown) => void) => subscribe("box-migration", listener),
    onDevBoxRebuild: (listener: (payload: unknown) => void) => subscribe("dev-box-rebuild", listener),
    onOpenFeedback: (listener: () => void) => subscribe("open-feedback", () => listener()),
    onOpenAbout: (listener: () => void) => subscribe("open-about", () => listener()),
    submitFeedback: (payload: unknown) => call("submitFeedback", payload),
    onWidgetGallery: (listener: (payload: unknown) => void) => subscribe("widget-gallery", listener),
    onForceOnboarding: (listener: () => void) => subscribe("force-onboarding", () => listener()),
    transcribeAudio: (audio: Uint8Array, mimeType: string, language?: string) => call("transcribeAudio", { audio, mimeType, language }),
    cursorAccount: {
      getStatus: () => gatedCall("auth", "getCursorAuthStatus"),
      login: () => gatedCall("auth", "loginCursor"),
      cancelLogin: () => gatedCall("auth", "cancelCursorLogin"),
      logout: () => gatedCall("auth", "logoutCursor"),
      updateName: (name: string) => gatedCall("auth", "updateCursorAccountName", { name }),
      getAvatar: () => gatedCall("auth", "getCursorAvatar"),
      getWeeklyUsage: () => gatedCall("auth", "getCursorWeeklyUsage"),
      getUsageSummary: () => gatedCall("auth", "getCursorUsageSummary"),
      getPrReviewPreferences: () => gatedCall("auth", "getCursorPrReviewPreferences"),
      getPrivacyModeEnabled: () => gatedCall("auth", "getCursorPrivacyModeEnabled"),
      getSandAccess: () => gatedCall("auth", "getSandAccess"),
      getSandAccessFresh: () => gatedCall("auth", "getSandAccessFresh"),
      invokeDashboardAction: (request: unknown) => gatedCall("auth", "invokeCursorDashboardAction", request),
      cancelTrial: () => gatedCall("auth", "cancelCursorSandTrial"),
      onStatusChanged: (listener: (payload: unknown) => void) => subscribe("cursor-auth-changed", listener),
    },
    experiments: {
      initialSnapshot: initial.experimentSnapshot ?? {},
      getSnapshot: () => call("getExperimentsSnapshot"),
      async applyFeatureFlagOverride(command: unknown) { await call("applyFeatureFlagOverride", { command }); },
      async refresh() { await call("refreshFeatureFlags"); },
      async startRpcTraceWindow() { return await call("startRpcTraceWindow") === true; },
      onChanged: (listener: (payload: unknown) => void) => subscribe("experiments-changed", listener),
    },
    platform: options.platform ?? nodePlatformForTarget(target),
    isDev: options.isDev === true,
    getWindowState: () => gatedCall("windowChrome", "getWindowState").catch(() => ({ isFullscreen: false, isMaximized: false })),
    onWindowStateEvent: (listener: (payload: unknown) => void) => subscribe("window-state", listener),
    getZoomFactor: () => options.zoomFactor?.() ?? 1,
    onZoomFactorEvent: (listener: (factor: number) => void) => subscribe("zoom-factor-changed", (payload) => {
      const factor = typeof payload === "object" && payload != null && "factor" in payload ? Number((payload as { factor: unknown }).factor) : Number(payload);
      if (Number.isFinite(factor)) listener(factor);
    }),
    windowControls: {
      async minimize() { await gatedCall("windowChrome", "minimizeWindow"); },
      async toggleMaximize() { await gatedCall("windowChrome", "toggleMaximizeWindow"); },
      async close() { await gatedCall("windowChrome", "closeWindow"); },
      async setTitleBarOverlayTone(isOverlayTone: boolean) { await gatedCall("windowChrome", "setTitleBarOverlayTone", { isOverlayTone }); },
      resizeWidth: (deltaWidth: number) => gatedCall("windowChrome", "resizeWindowWidth", { deltaWidth }),
    },
    foreverBox: {
      forceRecreate: () => gatedCall("remoteBox", "forceRecreateComputer"),
      update: (id: string, force = false) => gatedCall("remoteBox", "updateComputer", { id, force }),
      onVncUserPresence: (listener: (value: boolean) => void) => {
        if (!targetSupports(target, "vncComputer")) return noopUnsubscribe();
        return subscribe("vnc-user-presence", (payload) => listener((payload as { isPresent?: boolean })?.isPresent === true));
      },
      onDevBoxPullProgress: (listener: (payload: unknown) => void) => subscribe("dev-box-pull-progress", listener),
      egressTunnel: {
        initial: initial.egressTunnelEnabled === true,
        get: async () => await call("getEgressTunnelEnabled") === true,
        set: async (enabled: boolean) => await call("setEgressTunnelEnabled", { enabled }) === true,
        onChanged: (listener: (value: boolean) => void) => subscribe("egress-tunnel-changed", (enabled) => listener(enabled === true)),
        initialStatus: initial.egressTunnelStatus ?? null,
        getStatus: () => call("getEgressTunnelStatus"),
        onStatusChanged: (listener: (payload: unknown) => void) => subscribe("egress-tunnel-status-changed", listener),
      },
      webauthnProxy: {
        initial: initial.webauthnProxyEnabled === true,
        get: async () => await gatedCall("webauthnSigner", "getWebauthnProxyEnabled") === true,
        set: async (enabled: boolean) => await gatedCall("webauthnSigner", "setWebauthnProxyEnabled", { enabled }) === true,
        onChanged: (listener: (value: boolean) => void) => subscribe("webauthn-proxy-changed", (enabled) => listener(enabled === true)),
      },
    },
    onboarding: {
      getSeen: () => call("getOnboardingSeen"),
      async setSeen(seen: boolean) { await call("setOnboardingSeen", { seen }); },
      onSkip: (listener: () => void) => subscribe("skip-onboarding", () => listener()),
    },
    telemetry: {
      reportAgentLoad: telemetry("reportAgentLoad"),
      reportBoxVisibility: telemetry("reportBoxVisibility"),
      reportSendLatency: telemetry("reportSendLatency"),
      reportHeapMetrics: (report: unknown) => { void report; },
      reportSendAck: telemetry("reportSendAck"),
      reportReactionAck: telemetry("reportReactionAck"),
      reportRenderTtfr: telemetry("reportRenderTtfr"),
      reportRenderStream: telemetry("reportRenderStream"),
      reportAgentsUnreachable: telemetry("reportAgentsUnreachable"),
      reportAccessBlocked: telemetry("reportAccessBlocked"),
      reportRecoveryAction: telemetry("reportRecoveryAction"),
      reportRebuildLifecycle: telemetry("reportRebuildLifecycle"),
      reportReconciliation: telemetry("reportReconciliation"),
      reportVncSession: telemetry("reportVncSession"),
      reportVncLiveness: telemetry("reportVncLiveness"),
      reportOpenComputer: telemetry("reportOpenComputer"),
      reportUpdatePrompt: telemetry("reportUpdatePrompt"),
      reportSigninGate: telemetry("reportSigninGate"),
      reportOnboardingStep: telemetry("reportOnboardingStep"),
      reportClientFailure: telemetry("reportClientFailure"),
      noteSentryConversation: (report: unknown) => { void report; },
    },
    timeZone: {
      get: () => call("getTimeZone"),
      setOverride: (timeZone: string | null) => call("setTimeZoneOverride", { timeZone }),
    },
    autoReviewInstructions: {
      get: () => call("getAutoReviewInstructions"),
      set: (instructions: unknown) => call("setAutoReviewInstructions", { instructions }),
    },
    localToolPermission: {
      get: () => call("getLocalToolPermission"),
      set: (permission: unknown) => call("setLocalToolPermission", { permission }),
      ceiling: () => call("getLocalToolPermissionCeiling"),
      async recordApproval(approvalId: string, action: unknown, targetValue: unknown) { await call("recordLocalToolApproval", { approvalId, action, target: targetValue }); },
      async clearApprovals() { await call("clearLocalToolApprovals"); },
    },
    theme: {
      initial: initial.themeState ?? { preference: "system", resolved: "dark" },
      get: () => call("getThemeState"),
      set: (preference: unknown) => call("setThemePreference", { preference }),
      onChanged: (listener: (payload: unknown) => void) => subscribe("theme-changed", listener),
    },
    secrets: {
      list: () => gatedCall("secrets", "listSecrets"),
      reveal: (key: string) => gatedCall("secrets", "revealSecret", { key }),
      upsert: (entries: Record<string, string>) => gatedCall("secrets", "upsertSecrets", { entries }),
      remove: (keys: readonly string[]) => gatedCall("secrets", "removeSecrets", { keys }),
    },
    agent: {
      getPinnedAgents: () => call("getHostPinnedAgents"),
      setPinnedAgents: (pinnedAgentIds: readonly string[]) => call("setHostPinnedAgents", { pinnedAgentIds }),
      getSidebarSections: () => call("getHostSidebarSections"),
      setSidebarSections: (sections: readonly unknown[]) => call("setHostSidebarSections", { sections }),
      getDefaultModel: () => call("getAgentDefaultModel"),
      setDefaultModel: (model: unknown) => call("setAgentDefaultModel", { model }),
      getComputerUseModel: () => call("getComputerUseModel"),
      setComputerUseModel: (model: unknown) => call("setComputerUseModel", { model }),
      getAvailableModels: () => call("getAvailableModels"),
      getInferenceRouter: () => gatedCall("inferenceRouter", "getInferenceRouter"),
      setInferenceRouter: (provider: string) => gatedCall("inferenceRouter", "setInferenceRouter", { provider }),
      setInferenceEndpoints: (document: unknown) => gatedCall("inferenceRouter", "setInferenceEndpoints", { document }),
      getBoxRuntime: () => gatedCall("localDockerVm", "getBoxRuntime"),
      setBoxRuntime: (mode: string) => gatedCall("localDockerVm", "setBoxRuntime", { mode }),
      getSelfHostConnection: () => gatedCall("remoteBox", "getSelfHostConnection"),
      setSelfHostConnection: (connection: unknown) => gatedCall("remoteBox", "setSelfHostConnection", connection),
      getSelfHostInstallCommand: (params: unknown) => gatedCall("remoteBox", "getSelfHostInstallCommand", params),
      installSelfHostBox: (params: unknown) => gatedCall("remoteBox", "installSelfHostBox", params),
      testSelfHostGateway: (params: unknown) => gatedCall("remoteBox", "testSelfHostGateway", params),
      pickSelfHostKeyFile: () => gatedCall("remoteBox", "pickSelfHostKeyFile"),
      openSelfHostDocs: () => gatedCall("remoteBox", "openSelfHostDocs"),
      onSelfHostInstallProgress: (listener: (payload: unknown) => void) => subscribe("self-host-install", listener),
      clientPersistence: {
        read: (key: string) => call("clientPersistenceRead", { key }).catch(() => null),
        async write(key: string, value: string) { await call("clientPersistenceWrite", { key, value }).catch(() => undefined); },
        async remove(key: string) { await call("clientPersistenceRemove", { key }).catch(() => undefined); },
        listKeys: (prefix: string) => call("clientPersistenceListKeys", { prefix }).catch(() => []),
        migrateFromLocalStorage: (entries: readonly unknown[]) => call("clientPersistenceMigrate", { entries }).catch(() => false),
      },
    },
    update: {
      getStatus: () => call("getUpdateStatus"),
      check: () => call("checkForUpdates"),
      setTrack: (track: unknown) => call("setUpdateTrack", { track }),
      async quitAndInstall() { await call("quitAndInstallUpdate"); },
      setAutoUpdateWhenIdleOptIn: (enabled: boolean) => call("setAutoUpdateWhenIdleOptIn", { enabled }),
      onStatusEvent: (listener: (payload: unknown) => void) => subscribe("update-status", listener),
    },
    async devRestart() { throw new UnsupportedCapabilityError("windowChrome", "devRestart is a desktop-only control."); },
    attachProdBox: {
      getStatus: () => Promise.resolve({ enabled: false }),
      setEnabled: async () => unsupportedCapability("windowChrome", "attachProdBox is desktop-only."),
    },
  };
  return desktop;
}

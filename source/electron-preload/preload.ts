import { createDesktopBridge } from "../client-runtime/desktop-bridge.js";
import { detectHostPlatformTarget } from "../shared/platform-targets.js";
import {
  createCoordinatorPortBroker,
  wrapTransferredCoordinatorPort,
  type CoordinatorPortConsumer,
} from "./coordinator-port-bridge.js";
import { createElectronPreloadTransport } from "./ipc-session-transport.js";
import { MAIN_RPC_CONTRACT_NAME, MAIN_RPC_METHOD_TABLE } from "./main-rpc-runtime.js";
import { bridgeRpcEdge } from "./rpc-edge-runtime.js";

export interface PreloadIpcRenderer {
  invoke(channel: string, payload?: unknown): Promise<any>;
  sendSync(channel: string, payload?: unknown): any;
  send(channel: string, payload?: unknown): void;
  on(channel: string, listener: (event: any, payload?: any) => void): void;
  off(channel: string, listener: (event: any, payload?: any) => void): void;
}

export interface PreloadWebFrame { getZoomFactor(): number }
export interface PreloadContextBridge { exposeInMainWorld(name: string, value: unknown): void }
export type MainPreloadEdge = Record<string, (...args: any[]) => any> & {
  subscribe(handlers: Record<string, (payload: any) => void>): () => void;
};

export function createMainEdgeTransport(ipc: PreloadIpcRenderer): {
  invoke(channel: string, payload: unknown): Promise<any>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
} {
  return {
    invoke: (channel, payload) => ipc.invoke(channel, payload),
    on: (channel, listener) => {
      const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
      ipc.on(channel, wrapped);
      return () => ipc.off(channel, wrapped);
    },
  };
}

export const DESKTOP_TELEMETRY_CHANNELS = {
  reportAgentLoad: "sand:report-agent-load",
  reportBoxVisibility: "sand:report-box-visibility",
  reportSendLatency: "sand:report-send-latency",
  reportHeapMetrics: "sand:report-heap-metrics",
  reportSendAck: "sand:report-send-ack",
  reportReactionAck: "sand:report-reaction-ack",
  reportRenderTtfr: "sand:report-render-ttfr",
  reportRenderStream: "sand:report-render-stream",
  reportAgentsUnreachable: "sand:report-agents-unreachable",
  reportAccessBlocked: "sand:report-access-blocked",
  reportRecoveryAction: "sand:report-recovery-action",
  reportRebuildLifecycle: "sand:report-rebuild-lifecycle",
  reportReconciliation: "sand:report-reconciliation",
  reportVncSession: "sand:report-vnc-session",
  reportVncLiveness: "sand:report-vnc-liveness",
  reportOpenComputer: "sand:report-open-computer",
  reportUpdatePrompt: "sand:report-update-prompt",
  reportSigninGate: "sand:report-signin-gate",
  reportOnboardingStep: "sand:report-onboarding-step",
  reportClientFailure: "sand:report-client-failure",
  noteSentryConversation: "sand:sentry-conversation",
} as const;

export function createDesktopTelemetryBridge(ipc: PreloadIpcRenderer): Record<keyof typeof DESKTOP_TELEMETRY_CHANNELS, (report: unknown) => void> {
  return Object.fromEntries(Object.entries(DESKTOP_TELEMETRY_CHANNELS).map(([method, channel]) => [
    method,
    (report: unknown) => ipc.send(channel, report),
  ])) as Record<keyof typeof DESKTOP_TELEMETRY_CHANNELS, (report: unknown) => void>;
}

export interface PrimaryPreloadInitialState {
  readonly experimentSnapshot: unknown;
  readonly themeState: unknown;
  readonly egressTunnelEnabled: boolean;
  readonly webauthnProxyEnabled: boolean;
  readonly egressTunnelStatus: unknown;
}

export function readPrimaryPreloadInitialState(ipc: PreloadIpcRenderer): PrimaryPreloadInitialState {
  return {
    experimentSnapshot: ipc.sendSync("sand:experiments-snapshot-sync"),
    themeState: ipc.sendSync("sand:theme-get-sync"),
    egressTunnelEnabled: ipc.sendSync("sand:egress-tunnel-get-sync") === true,
    webauthnProxyEnabled: ipc.sendSync("sand:webauthn-proxy-get-sync") === true,
    egressTunnelStatus: ipc.sendSync("sand:egress-tunnel-status-get-sync"),
  };
}

function hasDevRestart(env: NodeJS.ProcessEnv): boolean {
  return env.SAND_RESTART_EXIT_CODE != null && env.SAND_RESTART_EXIT_CODE.length > 0;
}

export function createDesktopPreloadBridge(options: {
  readonly ipc: PreloadIpcRenderer;
  readonly webFrame: PreloadWebFrame;
  readonly mainEdge: MainPreloadEdge;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly initialState?: PrimaryPreloadInitialState;
  readonly devRestartEnabled?: boolean;
}): Record<string, any> {
  const env = options.env ?? process.env;
  const isDevRestartEnabled = options.devRestartEnabled ?? hasDevRestart(env);
  const initialState = options.initialState ?? readPrimaryPreloadInitialState(options.ipc);
  const transport = createElectronPreloadTransport({ ipc: options.ipc, mainEdge: options.mainEdge });
  const desktop = createDesktopBridge({
    transport,
    target: detectHostPlatformTarget(options.platform ?? process.platform, process.arch, env),
    platform: options.platform ?? process.platform,
    isDev: isDevRestartEnabled,
    zoomFactor: () => options.webFrame.getZoomFactor(),
    initialState,
  });
  if (isDevRestartEnabled) {
    desktop.devRestart = async () => { await options.ipc.invoke("sand:dev-restart"); };
  }
  desktop.attachProdBox = {
    getStatus: () => options.ipc.invoke("sand:attach-prod-box-status"),
    setEnabled: (enabled: boolean, attachOptions?: { readonly isRestartMainApp?: boolean }) => options.ipc.invoke("sand:attach-prod-box-set-enabled", {
      enabled,
      isRestartMainApp: attachOptions?.isRestartMainApp,
    }),
  };
  return desktop;
}

export function installPrimaryPreload(options: {
  readonly ipc: PreloadIpcRenderer;
  readonly webFrame: PreloadWebFrame;
  readonly contextBridge: PreloadContextBridge;
  readonly mainEdge: MainPreloadEdge;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly initialState?: PrimaryPreloadInitialState;
  readonly devRestartEnabled?: boolean;
  readonly coordinatorBroker?: ReturnType<typeof createCoordinatorPortBroker<any>>;
}): { readonly desktop: Record<string, any>; readonly coordinatorPort: { claim(consumer: CoordinatorPortConsumer<any>): any } } {
  const env = options.env ?? process.env;
  const devRestartEnabled = options.devRestartEnabled ?? hasDevRestart(env);
  const initialState = options.initialState ?? readPrimaryPreloadInitialState(options.ipc);
  const broker = options.coordinatorBroker ?? createCoordinatorPortBroker<any>({ invokeRequest: () => { void options.ipc.invoke("sand:coordinator-port-request"); } });
  const desktop = createDesktopPreloadBridge({ ...options, env, devRestartEnabled, initialState });
  options.contextBridge.exposeInMainWorld("desktop", desktop);
  options.contextBridge.exposeInMainWorld("coordinatorPort", broker.bridge);
  options.ipc.on("sand:coordinator-port", (event: { readonly ports: readonly any[] }) => {
    const port = event.ports[0];
    if (port != null) broker.deliver(wrapTransferredCoordinatorPort(port));
  });
  return { desktop, coordinatorPort: broker.bridge };
}

export interface PrimaryPreloadElectronRuntime {
  readonly ipcRenderer: PreloadIpcRenderer;
  readonly webFrame: PreloadWebFrame;
  readonly contextBridge: PreloadContextBridge;
}

export function installPrimaryPreloadEntrypoint(
  electron: PrimaryPreloadElectronRuntime,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof installPrimaryPreload> {
  const devRestartEnabled = hasDevRestart(env);
  const initialState = readPrimaryPreloadInitialState(electron.ipcRenderer);
  const coordinatorBroker = createCoordinatorPortBroker<any>({ invokeRequest: () => { void electron.ipcRenderer.invoke("sand:coordinator-port-request"); } });
  const transport = createMainEdgeTransport(electron.ipcRenderer);
  const mainEdge = bridgeRpcEdge(MAIN_RPC_CONTRACT_NAME, MAIN_RPC_METHOD_TABLE, transport, true) as MainPreloadEdge;
  return installPrimaryPreload({
    ipc: electron.ipcRenderer,
    webFrame: electron.webFrame,
    contextBridge: electron.contextBridge,
    mainEdge,
    platform: process.platform,
    env,
    initialState,
    devRestartEnabled,
    coordinatorBroker,
  });
}

export function loadPrimaryPreloadElectron(
  electronModule: unknown,
): PrimaryPreloadElectronRuntime {
  const runtime = electronModule as Partial<PrimaryPreloadElectronRuntime> | null;
  if (runtime == null || typeof runtime !== "object") throw new Error("electron preload bindings are unavailable");
  const ipc = runtime.ipcRenderer as Partial<PreloadIpcRenderer> | null | undefined;
  const frame = runtime.webFrame as Partial<PreloadWebFrame> | null | undefined;
  const bridge = runtime.contextBridge as Partial<PreloadContextBridge> | null | undefined;
  if (ipc == null || typeof ipc.invoke !== "function" || typeof ipc.sendSync !== "function" || typeof ipc.send !== "function"
    || typeof ipc.on !== "function" || typeof ipc.off !== "function" || frame == null || typeof frame.getZoomFactor !== "function"
    || bridge == null || typeof bridge.exposeInMainWorld !== "function") {
    throw new Error("electron preload bindings are unavailable");
  }
  return runtime as PrimaryPreloadElectronRuntime;
}

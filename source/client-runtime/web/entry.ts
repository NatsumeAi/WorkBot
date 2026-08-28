import { createDesktopBridge, createSandStageAttachment } from "../desktop-bridge.js";
import { createCoordinatorPortFromTransport } from "../coordinator-client.js";
import { createCoordinatorPortBroker } from "../../electron-preload/coordinator-port-bridge.js";
import { ANDROID_PLATFORM_TARGET } from "../../../targets/android/src/desktop-shell.js";
import { isAndroidShell, sandNative } from "./sand-native.js";
import { browserStorage } from "./stores.js";
import { createWebCoordinator } from "./web-coordinator.js";
import { createWebMainTransport } from "./web-main-transport.js";
import { parseSelfHostGatewayAddress } from "../../shared/self-host-address.js";

/**
 * In-page replacement for the Electron preload: exposes the same
 * `window.desktop` and `window.coordinatorPort` contracts to the same UI.
 * Desktop gets them from the preload over IPC; the Android WebView gets them
 * here, with every network call pointed at the local forwarder origin.
 */

export function installWebRuntime({ baseUrl }: { readonly baseUrl?: string } = {}): void {
  if (window.desktop != null || window.coordinatorPort != null) return;
  if (!isAndroidShell() && baseUrl == null) return;

  const resolveBaseUrl = (): string => baseUrl ?? location.origin;
  const storage = browserStorage();

  const coordinator = createWebCoordinator({ resolveBaseUrl });

  const mainTransport = createWebMainTransport({
    storage,
    gateway: coordinator.gateway,
    restartGateway: () => { void coordinator.forceReconnect(); },
    events: { postEvent: () => {} },
  });

  const desktop = createDesktopBridge({
    transport: mainTransport,
    target: ANDROID_PLATFORM_TARGET,
    initialState: {
      experimentSnapshot: {},
      themeState: { preference: "system", resolved: "dark" },
      egressTunnelEnabled: false,
      webauthnProxyEnabled: false,
      egressTunnelStatus: null,
    },
  });

  const coordinatorBroker = createCoordinatorPortBroker<ReturnType<typeof createCoordinatorPortFromTransport>>({
    invokeRequest: () => {
      window.setTimeout(() => {
        coordinatorBroker.deliver(createCoordinatorPortFromTransport(coordinator.transport));
      }, 0);
    },
  });

  window.desktop = desktop;
  window.sandStageAttachment = createSandStageAttachment(desktop as Record<string, unknown>);
  window.coordinatorPort = coordinatorBroker.bridge;

  const agent = desktop.agent as { setSelfHostConnection?: (connection: unknown) => Promise<unknown> };
  const previousSet = agent.setSelfHostConnection?.bind(agent);
  if (previousSet != null) {
    agent.setSelfHostConnection = async (connection: unknown) => {
      const result = await previousSet(connection);
      syncConnectCover();
      return result;
    };
  }

  installMobileChromeOverrides();
  syncConnectCover();
}

function syncConnectCover(): void {
  const native = sandNative();
  if (native == null) return;
  const url = (native.getPref?.("boxBaseUrl") ?? "").replace(/\/+$/, "");
  const hasToken = native.hasGatewayToken?.() === true;
  if (url.length === 0 && !hasToken) document.documentElement.dataset.sandNeedsConnect = "1";
  else delete document.documentElement.dataset.sandNeedsConnect;
}

function installMobileChromeOverrides(): void {
  const native = sandNative();
  if (native == null) return;
  document.documentElement.dataset.sandMobile = "1";
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/client-overrides/mobile.css";
  document.head.appendChild(link);
}

export { parseSelfHostGatewayAddress };

installWebRuntime();

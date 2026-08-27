import { CLIENT_PERSISTENCE_CHANNELS } from "../shared/persistence.js";
import { MAIN_METHOD_TABLE } from "../shared/rpc/main.js";
import type { SessionMessage } from "../shared/session-protocol.js";
import type { Transport } from "../client-runtime/transport.js";

export interface PreloadIpcRenderer {
  invoke(channel: string, payload?: unknown): Promise<any>;
}

export type MainPreloadEdge = Record<string, (...args: any[]) => any> & {
  subscribe(handlers: Record<string, (payload: any) => void>): () => void;
};

const MAIN_EVENTS = [
  "box-migration", "cursor-auth-changed", "deep-link", "dev-box-pull-progress", "dev-box-rebuild",
  "egress-tunnel-changed", "egress-tunnel-status-changed", "experiments-changed", "focus-agent", "force-onboarding",
  "open-about", "open-feedback", "skip-onboarding", "theme-changed", "update-status", "vnc-user-presence",
  "window-state", "webauthn-proxy-changed", "zoom-factor-changed", "mcp-auth", "widget-gallery",
] as const;

function ipcFallback(ipc: PreloadIpcRenderer, method: string, args: unknown): Promise<unknown> | null {
  const record = typeof args === "object" && args != null ? args as Record<string, unknown> : {};
  switch (method) {
    case "listSecrets": return ipc.invoke("sand:secrets-list");
    case "revealSecret": return ipc.invoke("sand:secrets-reveal", { key: record.key });
    case "upsertSecrets": return ipc.invoke("sand:secrets-upsert", { entries: record.entries });
    case "removeSecrets": return ipc.invoke("sand:secrets-delete", { keys: record.keys });
    case "getMcpState": return ipc.invoke("sand:mcp-list");
    case "getEffectivePlugins": return ipc.invoke("sand:mcp-effective-plugins");
    case "getMcpCatalog": return ipc.invoke("sand:mcp-catalog");
    case "getMcpTeamPopularity": return ipc.invoke("sand:mcp-team-popularity");
    case "getMcpPluginLogo": return ipc.invoke("sand:mcp-plugin-logo", { url: record.url });
    case "installEntry": return ipc.invoke("sand:mcp-install", args);
    case "updatePluginInstall": return ipc.invoke("sand:mcp-update-plugin-install", args);
    case "removeMcpServer": return ipc.invoke("sand:mcp-remove", { serverId: record.serverId });
    case "uninstallPlugin": return ipc.invoke("sand:mcp-uninstall-plugin", { pluginId: record.pluginId });
    case "authenticateMcpServer": return ipc.invoke("sand:mcp-auth", args);
    case "renameMcpAccount": return ipc.invoke("sand:mcp-rename-account", args);
    case "removeMcpAccount": return ipc.invoke("sand:mcp-remove-account", args);
    case "setMcpCustomInstructions": return ipc.invoke("sand:mcp-set-instructions", args);
    case "listMcpServerTools": return ipc.invoke("sand:mcp-list-server-tools", { serverId: record.serverId });
    case "toggleMcpToolDisabled": return ipc.invoke("sand:mcp-toggle-tool-disabled", args);
    case "clientPersistenceRead": return ipc.invoke(CLIENT_PERSISTENCE_CHANNELS.read, { key: record.key });
    case "clientPersistenceWrite": return ipc.invoke(CLIENT_PERSISTENCE_CHANNELS.write, { key: record.key, value: record.value });
    case "clientPersistenceRemove": return ipc.invoke(CLIENT_PERSISTENCE_CHANNELS.remove, { key: record.key });
    case "clientPersistenceListKeys": return ipc.invoke(CLIENT_PERSISTENCE_CHANNELS.listKeys, { prefix: record.prefix });
    case "clientPersistenceMigrate": return ipc.invoke(CLIENT_PERSISTENCE_CHANNELS.migrate, { entries: record.entries });
    default: return null;
  }
}

export function createElectronPreloadTransport(options: {
  readonly ipc: PreloadIpcRenderer;
  readonly mainEdge: MainPreloadEdge;
}): Transport {
  const listeners = new Set<(message: SessionMessage) => void>();
  const emit = (message: SessionMessage): void => { for (const listener of listeners) listener(message); };
  const unsubEvents = options.mainEdge.subscribe(Object.fromEntries(MAIN_EVENTS.map((event) => [
    event,
    (payload: unknown) => emit({ channel: "main", frame: { kind: "event", family: event, payload } }),
  ])));
  return {
    post(message) {
      if (message.channel !== "main" || message.frame.kind !== "request") return;
      const { requestId, method, args } = message.frame;
      const fallback = ipcFallback(options.ipc, method, args);
      const invoke = fallback ?? (Object.hasOwn(MAIN_METHOD_TABLE, method)
        ? MAIN_METHOD_TABLE[method as keyof typeof MAIN_METHOD_TABLE].args === "none"
          ? options.mainEdge[method]!()
          : options.mainEdge[method]!(args)
        : Promise.reject(new Error(`Unknown main method: ${method}`)));
      void Promise.resolve(invoke).then(
        (value) => emit({ channel: "main", frame: { kind: "reply", requestId, outcome: { status: "ok", value } } }),
        (error) => emit({
          channel: "main",
          frame: {
            kind: "reply",
            requestId,
            outcome: { status: "failed", failure: { code: "handler-failed", message: error instanceof Error ? error.message : String(error) } },
          },
        }),
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      unsubEvents();
      listeners.clear();
    },
  };
}

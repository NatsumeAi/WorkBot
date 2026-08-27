import type { SessionMessage } from "../shared/session-protocol.js";
import type { Transport } from "./transport.js";

export function createMemoryTransportPair(): { readonly client: Transport; readonly server: Transport } {
  const clientListeners = new Set<(message: SessionMessage) => void>();
  const serverListeners = new Set<(message: SessionMessage) => void>();
  const client: Transport = {
    post(message) {
      for (const listener of serverListeners) listener(message);
    },
    subscribe(listener) {
      clientListeners.add(listener);
      return () => { clientListeners.delete(listener); };
    },
    close() { clientListeners.clear(); },
  };
  const server: Transport = {
    post(message) {
      for (const listener of clientListeners) listener(message);
    },
    subscribe(listener) {
      serverListeners.add(listener);
      return () => { serverListeners.delete(listener); };
    },
    close() { serverListeners.clear(); },
  };
  return { client, server };
}

import { parseSessionMessage, type SessionMessage } from "../shared/session-protocol.js";
import type { Transport } from "./transport.js";

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
}

export function createWebSocketTransport(socket: WebSocketLike): Transport {
  const listeners = new Set<(message: SessionMessage) => void>();
  socket.addEventListener("message", (event) => {
    let value: unknown = event.data;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return; }
    }
    const parsed = parseSessionMessage(value);
    if (parsed == null) return;
    for (const listener of listeners) listener(parsed);
  });
  return {
    post(message) { socket.send(JSON.stringify(message)); },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      listeners.clear();
      socket.close();
    },
  };
}

export function connectWebSocketTransport(url: string, openSocket: (href: string) => WebSocketLike = defaultSocket): Transport {
  return createWebSocketTransport(openSocket(url));
}

function defaultSocket(url: string): WebSocketLike {
  if (typeof WebSocket === "undefined") throw new Error("WebSocket is unavailable in this runtime.");
  return new WebSocket(url);
}

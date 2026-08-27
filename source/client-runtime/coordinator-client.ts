import {
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorFrame,
} from "../shared/rpc/coordinator-port.js";
import { parseSessionMessage, type SessionChannel } from "../shared/session-protocol.js";
import { UnsupportedCapabilityError } from "../shared/capabilities.js";
import type { Transport } from "./transport.js";

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `r-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type Pending = {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};

export class SessionRpcError extends Error {
  constructor(readonly code: string, message: string, readonly transportKind?: string) {
    super(message);
    this.name = "SessionRpcError";
  }
}

export function createChannelClient(transport: Transport, channel: SessionChannel) {
  const pending = new Map<string, Pending>();
  const events = new Map<string, Set<(payload: unknown) => void>>();
  const unsubscribe = transport.subscribe((message) => {
    if (message.channel !== channel) return;
    const frame = message.frame;
    if (frame.kind === "reply") {
      const waiter = pending.get(frame.requestId);
      if (waiter == null) return;
      pending.delete(frame.requestId);
      if (frame.outcome.status === "ok") waiter.resolve(frame.outcome.value);
      else {
        const failure = frame.outcome.failure;
        if (failure.code === "unsupported-capability") {
          const capability = /[Cc]apability ([a-zA-Z]+)/.exec(failure.message)?.[1];
          waiter.reject(new UnsupportedCapabilityError((capability as any) ?? "conversation", failure.message));
        } else {
          waiter.reject(new SessionRpcError(failure.code, failure.message, failure.transportKind));
        }
      }
      return;
    }
    if (frame.kind === "event") {
      const listeners = events.get(frame.family);
      if (listeners != null) for (const listener of listeners) listener(frame.payload);
    }
  });

  return {
    async request(method: string, args: unknown = {}): Promise<unknown> {
      const id = requestId();
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
      });
      transport.post({ channel, frame: { kind: "request", requestId: id, method, args } });
      return result;
    },
    subscribe(family: string, listener: (payload: unknown) => void): () => void {
      const listeners = events.get(family) ?? new Set<(payload: unknown) => void>();
      listeners.add(listener);
      events.set(family, listeners);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      unsubscribe();
      pending.clear();
      events.clear();
    },
  };
}

export async function handshakeCoordinator(transport: Transport): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timeout = setTimeout(() => reject(new Error("Coordinator handshake timed out.")), 10_000);
  const unsubscribe = transport.subscribe((message) => {
    if (message.channel !== "coordinator") return;
    if (message.frame.kind === "lifecycle" && message.frame.phase === "ready") {
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    }
  });
  transport.post({
    channel: "coordinator",
    frame: { kind: "lifecycle", phase: "hello", protocolVersion: COORDINATOR_PROTOCOL_VERSION },
  });
  await promise;
}

export function createCoordinatorClient(transport: Transport) {
  const rpc = createChannelClient(transport, "coordinator");
  let ready: Promise<void> | null = null;
  const ensure = () => {
    ready ??= handshakeCoordinator(transport);
    return ready;
  };
  return {
    async request(method: string, args: unknown = {}): Promise<unknown> {
      await ensure();
      return rpc.request(method, args);
    },
    subscribe(family: string, listener: (payload: unknown) => void): () => void {
      void ensure();
      return rpc.subscribe(family, listener);
    },
    dispose() { rpc.dispose(); },
  };
}

export function createCoordinatorPortFromTransport(transport: Transport): {
  postMessage(message: unknown): void;
  close(): void;
  start(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: Record<string, never>) => void): void;
} {
  const messageListeners = new Set<(event: { data: unknown }) => void>();
  const closeListeners = new Set<(event: Record<string, never>) => void>();
  const unsubscribe = transport.subscribe((message) => {
    if (message.channel !== "coordinator") return;
    for (const listener of messageListeners) listener({ data: message.frame });
  });
  return {
    postMessage(message) {
      const parsed = parseSessionMessage({ channel: "coordinator", frame: message })
        ?? (isCoordinatorFrame(message) ? { channel: "coordinator" as const, frame: message } : null);
      if (parsed != null) transport.post(parsed);
    },
    close() {
      unsubscribe();
      for (const listener of closeListeners) listener({});
    },
    start() {},
    addEventListener(type, listener) {
      if (type === "message") messageListeners.add(listener as (event: { data: unknown }) => void);
      else closeListeners.add(listener as (event: Record<string, never>) => void);
    },
  };
}

function isCoordinatorFrame(value: unknown): value is CoordinatorFrame {
  return typeof value === "object" && value != null && "kind" in value;
}

export function createCoordinatorPortBridgeFromTransport(transport: Transport) {
  let owner: { onPort(port: ReturnType<typeof createCoordinatorPortFromTransport>): void } | null = null;
  return {
    claim(consumer: { onPort(port: ReturnType<typeof createCoordinatorPortFromTransport>): void }) {
      if (owner != null) return null;
      owner = consumer;
      return {
        request() {
          consumer.onPort(createCoordinatorPortFromTransport(transport));
        },
        release() {
          if (owner === consumer) owner = null;
        },
      };
    },
  };
}

export type { SessionMessage } from "../shared/session-protocol.js";

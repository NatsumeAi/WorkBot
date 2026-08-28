import { parseSessionMessage, type SessionMessage } from "../../shared/session-protocol.js";
import { EdgeCallFailure } from "../../electron-main/main-edge.js";
import { UnsupportedCapabilityError } from "../../shared/capabilities.js";
import type { Transport } from "../transport.js";
import { createWebMainEdgeDeps, createWebMainEdgeHandlers, createWebMainFallbacks, isWebMainFallbackMethod, type WebMainEdgeDepsOptions } from "./web-main-edge.js";
import type { WebStorage } from "./stores.js";

/**
 * Serves the renderer's `main` session channel in-page: the same request /
 * reply / event frames the Electron main edge serves, with desktop-only
 * backends swapped for web ones. Secrets and client persistence ride the same
 * hand-wired fallback paths as desktop's dedicated IPC channels.
 */

export interface WebMainTransportOptions extends WebMainEdgeDepsOptions {
  readonly storage: WebStorage;
}

export type MainEdgeFailure = { readonly code: string; readonly message: string };

function failureFrom(error: unknown): MainEdgeFailure {
  if (error instanceof EdgeCallFailure) return { code: error.code, message: error.message };
  if (error instanceof UnsupportedCapabilityError) return { code: "unsupported-capability", message: error.message };
  return { code: "handler-failed", message: error instanceof Error ? error.message : String(error) };
}

export function createWebMainTransport(options: WebMainTransportOptions): Transport {
  const listeners = new Set<(message: SessionMessage) => void>();
  const emit = (message: SessionMessage): void => { for (const listener of [...listeners]) listener(message); };
  const deps = createWebMainEdgeDeps(options);
  const handlers = createWebMainEdgeHandlers(deps);
  const fallbacks = createWebMainFallbacks(options.storage);

  const dispatch = async (method: string, args: unknown): Promise<unknown> => {
    if (isWebMainFallbackMethod(method)) return await (fallbacks[method] as (request: unknown) => Promise<unknown>)(args);
    const handler = (handlers as Record<string, ((request: unknown) => unknown) | undefined>)[method];
    if (handler == null) throw new EdgeCallFailure({ code: "edge/unknown-method", detail: `The main edge does not serve ${method}.` });
    return await handler(args);
  };

  return {
    post(message) {
      const parsed = parseSessionMessage(message);
      if (parsed == null || parsed.channel !== "main" || parsed.frame.kind !== "request") return;
      const { requestId, method, args } = parsed.frame;
      void dispatch(method, args).then(
        value => emit({ channel: "main", frame: { kind: "reply", requestId, outcome: { status: "ok", value } } }),
        error => emit({ channel: "main", frame: { kind: "reply", requestId, outcome: { status: "failed", failure: failureFrom(error) } } }),
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() { listeners.clear(); },
  };
}

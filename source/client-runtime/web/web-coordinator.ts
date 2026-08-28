import { COORDINATOR_TRANSPORT_STATE_FAMILY } from "../../shared/rpc/coordinator-port.js";
import { ClientSideToolV2Relay } from "../../node-agent-coordinator/client-side-tool-v2-relay.js";
import { CoordinatorGatewayClient, createCoordinatorGatewayClientTiming, type GatewayConnection } from "../../node-agent-coordinator/gateway/gateway-client.js";
import { coordinatorEventFamilyForSseChannel } from "../../node-agent-coordinator/gateway/gateway-event-families.js";
import { createGatewayRequestDispatch } from "../../node-agent-coordinator/gateway/gateway-request-dispatcher.js";
import { createRendererPortServer } from "../../node-agent-coordinator/renderer-port-server.js";
import { parseSessionMessage, type SessionMessage } from "../../shared/session-protocol.js";
import type { Transport } from "../transport.js";

/**
 * The desktop runs this coordinator composition in a Node child process; the
 * phone runs the same TypeScript in the page with the network base pointed at
 * the on-device forwarder (location.origin). The forwarder adds the gateway
 * token natively, so the page connects tokenless — the box never sees a
 * browser origin and the page never sees the token.
 */

export interface WebCoordinatorOptions {
  /** Base URL for every gateway call; on Android this is the forwarder origin. */
  readonly resolveBaseUrl: () => string;
}

export interface WebCoordinator {
  /** The renderer-facing coordinator channel transport. */
  readonly transport: Transport;
  /** Shared gateway client; box-backed main-edge legs ride the same session. */
  readonly gateway: CoordinatorGatewayClient;
  readonly forceReconnect: () => Promise<void>;
}

export function createWebCoordinator(options: WebCoordinatorOptions): WebCoordinator {
  const listeners = new Set<(message: SessionMessage) => void>();
  const emit = (message: SessionMessage): void => { for (const listener of [...listeners]) listener(message); };
  const postEvent = (family: string, payload: unknown): void => { emit({ channel: "coordinator", frame: { kind: "event", family, payload } }); };

  let server: ReturnType<typeof createRendererPortServer>;
  const toolRelay = new ClientSideToolV2Relay((family, payload) => server.postEvent(family, payload));
  let isGatewayStreamLive = false;

  const handleGatewaySseEvent = (event: { channel: string; payload: unknown }): void => {
    if (event.channel === "client-side-tool-v2") { toolRelay.accept(event.payload); return; }
    if (event.channel === "agents") postEvent("agents-event", { kind: "agents", event: event.payload });
    if (event.channel === "agent-upserted") postEvent("agents-event", { kind: "agent-upserted", event: event.payload });
    const family = coordinatorEventFamilyForSseChannel(event.channel);
    if (family != null) postEvent(family, event.payload);
  };

  const handleTransportEvent = (raw: unknown): void => {
    if (typeof raw !== "object" || raw == null) return;
    const event = raw as { family: string };
    if (event.family === "transport-down") {
      isGatewayStreamLive = false;
      postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "down" });
      return;
    }
    isGatewayStreamLive = true;
    postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "connected" });
  };

  const gatewayClient = new CoordinatorGatewayClient({
    resolveConnection: async () => await Promise.resolve({ baseUrl: options.resolveBaseUrl(), token: null } satisfies GatewayConnection),
    onEvent: handleGatewaySseEvent,
    onTransportEvent: handleTransportEvent,
    timing: createCoordinatorGatewayClientTiming(),
  });

  const dispatchRequest = createGatewayRequestDispatch(gatewayClient);

  server = createRendererPortServer(
    { post: frame => emit({ channel: "coordinator", frame }), close: () => {} },
    {
      dispatchRequest: (method, args, signal) => dispatchRequest(method, args, signal),
      onServing: () => {
        toolRelay.replay();
        if (!isGatewayStreamLive) postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "down" });
      },
    },
  );
  gatewayClient.start();

  return {
    transport: {
      post(message) {
        const parsed = parseSessionMessage(message);
        if (parsed == null || parsed.channel !== "coordinator") return;
        const frame = parsed.frame;
        if (frame.kind === "request" || frame.kind === "lifecycle" || frame.kind === "cancel") server.handleMessage(frame);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      close() {
        listeners.clear();
        gatewayClient.close();
      },
    },
    gateway: gatewayClient,
    forceReconnect: () => gatewayClient.forceReconnect(),
  };
}

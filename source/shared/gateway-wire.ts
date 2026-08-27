export const GATEWAY_API_PREFIX = "/api";
export const GATEWAY_EVENTS_PATH = "/events";
export const GATEWAY_HEALTH_PATH = "/health";
export const GATEWAY_AUTH_SCHEME = "Bearer";
/** Node fetch otherwise advertises gzip and the gateway will compress a long-lived SSE stream until it dies. */
export const GATEWAY_SSE_ACCEPT_HEADERS = {
  accept: "text/event-stream",
  "accept-encoding": "identity",
} as const;
export const GATEWAY_SLIM_AVATARS_HEADER = "x-sand-slim-avatars";
export const GATEWAY_MINT_DEDUPE_HEADER = "x-sand-mint-dedupe";
export const GATEWAY_TRACEPARENT_HEADER = "traceparent";
export const GATEWAY_AVATARS_PATH = "/avatars";
export const GATEWAY_NETWORK_TOKEN_HEADER = "x-anyrun-network-token";

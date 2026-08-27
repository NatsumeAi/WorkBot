import {
  COORDINATOR_PROTOCOL_VERSION,
  parseCoordinatorFrame,
  type CoordinatorFrame,
} from "./rpc/coordinator-port.js";

export const SESSION_CHANNELS = ["main", "coordinator"] as const;
export type SessionChannel = (typeof SESSION_CHANNELS)[number];

export interface SessionMessage {
  readonly channel: SessionChannel;
  readonly frame: CoordinatorFrame;
}

export const SESSION_PROTOCOL_VERSION = COORDINATOR_PROTOCOL_VERSION;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

export function parseSessionMessage(value: unknown): SessionMessage | null {
  if (!isRecord(value) || (value.channel !== "main" && value.channel !== "coordinator")) return null;
  const parsed = parseCoordinatorFrame(value.frame);
  return parsed.accepted ? { channel: value.channel, frame: parsed.frame } : null;
}

export function sessionRequest(channel: SessionChannel, requestId: string, method: string, args: unknown): SessionMessage {
  return { channel, frame: { kind: "request", requestId, method, args } };
}

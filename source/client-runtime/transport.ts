import type { SessionMessage } from "../shared/session-protocol.js";

export interface Transport {
  post(message: SessionMessage): void;
  subscribe(listener: (message: SessionMessage) => void): () => void;
  close(): void;
}

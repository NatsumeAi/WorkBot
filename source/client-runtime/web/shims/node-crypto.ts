export const webcrypto = globalThis.crypto;

export function randomUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `r-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default { randomUUID, webcrypto };

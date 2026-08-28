function decodeBase64Bytes(value: string): Uint8Array | null {
  if (value.length === 0) return new Uint8Array(0);
  const padded = value.length % 4 === 0 ? value : `${value}${"=".repeat(4 - (value.length % 4))}`;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) return null;
  try {
    if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
      const buffer = Buffer.from(padded, "base64");
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    const binary = globalThis.atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

const BASE64_CHUNK = 32_768;

/** Encode in the isolated world / preload so contextBridge never has to clone a TypedArray. */
export function encodeAttachmentBytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    const slice = bytes.subarray(offset, offset + BASE64_CHUNK);
    for (let index = 0; index < slice.length; index += 1) binary += String.fromCharCode(slice[index]!);
  }
  return globalThis.btoa(binary);
}

/** Reconstruct file bytes after contextBridge / IPC structured clone. */
export function coerceAttachmentBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return decodeBase64Bytes(value);
  if (Array.isArray(value)) {
    if (!value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) return null;
    return Uint8Array.from(value);
  }
  if (typeof value !== "object" || value == null) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "Buffer" && Array.isArray(record.data)) return coerceAttachmentBytes(record.data);
  if (typeof record.bytesBase64 === "string") return coerceAttachmentBytes(record.bytesBase64);
  const keys = Object.keys(record);
  if (keys.length === 0 || !keys.every((key) => /^\d+$/.test(key))) return null;
  const max = keys.reduce((highest, key) => Math.max(highest, Number(key)), -1);
  const numbers = Array.from({ length: max + 1 }, (_, index) => record[String(index)]);
  return coerceAttachmentBytes(numbers);
}

/** File.name on Windows Electron/drag-drop is sometimes `C:\\Users\\...\\photo.png`. */
export function normalizeAttachmentFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const segments = trimmed.split(/[/\\]+/).filter((part) => part.length > 0);
  const base = segments[segments.length - 1] ?? "";
  if (base.length === 0 || base.length > 255 || base.includes("\0") || base === "." || base === "..") return null;
  return base;
}

function isBlankClone(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  if (Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  const record = value as Record<string, unknown>;
  if (record.type === "Buffer" && Array.isArray(record.data)) return false;
  if (typeof record.bytesBase64 === "string" || record.bytes != null) return false;
  return Object.keys(record).length === 0;
}

function isStageRequestObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value) || ArrayBuffer.isView(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.filename === "string"
    || typeof record.name === "string"
    || typeof record.bytesBase64 === "string"
    || record.bytes != null;
}

function unwrapStageRequest(record: Record<string, unknown>): { filename: unknown; bytes: unknown } {
  const nested = record.filename;
  if (
    (record.bytes == null && record.bytesBase64 == null)
    && typeof nested === "object"
    && nested != null
    && !Array.isArray(nested)
  ) {
    const inner = nested as Record<string, unknown>;
    return { filename: inner.filename, bytes: inner.bytes ?? inner.bytesBase64 };
  }
  return { filename: record.filename ?? record.name, bytes: record.bytes ?? record.bytesBase64 };
}

export function resolveStageAttachmentArgs(filenameOrRequest: unknown, bytes?: unknown): { filename: unknown; bytes: unknown } {
  if (isStageRequestObject(filenameOrRequest) && isBlankClone(bytes)) return unwrapStageRequest(filenameOrRequest);
  if (!isBlankClone(bytes)) return { filename: filenameOrRequest, bytes };
  if (isStageRequestObject(filenameOrRequest)) return unwrapStageRequest(filenameOrRequest);
  return { filename: filenameOrRequest, bytes };
}

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  imageGenerationEndpoint,
  parseInferenceEndpointsDocument,
  rewriteLoopbackBaseUrlForBoxHost,
  type InferenceEndpoint,
} from "../../../shared/inference-endpoints.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { getSandRootDir } from "../../host-paths.js";
import { getBoxSecretsStorePath } from "../secrets/secrets-service.js";

export class SandApiGenerateImageError extends Error {}

export type GeneratedApiImage = {
  readonly imageData: string;
  readonly mimeType: string;
};

const FETCH_TIMEOUT_MS = 60_000;

function persistedSecrets(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(getBoxSecretsStorePath(), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};
    const secrets = (parsed as { secrets?: unknown }).secrets;
    if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {};
    return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function secretValue(name: string): string | undefined {
  const fromFile = persistedSecrets()[name]?.trim();
  return fromFile != null && fromFile.length > 0 ? fromFile : undefined;
}

function loadedImageEndpoint(): InferenceEndpoint {
  const document = parseInferenceEndpointsDocument(new SandSettingsStore(join(getSandRootDir(), "settings.json")).getInferenceEndpoints());
  const endpoint = document == null ? undefined : imageGenerationEndpoint(document);
  if (endpoint == null) {
    throw new SandApiGenerateImageError("Assign an image model in Settings → Router. Image generation does not use the chat LLM.");
  }
  return endpoint;
}

function sizeForAspect(aspect?: string): string {
  switch (aspect) {
    case "16:9":
      return "1792x1024";
    case "9:16":
      return "1024x1792";
    default:
      return "1024x1024";
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; value: unknown }> {
  const payload = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: payload,
      signal: controller.signal,
    });
    return { status: response.status, value: JSON.parse(await response.text()) };
  } finally {
    clearTimeout(timer);
  }
}

function extractImage(value: unknown): GeneratedApiImage {
  const data = typeof value === "object" && value != null ? (value as { data?: unknown }).data : undefined;
  const first = Array.isArray(data) ? data[0] : undefined;
  if (typeof first !== "object" || first == null) throw new SandApiGenerateImageError("Image API returned no image.");
  const record = first as { b64_json?: unknown; b64Json?: unknown };
  const b64 = typeof record.b64_json === "string" ? record.b64_json : typeof record.b64Json === "string" ? record.b64Json : undefined;
  if (b64 != null && b64.length > 0) return { imageData: b64, mimeType: "image/png" };
  throw new SandApiGenerateImageError("Image API returned no base64 image. Use a dedicated image model, not a chat LLM.");
}

function apiErrorMessage(status: number, value: unknown): string {
  const error = typeof value === "object" && value != null ? (value as { error?: unknown }).error : undefined;
  const message = typeof error === "string" ? error : typeof error === "object" && error != null && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : `HTTP ${status}`;
  return `Image API failed (${status}): ${message}`;
}

export async function generateImageWithAssignedEndpoint(prompt: string, aspect?: string): Promise<GeneratedApiImage> {
  const endpoint = loadedImageEndpoint();
  const apiKey = secretValue(endpoint.apiKeySecret);
  if (apiKey == null) throw new SandApiGenerateImageError(`Image model "${endpoint.id}" needs ${endpoint.apiKeySecret}. Add it in Settings → Router.`);
  const url = `${rewriteLoopbackBaseUrlForBoxHost(endpoint.baseURL).replace(/\/+$/, "")}/images/generations`;
  const headers = { authorization: `Bearer ${apiKey}`, ...(endpoint.headers ?? {}) };
  const first = await postJson(url, headers, { model: endpoint.model, prompt, n: 1, size: sizeForAspect(aspect), response_format: "b64_json" });
  if (first.status >= 200 && first.status < 300) return extractImage(first.value);
  const retry = await postJson(url, headers, { model: endpoint.model, prompt, n: 1, size: sizeForAspect(aspect) });
  if (retry.status >= 200 && retry.status < 300) return extractImage(retry.value);
  throw new SandApiGenerateImageError(apiErrorMessage(first.status, first.value));
}

export function createApiGenerateImageService() {
  return async (_context: unknown, description: string): Promise<GeneratedApiImage> => {
    const trimmed = description.trim();
    if (trimmed.length === 0) throw new SandApiGenerateImageError("Image prompt is empty.");
    return generateImageWithAssignedEndpoint(trimmed);
  };
}

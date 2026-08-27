import { validateBoxSecretKey } from "./box-secrets.js";

export const INFERENCE_ENDPOINTS_SCHEMA_VERSION = 1;
export const MAX_INFERENCE_ENDPOINTS = 32;
export const MAX_INFERENCE_ENDPOINT_HEADERS = 16;
export const MAX_INFERENCE_JSON_CHARS = 32 * 1024;
export const DEFAULT_COMPACT_AT = 0.75;
export const DEFAULT_REASONING_EFFORT = "medium";
export const MAX_FALLBACK_ENDPOINTS = 8;
export const FAILOVER_FAILURE_THRESHOLD = 2;

const FORBIDDEN_VALUE_KEYS = new Set([
  "apikey", "api_key", "api-key", "token", "password", "secret", "authorization", "access_token", "access-token", "x-api-key",
]);

export type InferenceEndpointKind = "openai-compatible";
export type InferenceReasoningEffort = "off" | "low" | "medium" | "high" | "xhigh" | "max";
export type InferenceEndpointRole = "chat" | "compact" | "fallback";

export interface InferenceEndpointRoles {
  readonly chat: string;
  readonly compact?: string;
  readonly fallback?: string;
  readonly fallbacks?: readonly string[];
}

export interface InferenceEndpointSticky {
  readonly chat?: string;
  readonly compact?: string;
  readonly failures?: Readonly<Record<string, number>>;
}

export interface InferenceEndpoint {
  readonly id: string;
  readonly label?: string;
  readonly kind: InferenceEndpointKind;
  readonly baseURL: string;
  readonly apiKeySecret: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: InferenceReasoningEffort;
  readonly contextWindow?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly compactAt?: number;
}

export interface InferenceEndpointsDocument {
  readonly schemaVersion: 1;
  readonly active: string;
  readonly roles?: InferenceEndpointRoles;
  readonly sticky?: InferenceEndpointSticky;
  readonly endpoints: readonly InferenceEndpoint[];
}

export interface CatalogModel {
  readonly id: string;
  readonly label: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

export interface InferenceProviderCatalog {
  readonly id: string;
  readonly label: string;
  readonly baseURL: string;
  readonly apiKeySecret: string;
  readonly models: readonly CatalogModel[];
}

export interface InferenceEndpointPreset {
  readonly id: string;
  readonly label: string;
  readonly endpoint: InferenceEndpoint;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const EFFORTS = new Set<InferenceReasoningEffort>(["off", "low", "medium", "high", "xhigh", "max"]);

export const INFERENCE_PROVIDER_CATALOG: readonly InferenceProviderCatalog[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    apiKeySecret: "OPENAI_API_KEY",
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", contextWindow: 1_050_000, maxOutputTokens: 128_000 },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", contextWindow: 1_050_000, maxOutputTokens: 128_000 },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeySecret: "OPENROUTER_API_KEY",
    models: [
      { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", contextWindow: 1_050_000, maxOutputTokens: 128_000 },
      { id: "anthropic/claude-opus-5", label: "Claude Opus 5", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash", contextWindow: 1_048_576, maxOutputTokens: 65_536 },
      { id: "x-ai/grok-4.6", label: "Grok 4.6", contextWindow: 500_000, maxOutputTokens: 128_000 },
      { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    baseURL: "https://api.anthropic.com/v1",
    apiKeySecret: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      { id: "claude-fable-5", label: "Claude Fable 5", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200_000, maxOutputTokens: 64_000 },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    apiKeySecret: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    ],
  },
  {
    id: "xai",
    label: "xAI",
    baseURL: "https://api.x.ai/v1",
    apiKeySecret: "XAI_API_KEY",
    models: [
      { id: "grok-4.6", label: "Grok 4.6", contextWindow: 500_000, maxOutputTokens: 128_000 },
    ],
  },
  {
    id: "google",
    label: "Google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeySecret: "GEMINI_API_KEY",
    models: [
      { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", contextWindow: 1_048_576, maxOutputTokens: 65_536 },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", contextWindow: 1_048_576, maxOutputTokens: 65_536 },
    ],
  },
  {
    id: "groq",
    label: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeySecret: "GROQ_API_KEY",
    models: [
      { id: "meta-llama/llama-4-maverick-17b-128e-instruct", label: "Llama 4 Maverick", contextWindow: 1_048_576, maxOutputTokens: 32_768 },
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout", contextWindow: 10_485_760, maxOutputTokens: 32_768 },
    ],
  },
  {
    id: "zai",
    label: "Z.ai",
    baseURL: "https://api.z.ai/api/paas/v4",
    apiKeySecret: "ZAI_API_KEY",
    models: [
      { id: "glm-5.3", label: "GLM-5.3", contextWindow: 202_752, maxOutputTokens: 128_000 },
      { id: "glm-5.2", label: "GLM-5.2", contextWindow: 202_752, maxOutputTokens: 128_000 },
    ],
  },
  {
    id: "minimax",
    label: "MiniMax",
    baseURL: "https://api.minimax.io/v1",
    apiKeySecret: "MINIMAX_API_KEY",
    models: [
      { id: "MiniMax-M2.7", label: "MiniMax M2.7", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    ],
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    baseURL: "https://api.siliconflow.cn/v1",
    apiKeySecret: "SILICONFLOW_API_KEY",
    models: [
      { id: "deepseek-ai/DeepSeek-V4-Pro", label: "DeepSeek V4 Pro", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      { id: "Qwen/Qwen3.8-Max", label: "Qwen3.8 Max", contextWindow: 1_000_000, maxOutputTokens: 65_536 },
    ],
  },
  {
    id: "ollama",
    label: "Ollama",
    baseURL: "http://127.0.0.1:11434/v1",
    apiKeySecret: "OLLAMA_API_KEY",
    models: [
      { id: "qwen3.8", label: "Qwen3.8", contextWindow: 128_000, maxOutputTokens: 32_768 },
    ],
  },
  {
    id: "custom",
    label: "Custom / relay",
    baseURL: "https://example.invalid/v1",
    apiKeySecret: "CUSTOM_API_KEY",
    models: [
      { id: "model-id", label: "Model ID", contextWindow: 128_000, maxOutputTokens: 32_768 },
    ],
  },
];

function endpointFromCatalog(provider: InferenceProviderCatalog, model = provider.models[0]!): InferenceEndpoint {
  return {
    id: provider.id,
    kind: "openai-compatible",
    baseURL: provider.baseURL,
    apiKeySecret: provider.apiKeySecret,
    model: model.id,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    compactAt: DEFAULT_COMPACT_AT,
  };
}

export const INFERENCE_ENDPOINT_PRESETS: readonly InferenceEndpointPreset[] = INFERENCE_PROVIDER_CATALOG.map((provider) => ({
  id: provider.id,
  label: provider.label,
  endpoint: endpointFromCatalog(provider),
}));

export function emptyInferenceEndpointsDocument(): InferenceEndpointsDocument {
  return documentFromPreset("openrouter");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && Array.isArray(value) === false;
}

function hasForbiddenValueKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenValueKey);
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_VALUE_KEYS.has(key.toLowerCase())) return true;
    if (hasForbiddenValueKey(nested)) return true;
  }
  return false;
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function optionalInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const name = key.trim();
    if (name.length === 0 || name.length > 64) continue;
    if (FORBIDDEN_VALUE_KEYS.has(name.toLowerCase())) continue;
    if (typeof item !== "string") continue;
    const header = item.trim();
    if (header.length === 0 || header.length > 256) continue;
    if (/authorization|api-?key|token|secret|password/i.test(name)) continue;
    if (/authorization|bearer\s+[a-z0-9]|sk-[a-z0-9]/i.test(header)) continue;
    headers[name] = header;
    if (Object.keys(headers).length >= MAX_INFERENCE_ENDPOINT_HEADERS) break;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseEndpoint(value: unknown): InferenceEndpoint | undefined {
  if (!isRecord(value) || hasForbiddenValueKey(value)) return undefined;
  const id = optionalString(value.id, 48);
  const baseURL = optionalString(value.baseURL ?? value.baseUrl, 512);
  const apiKeySecret = optionalString(value.apiKeySecret, 64);
  const model = optionalString(value.model, 128);
  if (id == null || !ID_PATTERN.test(id) || baseURL == null || apiKeySecret == null || model == null) return undefined;
  if (value.kind !== "openai-compatible") return undefined;
  let parsedUrl: URL;
  try { parsedUrl = new URL(baseURL); } catch { return undefined; }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return undefined;
  if (validateBoxSecretKey(apiKeySecret) != null) return undefined;
  const temperature = typeof value.temperature === "number" && Number.isFinite(value.temperature) && value.temperature >= 0 && value.temperature <= 2
    ? value.temperature
    : undefined;
  const maxOutputTokens = optionalInt(value.maxOutputTokens, 1, 1_000_000) ?? optionalInt(value.maxTokens, 1, 1_000_000);
  const maxInputTokens = optionalInt(value.maxInputTokens, 1, 10_000_000);
  const contextWindow = optionalInt(value.contextWindow, 1_024, 16_000_000);
  const compactAt = typeof value.compactAt === "number" && Number.isFinite(value.compactAt) && value.compactAt >= 0.5 && value.compactAt <= 0.95
    ? value.compactAt
    : undefined;
  const reasoningEffort = typeof value.reasoningEffort === "string" && EFFORTS.has(value.reasoningEffort as InferenceReasoningEffort)
    ? value.reasoningEffort as InferenceReasoningEffort
    : undefined;
  const headers = parseHeaders(value.headers);
  const label = optionalString(value.label, 64);
  return {
    id,
    ...(label == null ? {} : { label }),
    kind: "openai-compatible",
    baseURL: parsedUrl.toString().replace(/\/$/, ""),
    apiKeySecret,
    model,
    ...(headers == null ? {} : { headers }),
    ...(temperature == null ? {} : { temperature }),
    ...(maxOutputTokens == null ? {} : { maxOutputTokens, maxTokens: maxOutputTokens }),
    ...(maxInputTokens == null ? {} : { maxInputTokens }),
    ...(contextWindow == null ? {} : { contextWindow }),
    ...(compactAt == null ? {} : { compactAt }),
    ...(reasoningEffort == null ? {} : { reasoningEffort }),
  };
}

export function parseInferenceEndpointsDocument(value: unknown): InferenceEndpointsDocument | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_INFERENCE_JSON_CHARS) return undefined;
    try { return parseInferenceEndpointsDocument(JSON.parse(trimmed) as unknown); }
    catch { return undefined; }
  }
  if (!isRecord(value) || hasForbiddenValueKey(value)) return undefined;
  if (value.schemaVersion !== INFERENCE_ENDPOINTS_SCHEMA_VERSION) return undefined;
  if (!Array.isArray(value.endpoints) || value.endpoints.length === 0 || value.endpoints.length > MAX_INFERENCE_ENDPOINTS) return undefined;
  const endpoints: InferenceEndpoint[] = [];
  const seen = new Set<string>();
  for (const item of value.endpoints) {
    const endpoint = parseEndpoint(item);
    if (endpoint == null || seen.has(endpoint.id)) continue;
    seen.add(endpoint.id);
    endpoints.push(endpoint);
  }
  if (endpoints.length === 0) return undefined;
  const active = optionalString(value.active, 48);
  const resolved = active != null && seen.has(active) ? active : endpoints[0]!.id;
  const roles = parseRoles(value.roles, seen, resolved);
  const sticky = parseSticky(value.sticky, seen);
  return { schemaVersion: 1, active: resolved, ...(roles == null ? {} : { roles }), ...(sticky == null ? {} : { sticky }), endpoints };
}

function parseSticky(value: unknown, seen: Set<string>): InferenceEndpointSticky | undefined {
  if (!isRecord(value)) return undefined;
  const chat = optionalString(value.chat, 48);
  const compact = optionalString(value.compact, 48);
  const failures: Record<string, number> = {};
  if (isRecord(value.failures)) {
    for (const [id, count] of Object.entries(value.failures)) {
      if (!seen.has(id) || typeof count !== "number" || !Number.isInteger(count) || count < 0) continue;
      failures[id] = Math.min(32, count);
    }
  }
  const sticky: InferenceEndpointSticky = {
    ...(chat != null && seen.has(chat) ? { chat } : {}),
    ...(compact != null && seen.has(compact) ? { compact } : {}),
    ...(Object.keys(failures).length > 0 ? { failures } : {}),
  };
  if (sticky.chat == null && sticky.compact == null && sticky.failures == null) return undefined;
  return sticky;
}

function parseRoles(value: unknown, seen: Set<string>, active: string): InferenceEndpointRoles | undefined {
  if (!isRecord(value)) return undefined;
  const chat = optionalString(value.chat, 48);
  const compact = optionalString(value.compact, 48);
  const chatId = chat != null && seen.has(chat) ? chat : active;
  const fallbackIds: string[] = [];
  const listed = Array.isArray(value.fallbacks) ? value.fallbacks : optionalString(value.fallback, 48) != null ? [value.fallback] : [];
  for (const item of listed) {
    const id = optionalString(item, 48);
    if (id == null || !seen.has(id) || id === chatId || fallbackIds.includes(id)) continue;
    fallbackIds.push(id);
    if (fallbackIds.length >= MAX_FALLBACK_ENDPOINTS) break;
  }
  const next: InferenceEndpointRoles = {
    chat: chatId,
    ...(compact != null && seen.has(compact) && compact !== chatId ? { compact } : {}),
    ...(fallbackIds.length > 0 ? { fallback: fallbackIds[0], fallbacks: fallbackIds } : {}),
  };
  if (next.compact == null && next.fallbacks == null && next.chat === active) return undefined;
  return next;
}

export function sanitizeInferenceEndpointsDocument(value: unknown): InferenceEndpointsDocument {
  return parseInferenceEndpointsDocument(value) ?? emptyInferenceEndpointsDocument();
}

function publicEndpoint(endpoint: InferenceEndpoint): InferenceEndpoint {
  return {
    id: endpoint.id,
    ...(endpoint.label == null ? {} : { label: endpoint.label }),
    kind: endpoint.kind,
    baseURL: endpoint.baseURL,
    apiKeySecret: endpoint.apiKeySecret,
    model: endpoint.model,
    ...(endpoint.headers == null ? {} : { headers: { ...endpoint.headers } }),
    ...(endpoint.temperature == null ? {} : { temperature: endpoint.temperature }),
    ...(endpoint.maxTokens == null ? {} : { maxTokens: endpoint.maxTokens }),
    ...(endpoint.maxOutputTokens == null ? {} : { maxOutputTokens: endpoint.maxOutputTokens }),
    ...(endpoint.maxInputTokens == null ? {} : { maxInputTokens: endpoint.maxInputTokens }),
    ...(endpoint.contextWindow == null ? {} : { contextWindow: endpoint.contextWindow }),
    ...(endpoint.compactAt == null ? {} : { compactAt: endpoint.compactAt }),
    ...(endpoint.reasoningEffort == null ? {} : { reasoningEffort: endpoint.reasoningEffort }),
  };
}

export function publicInferenceEndpointsDocument(document: InferenceEndpointsDocument): InferenceEndpointsDocument {
  return {
    schemaVersion: 1,
    active: document.active,
    ...(document.roles == null ? {} : { roles: { ...document.roles } }),
    ...(document.sticky == null ? {} : { sticky: { ...document.sticky, ...(document.sticky.failures == null ? {} : { failures: { ...document.sticky.failures } }) } }),
    endpoints: document.endpoints.map(publicEndpoint),
  };
}

export function activeInferenceEndpoint(document: InferenceEndpointsDocument): InferenceEndpoint {
  return document.endpoints.find((endpoint) => endpoint.id === document.active) ?? document.endpoints[0]!;
}

export function inferenceEndpointRoles(document: InferenceEndpointsDocument): InferenceEndpointRoles {
  const fallbacks = fallbackEndpointIds(document);
  return {
    chat: document.roles?.chat ?? document.active,
    ...(document.roles?.compact == null ? {} : { compact: document.roles.compact }),
    ...(fallbacks.length > 0 ? { fallback: fallbacks[0], fallbacks } : {}),
  };
}

export function endpointForRole(document: InferenceEndpointsDocument, role: InferenceEndpointRole): InferenceEndpoint {
  const roles = inferenceEndpointRoles(document);
  const id = role === "chat" ? roles.chat : role === "compact" ? roles.compact ?? roles.chat : roles.fallbacks?.[0] ?? roles.fallback ?? roles.chat;
  return document.endpoints.find((endpoint) => endpoint.id === id) ?? activeInferenceEndpoint(document);
}

export function distinctEndpointForRole(document: InferenceEndpointsDocument, role: Exclude<InferenceEndpointRole, "chat">): InferenceEndpoint | undefined {
  const primary = endpointForRole(document, "chat");
  const next = endpointForRole(document, role);
  if (next.id === primary.id && next.baseURL === primary.baseURL && next.model === primary.model) return undefined;
  return next;
}

function endpointIdentity(endpoint: InferenceEndpoint): string {
  return `${endpoint.baseURL}\0${endpoint.model}\0${endpoint.apiKeySecret}`;
}

export function fallbackEndpointIds(document: InferenceEndpointsDocument): string[] {
  const chat = document.roles?.chat ?? document.active;
  const listed = document.roles?.fallbacks ?? (document.roles?.fallback != null ? [document.roles.fallback] : []);
  const ids: string[] = [];
  for (const id of listed) {
    if (typeof id !== "string" || document.endpoints.every((endpoint) => endpoint.id !== id) || id === chat || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_FALLBACK_ENDPOINTS) break;
  }
  return ids;
}

export function retryEndpointChain(document: InferenceEndpointsDocument, role: InferenceEndpointRole): InferenceEndpoint[] {
  const chain: InferenceEndpoint[] = [];
  const seen = new Set<string>();
  const push = (endpoint: InferenceEndpoint | undefined) => {
    if (endpoint == null) return;
    const identity = endpointIdentity(endpoint);
    if (seen.has(identity)) return;
    seen.add(identity);
    chain.push(endpoint);
  };
  if (role === "compact") push(endpointForRole(document, "compact"));
  push(endpointForRole(document, "chat"));
  for (const id of fallbackEndpointIds(document)) {
    push(document.endpoints.find((endpoint) => endpoint.id === id));
  }
  const ordered = chain.length > 0 ? chain : [activeInferenceEndpoint(document)];
  const stickyId = role === "compact" ? document.sticky?.compact : document.sticky?.chat;
  const failures = document.sticky?.failures ?? {};
  const index = stickyId == null ? -1 : ordered.findIndex((endpoint) => endpoint.id === stickyId);
  if (index < 0) return ordered;
  const start = (failures[stickyId] ?? 0) >= FAILOVER_FAILURE_THRESHOLD ? (index + 1) % ordered.length : index;
  return [...ordered.slice(start), ...ordered.slice(0, start)];
}

export function mergePreservedSticky(next: InferenceEndpointsDocument, previous: InferenceEndpointsDocument | undefined): InferenceEndpointsDocument {
  if (next.sticky != null || previous?.sticky == null) return next;
  const ids = new Set(next.endpoints.map((endpoint) => endpoint.id));
  const failures: Record<string, number> = {};
  for (const [id, count] of Object.entries(previous.sticky.failures ?? {})) {
    if (!ids.has(id)) continue;
    failures[id] = count;
  }
  const sticky: InferenceEndpointSticky = {
    ...(previous.sticky.chat != null && ids.has(previous.sticky.chat) ? { chat: previous.sticky.chat } : {}),
    ...(previous.sticky.compact != null && ids.has(previous.sticky.compact) ? { compact: previous.sticky.compact } : {}),
    ...(Object.keys(failures).length > 0 ? { failures } : {}),
  };
  if (sticky.chat == null && sticky.compact == null && sticky.failures == null) return next;
  return { ...next, sticky };
}

export function inferenceEndpointSecretNames(document: InferenceEndpointsDocument): string[] {
  return [...new Set(document.endpoints.map((endpoint) => endpoint.apiKeySecret))].sort();
}

export function documentFromPreset(id: string): InferenceEndpointsDocument {
  const provider = INFERENCE_PROVIDER_CATALOG.find((item) => item.id === id) ?? INFERENCE_PROVIDER_CATALOG.find((item) => item.id === "openrouter")!;
  const endpoint = endpointFromCatalog(provider);
  return { schemaVersion: 1, active: endpoint.id, endpoints: [endpoint] };
}

export function effectiveContextWindow(endpoint: InferenceEndpoint): number {
  return endpoint.contextWindow ?? 128_000;
}

export function effectiveMaxOutputTokens(endpoint: InferenceEndpoint): number | undefined {
  return endpoint.maxOutputTokens ?? endpoint.maxTokens;
}

export function effectiveReasoningEffort(endpoint: InferenceEndpoint): InferenceReasoningEffort {
  return endpoint.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
}

export function compactUnusedFraction(endpoint: InferenceEndpoint): number {
  const at = endpoint.compactAt ?? DEFAULT_COMPACT_AT;
  return Math.min(0.5, Math.max(0.05, Number((1 - at).toFixed(4))));
}

export function agentTokenLimitFromSettings(raw: unknown): number | undefined {
  const document = parseInferenceEndpointsDocument(raw);
  return document == null ? undefined : effectiveContextWindow(endpointForRole(document, "chat"));
}

export function compactUnusedFractionFromSettings(raw: unknown): number | undefined {
  const document = parseInferenceEndpointsDocument(raw);
  return document == null ? undefined : compactUnusedFraction(endpointForRole(document, "chat"));
}

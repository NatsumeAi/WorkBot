import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { COMPONENT_SOURCE } from "./router-renderer-patch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LINUX = "/tmp/openbot-asar-sync/linux";
const WIN = "/tmp/openbot-asar-sync/win-full";

function replaceOnce(source, before, after, label) {
  return replaceOneOf(source, [before], after, label);
}

function replaceOneOf(source, befores, after, label) {
  if (source.includes(after)) return source;
  for (const before of befores) {
    const first = source.indexOf(before);
    if (first < 0) continue;
    if (source.indexOf(before, first + 1) >= 0) throw new Error(`ambiguous ${label}`);
    return source.slice(0, first) + after + source.slice(first + before.length);
  }
  throw new Error(`missing ${label}`);
}

function replaceIife(source, iife, insertAnchor, label) {
  const start = source.indexOf("/* sand-inference-endpoints */");
  if (start < 0) return insertAfter(source, insertAnchor, iife, label);
  const close = source.indexOf("})();\n", start);
  if (close < 0) throw new Error(`${label} iife close missing`);
  return `${source.slice(0, start)}${iife.endsWith("\n") ? iife : `${iife}\n`}${source.slice(close + "})();\n".length)}`;
}

function insertAfter(source, anchor, insertion, label) {
  if (source.includes(insertion.trim())) return source;
  return replaceOnce(source, anchor, `${anchor}${insertion}`, label);
}

async function bundleInferenceEndpoints() {
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ["source/shared/inference-endpoints.ts"],
    format: "iife",
    globalName: "__sandIE",
    platform: "node",
    write: false,
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error("esbuild produced no inference-endpoints bundle");
  const text = file.text.trim();
  if (!text.includes("var __sandIE") && !text.includes("__sandIE =")) {
    throw new Error("inference-endpoints IIFE did not bind __sandIE");
  }
  return `/* sand-inference-endpoints */\n${text}\n`;
}

const PARSE_INSERT = `
  {
    const endpoints = typeof __sandIE !== "undefined" ? __sandIE.parseInferenceEndpointsDocument(raw.inferenceEndpoints) : void 0;
    if (endpoints != null) result.inferenceEndpoints = endpoints;
  }
`;

const STORE_METHODS_ELECTRON = `
      getInferenceEndpoints() {
        return this.load().inferenceEndpoints;
      }
      setInferenceEndpoints(value) {
        this.update((s) => ({ ...s, inferenceEndpoints: value }));
      }
`;

const STORE_METHODS_HOST = `
      getInferenceEndpoints() {
        return this.load().inferenceEndpoints;
      }
      setInferenceEndpoints(value) {
        this.update((s3) => ({ ...s3, inferenceEndpoints: value }));
      }
`;

const GET_ROUTER = `    getInferenceRouter: async () => {
      const settings = await deps2.readHostSettingsFromBox().catch(() => ({}));
      const provider = invoke(deps2.settingsStore, "getInferenceProvider");
      return { provider: isSandInferenceProvider(provider) ? provider : "cursor", usage: settings.inferenceRouterUsage ?? invoke(deps2.settingsStore, "getInferenceRouterUsage") ?? null, local: getLocalInferenceCliStatus() };
    },`;

const GET_ROUTER_AFTER = `    getInferenceRouter: async () => {
      const settings = await deps2.readHostSettingsFromBox().catch(() => ({}));
      const provider = invoke(deps2.settingsStore, "getInferenceProvider");
      const fromBox = typeof __sandIE !== "undefined" ? __sandIE.parseInferenceEndpointsDocument(settings.inferenceEndpoints) : void 0;
      const fromLocal = invoke(deps2.settingsStore, "getInferenceEndpoints");
      const endpoints = fromBox ?? (fromLocal == null || typeof __sandIE === "undefined" ? null : __sandIE.parseInferenceEndpointsDocument(fromLocal));
      return { provider: isSandInferenceProvider(provider) ? provider : "cursor", usage: settings.inferenceRouterUsage ?? invoke(deps2.settingsStore, "getInferenceRouterUsage") ?? null, local: getLocalInferenceCliStatus(), endpoints: endpoints == null || typeof __sandIE === "undefined" ? null : __sandIE.publicInferenceEndpointsDocument(endpoints) };
    },`;

const SET_ROUTER = `    setInferenceRouter: async (raw) => {
      const provider = req(raw).provider;
      invariant(isSandInferenceProvider(provider), "Unknown inference provider.");
      invoke(deps2.settingsStore, "setInferenceProvider", provider);
      const settings = await deps2.syncHostSettingsToBox({ inferenceProvider: provider }).catch(() => null);
      return { provider, usage: settings?.inferenceRouterUsage ?? invoke(deps2.settingsStore, "getInferenceRouterUsage") ?? null, local: getLocalInferenceCliStatus() };
    },`;

const SET_ENDPOINTS = `
    setInferenceEndpoints: async (raw) => {
      const document = typeof __sandIE === "undefined" ? null : __sandIE.parseInferenceEndpointsDocument(req(raw).document ?? raw);
      if (document == null) return { ok: false, message: "Invalid endpoints JSON. Keys belong in Secrets, not in this document." };
      invoke(deps2.settingsStore, "setInferenceEndpoints", document);
      invoke(deps2.settingsStore, "setInferenceProvider", "openrouter");
      const settings = await deps2.syncHostSettingsToBox({ inferenceProvider: "openrouter", inferenceEndpoints: __sandIE.publicInferenceEndpointsDocument(document) }).catch(() => null);
      const stored = __sandIE.parseInferenceEndpointsDocument(settings?.inferenceEndpoints) ?? document;
      return { ok: true, provider: "openrouter", endpoints: __sandIE.publicInferenceEndpointsDocument(stored), usage: settings?.inferenceRouterUsage ?? invoke(deps2.settingsStore, "getInferenceRouterUsage") ?? null, local: getLocalInferenceCliStatus() };
    },`;

const PUSH_BEFORE = `    const sentCount = Object.keys(snapshot.secrets).length;
    try {
      const status = await deps2.setBoxSecrets({ secrets: snapshot.secrets });`;

const PUSH_AFTER = `    const sentCount = Object.keys(snapshot.secrets).length;
    const removeKeys = extra?.removeKeys ?? [];
    if (!departing && sentCount === 0 && removeKeys.length === 0) {
      deps2.report({ outcome: "ok", trigger, accountScope: snapshot.accountScope, departing, secretCount: 0, applied: false });
      return { ok: true };
    }
    try {
      const status = await deps2.setBoxSecrets({ secrets: snapshot.secrets, merge: departing ? false : extra?.merge !== false, ...removeKeys.length > 0 ? { removeKeys } : {} });`;

const ATTEMPT_BEFORE = `  const attempt2 = async (trigger) => {`;
const ATTEMPT_AFTER = `  const attempt2 = async (trigger, extra) => {`;
const ENQUEUE_BEFORE = `  const enqueue = (trigger) => {
    if (quiesced) return Promise.resolve({ ok: false, error: new SandBoxSecretsPushQuiescedError() });
    const run = queue.then(() => quiesced ? { ok: false, error: new SandBoxSecretsPushQuiescedError() } : attempt2(trigger));`;
const ENQUEUE_AFTER = `  const enqueue = (trigger, extra) => {
    if (quiesced) return Promise.resolve({ ok: false, error: new SandBoxSecretsPushQuiescedError() });
    const run = queue.then(() => quiesced ? { ok: false, error: new SandBoxSecretsPushQuiescedError() } : attempt2(trigger, extra));`;
const PUSH_API_BEFORE = `    push: async (trigger) => (await enqueue(trigger)).ok,
    pushOrThrow: async (trigger) => {
      const result = await enqueue(trigger);
      if (!result.ok) throw result.error;
    },`;
const PUSH_API_AFTER = `    push: async (trigger, extra) => (await enqueue(trigger, extra)).ok,
    pushOrThrow: async (trigger, extra) => {
      const result = await enqueue(trigger, extra);
      if (!result.ok) throw result.error;
    },`;

const HOST_CAN_RUN_BEFORE = `function hostInferenceCanRunWithoutCursor() {
  if (process.env.SAND_AGENT_MOCK_RESPONSE != null) return true;
  const key = process.env.OPENROUTER_API_KEY?.trim() || persistedSecrets().OPENROUTER_API_KEY?.trim();
  return typeof key === "string" && key.length > 0;
}`;

const HOST_CAN_RUN_V2 = `function secretValue(name) {
  const value = process.env[name]?.trim() || persistedSecrets()[name]?.trim();
  return value != null && value.length > 0 ? value : void 0;
}
function loadedEndpoints() {
  try {
    return typeof __sandIE === "undefined" ? void 0 : __sandIE.parseInferenceEndpointsDocument(new SandSettingsStore((0, import_node_path6.join)(getSandRootDir(), "settings.json")).getInferenceEndpoints());
  } catch {
    return void 0;
  }
}
function resolvedApiEndpoint() {
  const document = loadedEndpoints();
  if (document != null) return __sandIE.activeInferenceEndpoint(document);
  return { id: "openrouter", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.6-sol" };
}
function hostInferenceCanRunWithoutCursor() {
  if (process.env.SAND_AGENT_MOCK_RESPONSE != null) return true;
  const endpoints = loadedEndpoints();
  if (endpoints != null) {
    const needed = __sandIE.activeInferenceEndpoint(endpoints).apiKeySecret;
    if (secretValue(needed) != null) return true;
    if (endpoints.endpoints.some((endpoint) => secretValue(endpoint.apiKeySecret) != null)) return true;
  }
  return secretValue("OPENROUTER_API_KEY") != null;
}`;

const HOST_CAN_RUN_AFTER = `function secretValue(name) {
  const value = process.env[name]?.trim() || persistedSecrets()[name]?.trim();
  return value != null && value.length > 0 ? value : void 0;
}
function loadedEndpoints() {
  try {
    return typeof __sandIE === "undefined" ? void 0 : __sandIE.parseInferenceEndpointsDocument(new SandSettingsStore((0, import_node_path6.join)(getSandRootDir(), "settings.json")).getInferenceEndpoints());
  } catch {
    return void 0;
  }
}
function persistSticky(role, winnerId, failedId) {
  const store = new SandSettingsStore((0, import_node_path6.join)(getSandRootDir(), "settings.json"));
  const document = typeof __sandIE.parseInferenceEndpointsDocument === "function" ? __sandIE.parseInferenceEndpointsDocument(store.getInferenceEndpoints()) : void 0;
  if (document == null) return;
  const failures = { ...(document.sticky && document.sticky.failures || {}) };
  if (failedId != null) failures[failedId] = Math.min(32, (failures[failedId] || 0) + 1);
  if (winnerId != null) failures[winnerId] = 0;
  store.setInferenceEndpoints({ ...document, sticky: { chat: role === "chat" && winnerId != null ? winnerId : document.sticky && document.sticky.chat, compact: role === "compact" && winnerId != null ? winnerId : document.sticky && document.sticky.compact, ...Object.keys(failures).length > 0 ? { failures } : {} } });
}
function resolvedApiEndpoint(role) {
  const document = loadedEndpoints();
  if (document != null) return typeof __sandIE.endpointForRole === "function" ? __sandIE.endpointForRole(document, role ?? "chat") : __sandIE.activeInferenceEndpoint(document);
  return { id: "openrouter", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.6-sol" };
}
function hostInferenceCanRunWithoutCursor() {
  if (process.env.SAND_AGENT_MOCK_RESPONSE != null) return true;
  const endpoints = loadedEndpoints();
  if (endpoints != null) {
    const needed = __sandIE.activeInferenceEndpoint(endpoints).apiKeySecret;
    if (secretValue(needed) != null) return true;
    if (endpoints.endpoints.some((endpoint) => secretValue(endpoint.apiKeySecret) != null)) return true;
  }
  return secretValue("OPENROUTER_API_KEY") != null;
}`;

const OPENROUTER_EXEC_STOCK = `function openRouterExecutor(messages, invocationId, definitions, executeTool, onUsage) {
  const id = process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";
  const model = createOpenAI({ apiKey: openRouterCredential(), baseURL: "https://openrouter.ai/api/v1", compatibility: "compatible", name: "openrouter", headers: { "HTTP-Referer": "https://github.com/grok-bot-reconstructed", "X-Title": "Grok Bot Reconstructed" } }).chat(id);
  const tools = toToolSet(definitions, executeTool);
  const result = streamText({ model, system: GROK_ROUTER_SYSTEM_PROMPT, messages, ...tools === void 0 ? {} : { tools }, toolCallStreaming: true, maxSteps: tools === void 0 ? 1 : 8 });
  const extendedUsage = result.usage.then((value) => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 }));
  if (onUsage != null) void extendedUsage.then(onUsage);
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}
function createProviderPromptSession(provider) {
  const modelId = provider === "codex" ? configuredCodexModel() : provider === "claude-code" ? "claude-code" : process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";`;

const OPENROUTER_EXEC_V1 = `function openRouterExecutor(messages, invocationId, definitions, executeTool, onUsage) {
  const endpoint = resolvedApiEndpoint();
  const apiKey = endpoint.apiKeySecret === "OPENROUTER_API_KEY" ? openRouterCredential() : secretValue(endpoint.apiKeySecret);
  if (apiKey == null) throw new Error(\`API endpoint "\${endpoint.id}" needs \${endpoint.apiKeySecret}. Add it in Settings → Router.\`);
  const model = createOpenAI({ apiKey, baseURL: endpoint.baseURL, compatibility: "compatible", name: endpoint.id, ...endpoint.headers == null ? {} : { headers: { ...endpoint.headers } } }).chat(endpoint.model);
  const tools = toToolSet(definitions, executeTool);
  const result = streamText({ model, system: GROK_ROUTER_SYSTEM_PROMPT, messages, ...tools === void 0 ? {} : { tools }, ...endpoint.temperature == null ? {} : { temperature: endpoint.temperature }, ...endpoint.maxTokens == null ? {} : { maxTokens: endpoint.maxTokens }, toolCallStreaming: true, maxSteps: tools === void 0 ? 1 : 8 });
  const extendedUsage = result.usage.then((value) => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 }));
  if (onUsage != null) void extendedUsage.then(onUsage);
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}
function createProviderPromptSession(provider) {
  const modelId = provider === "codex" ? configuredCodexModel() : provider === "claude-code" ? "claude-code" : resolvedApiEndpoint().model;`;

const OPENROUTER_EXEC_V2 = `function openRouterExecutor(messages, invocationId, definitions, executeTool, onUsage) {
  const endpoint = resolvedApiEndpoint();
  const apiKey = endpoint.apiKeySecret === "OPENROUTER_API_KEY" ? openRouterCredential() : secretValue(endpoint.apiKeySecret);
  if (apiKey == null) throw new Error(\`API endpoint "\${endpoint.id}" needs \${endpoint.apiKeySecret}. Add it in Settings → Router.\`);
  const model = createOpenAI({ apiKey, baseURL: endpoint.baseURL, compatibility: "compatible", name: endpoint.id, ...endpoint.headers == null ? {} : { headers: { ...endpoint.headers } } }).chat(endpoint.model);
  const tools = toToolSet(definitions, executeTool);
  const maxOutput = typeof __sandIE !== "undefined" && typeof __sandIE.effectiveMaxOutputTokens === "function" ? __sandIE.effectiveMaxOutputTokens(endpoint) : endpoint.maxOutputTokens ?? endpoint.maxTokens;
  const effort = typeof __sandIE !== "undefined" && typeof __sandIE.effectiveReasoningEffort === "function" ? __sandIE.effectiveReasoningEffort(endpoint) : endpoint.reasoningEffort ?? "medium";
  const contextWindow = typeof __sandIE !== "undefined" && typeof __sandIE.effectiveContextWindow === "function" ? __sandIE.effectiveContextWindow(endpoint) : endpoint.contextWindow ?? 128000;
  const result = streamText({ model, system: GROK_ROUTER_SYSTEM_PROMPT, messages, ...tools === void 0 ? {} : { tools }, ...endpoint.temperature == null ? {} : { temperature: endpoint.temperature }, ...maxOutput == null ? {} : { maxTokens: maxOutput }, ...effort === "off" ? {} : { providerOptions: { openai: { reasoningEffort: effort } } }, toolCallStreaming: true, maxSteps: tools === void 0 ? 1 : 8 });
  const extendedUsage = result.usage.then((value) => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: contextWindow }));
  if (onUsage != null) void extendedUsage.then(onUsage);
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}
function createProviderPromptSession(provider) {
  const modelId = provider === "codex" ? configuredCodexModel() : provider === "claude-code" ? "claude-code" : resolvedApiEndpoint().model;`;

const OPENROUTER_EXEC_AFTER = `function isRetryableInferenceError(error) {
  const status = typeof error === "object" && error != null ? error.status ?? error.statusCode : void 0;
  if (typeof status === "number") {
    if (status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 409 || status === 425 || status === 429 || status === 529) return true;
    if (status >= 500 && status <= 599) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /401|403|404|408|429|500|502|503|504|529|rate limit|quota|insufficient|too many requests|overloaded|capacity|no available|model not found|not found|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|EAI_AGAIN|temporarily unavailable|try again|unavailable/i.test(message);
}
function streamOpenaiCompatible(endpoint, messages, invocationId, definitions, executeTool, onUsage) {
  const apiKey = endpoint.apiKeySecret === "OPENROUTER_API_KEY" ? openRouterCredential() : secretValue(endpoint.apiKeySecret);
  if (apiKey == null) throw new Error(\`API endpoint "\${endpoint.id}" needs \${endpoint.apiKeySecret}. Add it in Settings → Router.\`);
  const model = createOpenAI({ apiKey, baseURL: endpoint.baseURL, compatibility: "compatible", name: endpoint.id, ...endpoint.headers == null ? {} : { headers: { ...endpoint.headers } } }).chat(endpoint.model);
  const tools = toToolSet(definitions, executeTool);
  const maxOutput = typeof __sandIE !== "undefined" && typeof __sandIE.effectiveMaxOutputTokens === "function" ? __sandIE.effectiveMaxOutputTokens(endpoint) : endpoint.maxOutputTokens ?? endpoint.maxTokens;
  const effort = typeof __sandIE !== "undefined" && typeof __sandIE.effectiveReasoningEffort === "function" ? __sandIE.effectiveReasoningEffort(endpoint) : endpoint.reasoningEffort ?? "medium";
  const contextWindow = typeof __sandIE !== "undefined" && typeof __sandIE.effectiveContextWindow === "function" ? __sandIE.effectiveContextWindow(endpoint) : endpoint.contextWindow ?? 128000;
  const result = streamText({ model, system: GROK_ROUTER_SYSTEM_PROMPT, messages, ...tools === void 0 ? {} : { tools }, ...endpoint.temperature == null ? {} : { temperature: endpoint.temperature }, ...maxOutput == null ? {} : { maxTokens: maxOutput }, ...effort === "off" ? {} : { providerOptions: { openai: { reasoningEffort: effort } } }, toolCallStreaming: true, maxSteps: tools === void 0 ? 1 : 8 });
  const extendedUsage = result.usage.then((value) => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: contextWindow }));
  if (onUsage != null) void extendedUsage.then(onUsage);
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}
function openRouterExecutor(messages, invocationId, definitions, executeTool, onUsage, role) {
  const document = loadedEndpoints();
  const chain = document != null && typeof __sandIE.retryEndpointChain === "function" ? __sandIE.retryEndpointChain(document, role ?? "chat") : [resolvedApiEndpoint(role ?? "chat")];
  const usage = Promise.withResolvers();
  const extendedUsage = Promise.withResolvers();
  const resultResponse = Promise.withResolvers();
  const metadata = Promise.withResolvers();
  const fullStream = (async function* () {
    const run = async function* (endpoint) {
      const result = streamOpenaiCompatible(endpoint, messages, invocationId, definitions, executeTool, onUsage);
      for await (const event of result.fullStream) yield event;
      usage.resolve(await result.usage);
      extendedUsage.resolve(await result.extendedUsage);
      resultResponse.resolve(await result.response);
      metadata.resolve(await result.providerMetadata);
    };
    try {
      for (let index = 0; index < chain.length; index += 1) {
        let emitted = false;
        try {
          for await (const event of run(chain[index])) {
            emitted = true;
            yield event;
          }
          persistSticky(role ?? "chat", chain[index].id);
          return;
        } catch (error) {
          persistSticky(role ?? "chat", void 0, chain[index].id);
          if (emitted || !isRetryableInferenceError(error) || index === chain.length - 1) throw error;
        }
      }
    } catch (error) {
      usage.reject(error);
      extendedUsage.reject(error);
      resultResponse.reject(error);
      metadata.reject(error);
      throw error;
    }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}
function createProviderPromptSession(provider, role) {
  const resolvedRole = role ?? "chat";
  const modelId = provider === "codex" ? configuredCodexModel() : provider === "claude-code" ? "claude-code" : resolvedApiEndpoint(resolvedRole).model;`;

const TOKEN_LIMIT_BEFORE = `            staticConfig: {
              modelId: staticModelId,
              agentTokenLimit: 2e5,
              conversationId: session.id,
              isBoxScopedSubagent: false,
              isSubagentRunner: false,
              isSharedRoomRunner: isSharedRoomTurn,
              sandSendMessageDeliveryOwed: method2(experiments, "isSendMessageDeliveryOwedEnabled")?.() ?? false,
              systemPromptGenerator: () => productionSystemPromptAssembly?.getSystemPrompt() ?? DEFAULT_SAND_SYSTEM_PROMPT
            },`;

const TOKEN_LIMIT_AFTER = `            staticConfig: {
              modelId: staticModelId,
              agentTokenLimit: typeof __sandIE !== "undefined" && typeof __sandIE.agentTokenLimitFromSettings === "function" && new SandSettingsStore(require("node:path").join(getSandRootDir(), "settings.json")).getInferenceProvider() !== "cursor" ? __sandIE.agentTokenLimitFromSettings(new SandSettingsStore(require("node:path").join(getSandRootDir(), "settings.json")).getInferenceEndpoints()) ?? 2e5 : 2e5,
              conversationId: session.id,
              isBoxScopedSubagent: false,
              isSubagentRunner: false,
              isSharedRoomRunner: isSharedRoomTurn,
              sandSendMessageDeliveryOwed: method2(experiments, "isSendMessageDeliveryOwedEnabled")?.() ?? false,
              systemPromptGenerator: () => productionSystemPromptAssembly?.getSystemPrompt() ?? DEFAULT_SAND_SYSTEM_PROMPT,
              ...(() => {
                if (typeof __sandIE === "undefined" || typeof __sandIE.compactUnusedFractionFromSettings !== "function") return {};
                const store = new SandSettingsStore(require("node:path").join(getSandRootDir(), "settings.json"));
                if (store.getInferenceProvider() === "cursor") return {};
                const unused = __sandIE.compactUnusedFractionFromSettings(store.getInferenceEndpoints()) ?? 0.25;
                return { backgroundSummarizationPropsOverride: { unusedPercentTokensThresholdToStartBackgroundSummarization: unused, unusedPercentTokensThresholdToPersistBackgroundSummarization: Math.max(0.02, unused / 2) } };
              })()
            },`;

const SET_SECRETS_BEFORE = `      async setSecrets(ctx, secrets) {
        const validationError = validateBoxSecrets(secrets);
        if (validationError != null) throw new SandBoxSecretsValidationError(validationError);
        this.desired = { ...secrets };`;

const SET_SECRETS_AFTER = `      async setSecrets(ctx, secrets, opts) {
        const persisted = opts?.merge === true || opts?.removeKeys != null && opts.removeKeys.length > 0 ? await this.loadPersisted() ?? this.desired : void 0;
        const next = { ...(opts?.merge === true ? persisted ?? {} : {}), ...secrets };
        if (opts?.removeKeys != null) for (const key of opts.removeKeys) delete next[key];
        const validationError = validateBoxSecrets(next);
        if (validationError != null) throw new SandBoxSecretsValidationError(validationError);
        this.desired = next;`;

async function patchElectronMain(source, iife) {
  let next = replaceIife(source, iife, `process.env.SAND_DISABLE_TELEMETRY ??= "1";\n`, "electron-main iife");
  next = insertAfter(
    next,
    `  if (isSandInferenceProvider(raw.inferenceProvider)) result.inferenceProvider = raw.inferenceProvider;\n`,
    PARSE_INSERT,
    "electron-main parseSettings endpoints",
  );
  next = insertAfter(
    next,
    `      setInferenceProvider(value) {
        this.update((s) => ({ ...s, inferenceProvider: value }));
      }
`,
    STORE_METHODS_ELECTRON,
    "electron-main settings store endpoints",
  );
  next = replaceOnce(next, GET_ROUTER, GET_ROUTER_AFTER, "getInferenceRouter");
  next = insertAfter(next, SET_ROUTER, SET_ENDPOINTS, "setInferenceEndpoints handler");
  next = insertAfter(
    next,
    `  setInferenceRouter: { args: "object" },\n`,
    `  setInferenceEndpoints: { args: "object" },\n`,
    "MAIN_METHOD_TABLE setInferenceEndpoints",
  );
  next = replaceOnce(next, ATTEMPT_BEFORE, ATTEMPT_AFTER, "createBoxSecretsPush attempt extra");
  next = replaceOnce(next, PUSH_BEFORE, PUSH_AFTER, "createBoxSecretsPush skip-empty merge");
  next = replaceOnce(next, ENQUEUE_BEFORE, ENQUEUE_AFTER, "createBoxSecretsPush enqueue extra");
  next = replaceOnce(next, PUSH_API_BEFORE, PUSH_API_AFTER, "createBoxSecretsPush push extra");
  next = replaceOnce(
    next,
    `  const userSecretsStore = new SandUserSecretsStore(void 0, getAccountScope);`,
    `  const userSecretsStore = new SandUserSecretsStore(void 0, () => getAccountScope() ?? LOCAL_UNSIGNED_ACCOUNT_SLOT);`,
    "unsigned local secrets slot",
  );
  next = replaceOnce(
    next,
    `    await userSecretsStore.upsert(parseSecretEntries(request4.entries));
    return { synced: await pushBoxSecrets() };
  });
  ipcMain3.handle("sand:secrets-delete", async (event, request4) => {
    guards.assertTrustedSecretsSender(event);
    const keys = Array.isArray(request4.keys) ? request4.keys.filter((key) => typeof key === "string") : [];
    await userSecretsStore.remove(keys);
    return { synced: await pushBoxSecrets() };`,
    `    await userSecretsStore.upsert(parseSecretEntries(request4.entries));
    return { synced: await pushBoxSecrets("upsert", { merge: true }) };
  });
  ipcMain3.handle("sand:secrets-delete", async (event, request4) => {
    guards.assertTrustedSecretsSender(event);
    const keys = Array.isArray(request4.keys) ? request4.keys.filter((key) => typeof key === "string") : [];
    await userSecretsStore.remove(keys);
    return { synced: await pushBoxSecrets("delete", { merge: true, removeKeys: keys }) };`,
    "secrets ipc merge/removeKeys",
  );
  next = replaceOnce(
    next,
    `      pushBoxSecrets: () => context2.secretsStores.pushBoxSecrets.push("edit")`,
    `      pushBoxSecrets: (trigger, extra) => context2.secretsStores.pushBoxSecrets.push(trigger, extra)`,
    "secrets ipc registrar extra",
  );
  return next;
}

async function patchHostMain(source, iife) {
  let next = replaceIife(source, iife, `var __create = Object.create;\n`, "host-main iife");
  next = insertAfter(
    next,
    `  if (isSandInferenceProvider(raw.inferenceProvider)) result.inferenceProvider = raw.inferenceProvider;\n`,
    PARSE_INSERT,
    "host-main parseSettings endpoints",
  );
  next = insertAfter(
    next,
    `      setInferenceProvider(value) {
        this.update((s3) => ({ ...s3, inferenceProvider: value }));
      }
`,
    STORE_METHODS_HOST,
    "host-main settings store endpoints",
  );
  next = replaceOnce(
    next,
    `inferenceProvider: this.store.getInferenceProvider(), inferenceRouterUsage: this.store.getInferenceRouterUsage(),`,
    `inferenceProvider: this.store.getInferenceProvider(), inferenceRouterUsage: this.store.getInferenceRouterUsage(), ...this.store.getInferenceEndpoints() == null ? {} : { inferenceEndpoints: this.store.getInferenceEndpoints() },`,
    "getHostSettings inferenceEndpoints",
  );
  next = insertAfter(
    next,
    `    if (isSandInferenceProvider(update.inferenceProvider)) this.store.setInferenceProvider(update.inferenceProvider);\n`,
    `    {\n      const endpoints = typeof __sandIE !== "undefined" ? __sandIE.parseInferenceEndpointsDocument(update.inferenceEndpoints) : void 0;\n      if (endpoints != null) this.store.setInferenceEndpoints(typeof __sandIE.mergePreservedSticky === "function" ? __sandIE.mergePreservedSticky(endpoints, this.store.getInferenceEndpoints()) : endpoints);\n    }\n`,
    "setHostSettings inferenceEndpoints",
  );
  next = replaceOnce(
    next,
    `      if (endpoints != null) this.store.setInferenceEndpoints(endpoints);`,
    `      if (endpoints != null) this.store.setInferenceEndpoints(typeof __sandIE.mergePreservedSticky === "function" ? __sandIE.mergePreservedSticky(endpoints, this.store.getInferenceEndpoints()) : endpoints);`,
    "merge sticky on box settings",
  );
  if (!next.includes("function loadedEndpoints()")) {
    next = replaceOneOf(
      next,
      [HOST_CAN_RUN_BEFORE, HOST_CAN_RUN_V2, HOST_CAN_RUN_AFTER.replace("openai/gpt-5.6-sol", "openai/gpt-4o")],
      HOST_CAN_RUN_AFTER,
      "hostInferenceCanRunWithoutCursor",
    );
  }
  if (!next.includes("function persistSticky(")) {
    next = replaceOnce(
      next,
      `function loadedEndpoints() {
  try {
    return typeof __sandIE === "undefined" ? void 0 : __sandIE.parseInferenceEndpointsDocument(new SandSettingsStore((0, import_node_path6.join)(getSandRootDir(), "settings.json")).getInferenceEndpoints());
  } catch {
    return void 0;
  }
}`,
      `function loadedEndpoints() {
  try {
    return typeof __sandIE === "undefined" ? void 0 : __sandIE.parseInferenceEndpointsDocument(new SandSettingsStore((0, import_node_path6.join)(getSandRootDir(), "settings.json")).getInferenceEndpoints());
  } catch {
    return void 0;
  }
}
function persistSticky(role, winnerId, failedId) {
  const store = new SandSettingsStore((0, import_node_path6.join)(getSandRootDir(), "settings.json"));
  const document = typeof __sandIE.parseInferenceEndpointsDocument === "function" ? __sandIE.parseInferenceEndpointsDocument(store.getInferenceEndpoints()) : void 0;
  if (document == null) return;
  const failures = { ...(document.sticky && document.sticky.failures || {}) };
  if (failedId != null) failures[failedId] = Math.min(32, (failures[failedId] || 0) + 1);
  if (winnerId != null) failures[winnerId] = 0;
  store.setInferenceEndpoints({ ...document, sticky: { chat: role === "chat" && winnerId != null ? winnerId : document.sticky && document.sticky.chat, compact: role === "compact" && winnerId != null ? winnerId : document.sticky && document.sticky.compact, ...Object.keys(failures).length > 0 ? { failures } : {} } });
}`,
      "persistSticky helper",
    );
  }
  if (next.includes("retryEndpointChain")) {
    if (!next.includes("persistSticky(role")) {
      next = replaceOnce(
        next,
        `          return;
        } catch (error) {
          if (emitted || !isRetryableInferenceError(error) || index === chain.length - 1) throw error;
        }`,
        `          persistSticky(role ?? "chat", chain[index].id);
          return;
        } catch (error) {
          persistSticky(role ?? "chat", void 0, chain[index].id);
          if (emitted || !isRetryableInferenceError(error) || index === chain.length - 1) throw error;
        }`,
        "persistSticky on failover",
      );
    }
  } else if (next.includes("function isRetryableInferenceError")) {
    next = replaceOnce(
      next,
      `  if (status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate limit|too many requests|overloaded|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|502|503|504/i.test(message);`,
      `  if (typeof status === "number") {
    if (status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 409 || status === 425 || status === 429 || status === 529) return true;
    if (status >= 500 && status <= 599) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /401|403|404|408|429|500|502|503|504|529|rate limit|quota|insufficient|too many requests|overloaded|capacity|no available|model not found|not found|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|EAI_AGAIN|temporarily unavailable|try again|unavailable/i.test(message);`,
      "retryable inference errors",
    );
    next = replaceOnce(
      next,
      `  const primary = resolvedApiEndpoint(role ?? "chat");
  const document = loadedEndpoints();
  const fallback = document == null || typeof __sandIE.distinctEndpointForRole !== "function" ? void 0 : role === "compact" ? __sandIE.distinctEndpointForRole(document, "compact") == null ? void 0 : __sandIE.endpointForRole(document, "chat") : __sandIE.distinctEndpointForRole(document, "fallback");
  const fallbackDistinct = fallback != null && (fallback.id !== primary.id || fallback.baseURL !== primary.baseURL || fallback.model !== primary.model) ? fallback : void 0;
  if (fallbackDistinct == null) return streamOpenaiCompatible(primary, messages, invocationId, definitions, executeTool, onUsage);`,
      `  const document = loadedEndpoints();
  const chain = document != null && typeof __sandIE.retryEndpointChain === "function" ? __sandIE.retryEndpointChain(document, role ?? "chat") : [resolvedApiEndpoint(role ?? "chat")];
  if (chain.length === 1) return streamOpenaiCompatible(chain[0], messages, invocationId, definitions, executeTool, onUsage);`,
      "fallback chain setup",
    );
    next = replaceOnce(
      next,
      `      let emitted = false;
      try {
        for await (const event of run(primary)) {
          emitted = true;
          yield event;
        }
      } catch (error) {
        if (emitted || !isRetryableInferenceError(error)) throw error;
        for await (const event of run(fallbackDistinct)) yield event;
      }`,
      `      for (let index = 0; index < chain.length; index += 1) {
        let emitted = false;
        try {
          for await (const event of run(chain[index])) {
            emitted = true;
            yield event;
          }
          persistSticky(role ?? "chat", chain[index].id);
          return;
        } catch (error) {
          persistSticky(role ?? "chat", void 0, chain[index].id);
          if (emitted || !isRetryableInferenceError(error) || index === chain.length - 1) throw error;
        }
      }`,
      "fallback chain loop",
    );
  } else {
    next = replaceOneOf(next, [OPENROUTER_EXEC_STOCK, OPENROUTER_EXEC_V1, OPENROUTER_EXEC_V2], OPENROUTER_EXEC_AFTER, "openai-compatible executor");
  }
  next = replaceOnce(
    next,
    `function resolvedApiEndpoint() {
  const document = loadedEndpoints();
  if (document != null) return __sandIE.activeInferenceEndpoint(document);
  return { id: "openrouter", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.6-sol" };
}`,
    `function resolvedApiEndpoint(role) {
  const document = loadedEndpoints();
  if (document != null) return typeof __sandIE.endpointForRole === "function" ? __sandIE.endpointForRole(document, role ?? "chat") : __sandIE.activeInferenceEndpoint(document);
  return { id: "openrouter", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.6-sol" };
}`,
    "resolvedApiEndpoint role",
  );
  next = replaceOnce(
    next,
    `        return openRouterExecutor(this.getMessages(), invocationId, definitions, void 0, this.onUsage);`,
    `        return openRouterExecutor(this.getMessages(), invocationId, definitions, void 0, this.onUsage, this.role);`,
    "openRouterExecutor pass role",
  );
  next = replaceOnce(
    next,
    `  ) : createProviderPromptSession(inferenceProvider);
  const summarization = summarizationSession`,
    `  ) : createProviderPromptSession(inferenceProvider, "compact");
  const summarization = summarizationSession`,
    "turn summarization compact role",
  );
  next = replaceOnce(
    next,
    `      if (routedProvider !== "cursor") return createProviderPromptSession(routedProvider);
      const experimentState`,
    `      if (routedProvider !== "cursor") return createProviderPromptSession(routedProvider, sessionOptions?.isSummarizationSession === true ? "compact" : "chat");
      const experimentState`,
    "cursor session compact role",
  );
  next = replaceOnce(
    next,
    `  return { getModelId: () => modelId, getExecutor: (state2) => new ProviderPromptExecutor(provider, Array.isArray(state2) ? state2 : void 0, (usage) => recordRoutedUsage(provider, usage)) };`,
    `  return { getModelId: () => modelId, getExecutor: (state2) => {
    const executor = new ProviderPromptExecutor(provider, Array.isArray(state2) ? state2 : void 0, (usage) => recordRoutedUsage(provider, usage));
    executor.role = resolvedRole;
    return executor;
  } };`,
    "provider session executor role",
  );
  next = replaceOnce(
    next,
    `      return createProviderPromptSession(provider);
    }
  };
}`,
    `      return createProviderPromptSession(provider, "compact");
    }
  };
}`,
    "inference service summarization compact",
  );
  next = replaceOnce(next, TOKEN_LIMIT_BEFORE, TOKEN_LIMIT_AFTER, "agentTokenLimit from box window");
  next = replaceOnce(next, SET_SECRETS_BEFORE, SET_SECRETS_AFTER, "BoxSecretsApplier merge");
  next = replaceOnce(
    next,
    `    return { set: ({ secrets }) => service.setSecrets(requestContext, secrets), getStatus: () => service.getStatus() };`,
    `    return { set: (args) => service.setSecrets(requestContext, args.secrets ?? {}, { merge: args.merge === true, ...Array.isArray(args.removeKeys) ? { removeKeys: args.removeKeys.filter((key) => typeof key === "string") } : {} }), getStatus: () => service.getStatus() };`,
    "secrets extension merge",
  );
  next = replaceOnce(
    next,
    `    setBoxSecrets: ({ secrets }) => method(deps.extensions.api("secrets"), "set")({ secrets }),`,
    `    setBoxSecrets: (args) => method(deps.extensions.api("secrets"), "set")(args),`,
    "gateway setBoxSecrets passthrough",
  );
  return next;
}

function patchPreload(source) {
  let next = source;
  next = insertAfter(
    next,
    `  setInferenceRouter: { args: "object" },\n`,
    `  setInferenceEndpoints: { args: "object" },\n`,
    "preload MAIN_METHOD_TABLE",
  );
  next = insertAfter(
    next,
    `  setInferenceRouter: "inferenceRouter",\n`,
    `  setInferenceEndpoints: "inferenceRouter",\n`,
    "preload capability",
  );
  next = insertAfter(
    next,
    `      setInferenceRouter: (provider) => gatedCall("inferenceRouter", "setInferenceRouter", { provider }),\n`,
    `      setInferenceEndpoints: (document) => gatedCall("inferenceRouter", "setInferenceEndpoints", { document }),\n`,
    "preload desktop.agent.setInferenceEndpoints",
  );
  return next;
}

function patchRenderer(source) {
  const start = source.indexOf("const RRouterProviders=[");
  const end = source.indexOf("function Sa(s){");
  if (start < 0 || end < 0 || end <= start) throw new Error("renderer RRouterProviders/Sa anchors missing");
  return source.slice(0, start) + COMPONENT_SOURCE.trimStart() + source.slice(end);
}

async function writeIfChanged(target, next) {
  const previous = await readFile(target, "utf8");
  if (previous === next) return false;
  await writeFile(target, next);
  return true;
}

export async function patchInferenceEndpointsAsar({ linuxRoot = LINUX, winRoot = WIN } = {}) {
  const iife = await bundleInferenceEndpoints();
  const files = {
    main: path.join(linuxRoot, "dist/electron-main/main.cjs"),
    host: path.join(linuxRoot, "dist/host/host-main.cjs"),
    preload: path.join(linuxRoot, "dist/electron-preload/preload.cjs"),
    renderer: path.join(linuxRoot, "dist/renderer/assets/index-BlqerJhg.js"),
  };
  const main = await patchElectronMain(await readFile(files.main, "utf8"), iife);
  const host = await patchHostMain(await readFile(files.host, "utf8"), iife);
  const preload = patchPreload(await readFile(files.preload, "utf8"));
  const renderer = patchRenderer(await readFile(files.renderer, "utf8"));
  for (const [label, needle] of [
    ["main setInferenceEndpoints", "setInferenceEndpoints: async (raw)"],
    ["main skip empty secrets", "sentCount === 0 && removeKeys.length === 0"],
    ["main unsigned slot", 'getAccountScope() ?? LOCAL_UNSIGNED_ACCOUNT_SLOT'],
    ["host __sandIE", "__sandIE.parseInferenceEndpointsDocument"],
    ["host merge secrets", "opts?.merge === true"],
    ["host resolvedApiEndpoint", "function resolvedApiEndpoint(role)"],
    ["host endpointForRole", "endpointForRole"],
    ["host compact session", 'createProviderPromptSession(inferenceProvider, "compact")'],
    ["host fallback chain", "retryEndpointChain"],
    ["host persistSticky", "function persistSticky("],
    ["renderer Models", 'title:"Models"'],
    ["renderer Assignments", 'title:"Assignments"'],
    ["host context window usage", "maxTokens: contextWindow"],
    ["host compact override", "unusedPercentTokensThresholdToStartBackgroundSummarization"],
    ["host current model fallback", "openai/gpt-5.6-sol"],
    ["preload setInferenceEndpoints", 'setInferenceEndpoints: (document) => gatedCall("inferenceRouter", "setInferenceEndpoints"'],
    ["renderer Chat section", 'label:"Chat"'],
    ["renderer Compress section", 'label:"Compress"'],
    ["renderer Fallback section", "Add fallback"],
    ["renderer RRouterEndpoints", "function RRouterEndpoints()"],
    ["renderer form compress", "Compress at"],
    ["renderer current model", "gpt-5.6-sol"],
    ["renderer no json textarea", "Endpoints JSON"],
    ["renderer no inline apiKey field", '"apiKey":'],
  ]) {
    const haystack = label.startsWith("main") ? main : label.startsWith("host") ? host : label.startsWith("preload") ? preload : renderer;
    if (label === "renderer no inline apiKey field") {
      if (haystack.includes('"apiKey":')) throw new Error("renderer still contains inline apiKey field");
      continue;
    }
    if (label === "renderer no json textarea") {
      if (haystack.includes("Endpoints JSON")) throw new Error("renderer still contains Endpoints JSON");
      continue;
    }
    if (!haystack.includes(needle)) throw new Error(`patched ${label} missing ${needle}`);
  }
  await writeIfChanged(files.main, main);
  await writeIfChanged(files.host, host);
  await writeIfChanged(files.preload, preload);
  await writeIfChanged(files.renderer, renderer);
  const copies = [
    "dist/electron-main/main.cjs",
    "dist/host/host-main.cjs",
    "dist/electron-preload/preload.cjs",
    "dist/renderer/assets/index-BlqerJhg.js",
  ];
  for (const relative of copies) {
    await cp(path.join(linuxRoot, relative), path.join(winRoot, relative));
  }
  return { linuxRoot, winRoot, copies };
}

const invokedAsMain = process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedAsMain) {
  const result = await patchInferenceEndpointsAsar();
  console.log(JSON.stringify(result, null, 2));
}

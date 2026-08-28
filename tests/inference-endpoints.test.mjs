import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ["source/shared/inference-endpoints.ts"],
    format: "esm",
    platform: "node",
    write: false,
    packages: "external",
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error("esbuild produced no output");
  return import(`data:text/javascript;base64,${Buffer.from(file.text).toString("base64")}`);
}

test("endpoints JSON keeps secret names, key roster, and rejects inline keys", async () => {
  const {
    documentFromPreset,
    emptyInferenceEndpointsDocument,
    parseInferenceEndpointsDocument,
    publicInferenceEndpointsDocument,
  } = await load();
  const custom = emptyInferenceEndpointsDocument();
  assert.equal(custom.active, "custom");
  assert.equal(custom.endpoints[0]?.apiKeySecret, "CUSTOM_API_KEY");
  assert.equal(parseInferenceEndpointsDocument({ schemaVersion: 1, active: "openai", endpoints: [{ id: "openai", kind: "openai-compatible", baseURL: "https://api.openai.com/v1", apiKeySecret: "sk-live-not-a-name", model: "gpt-4o" }] }), undefined);
  assert.equal(parseInferenceEndpointsDocument({ schemaVersion: 1, active: "openai", apiKey: "sk-secret", endpoints: [{ id: "openai", kind: "openai-compatible", baseURL: "https://api.openai.com/v1", apiKeySecret: "OPENAI_API_KEY", model: "gpt-4o" }] }), undefined);
  assert.equal(parseInferenceEndpointsDocument({ schemaVersion: 1, active: "openai", endpoints: [{ id: "openai", kind: "openai-compatible", baseURL: "https://api.openai.com/v1", apiKey: "sk-secret", apiKeySecret: "OPENAI_API_KEY", model: "gpt-4o" }] }), undefined);
  const openai = documentFromPreset("openai");
  assert.deepEqual(publicInferenceEndpointsDocument(openai), openai);
  assert.equal(JSON.stringify(openai).includes("sk-"), false);
  assert.equal(openai.endpoints[0]?.model, "gpt-5.6-sol");
  assert.equal(openai.endpoints[0]?.contextWindow, 1_050_000);
  assert.equal(openai.endpoints[0]?.reasoningEffort, "medium");
  const roster = parseInferenceEndpointsDocument({
    schemaVersion: 1,
    active: "model-1",
    keys: [{ id: "KEY_1", label: "Empero" }, { id: "KEY_2", label: "NewAPI" }],
    endpoints: [
      { id: "model-1", kind: "openai-compatible", baseURL: "https://a.example/v1", apiKeySecret: "KEY_1", model: "m1" },
      { id: "model-2", kind: "openai-compatible", baseURL: "http://127.0.0.1:3000/v1", apiKeySecret: "KEY_2", model: "m2" },
      { id: "model-3", kind: "openai-compatible", baseURL: "https://a.example/v1", apiKeySecret: "KEY_1", model: "m3" },
    ],
  });
  assert.equal(roster?.keys?.length, 2);
  assert.equal(roster?.endpoints.find((item) => item.id === "model-2")?.apiKeySecret, "KEY_2");
  assert.equal(roster?.endpoints.filter((item) => item.apiKeySecret === "KEY_1").length, 2);
  assert.equal(parseInferenceEndpointsDocument({
    schemaVersion: 1,
    active: "model-1",
    keys: [{ id: "KEY_1", apiKey: "sk-secret" }],
    endpoints: [{ id: "model-1", kind: "openai-compatible", baseURL: "https://a.example/v1", apiKeySecret: "KEY_1", model: "m1" }],
  }), undefined);
});

test("catalog uses current 2026 model IDs", async () => {
  const { INFERENCE_PROVIDER_CATALOG, emptyInferenceEndpointsDocument, compactUnusedFraction, effectiveContextWindow, parseInferenceEndpointsDocument } = await load();
  const ids = INFERENCE_PROVIDER_CATALOG.flatMap((provider) => provider.models.map((model) => model.id)).join("\n");
  assert.match(ids, /gpt-5\.6-sol/);
  assert.match(ids, /claude-opus-5/);
  assert.match(ids, /deepseek-v4-pro/);
  assert.match(ids, /grok-4\.6/);
  assert.equal(ids.includes("gpt-4o"), false);
  assert.equal(ids.includes("deepseek-chat"), false);
  assert.equal(ids.includes("llama-3.3"), false);
  const empty = emptyInferenceEndpointsDocument();
  assert.equal(empty.endpoints[0]?.id, "custom");
  assert.equal(empty.endpoints[0]?.baseURL, "https://example.invalid/v1");
  assert.equal(empty.endpoints[0]?.model, "model-id");
  assert.equal(effectiveContextWindow(empty.endpoints[0]), 128_000);
  assert.equal(compactUnusedFraction(empty.endpoints[0]), 0.25);
  const tight = parseInferenceEndpointsDocument({
    schemaVersion: 1,
    active: "openai",
    endpoints: [{
      id: "openai",
      kind: "openai-compatible",
      baseURL: "https://api.openai.com/v1",
      apiKeySecret: "OPENAI_API_KEY",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      contextWindow: 1_050_000,
      maxInputTokens: 700_000,
      maxOutputTokens: 128_000,
      compactAt: 0.9,
    }],
  });
  assert.equal(tight?.endpoints[0]?.reasoningEffort, "high");
  assert.equal(tight?.endpoints[0]?.contextWindow, 1_050_000);
  assert.ok(tight?.endpoints[0]);
  assert.equal(compactUnusedFraction(tight.endpoints[0]), 0.1);
});

test("pasted /chat/completions URLs become the OpenAI-compatible /v1 prefix", async () => {
  const { normalizeOpenAICompatibleBaseUrl, parseInferenceEndpointsDocument, rewriteLoopbackBaseUrlForBoxHost } = await load();
  assert.equal(normalizeOpenAICompatibleBaseUrl("https://token.sensenova.cn/v1/chat/completions"), "https://token.sensenova.cn/v1");
  assert.equal(normalizeOpenAICompatibleBaseUrl("https://token.sensenova.cn/v1/chat/completions/"), "https://token.sensenova.cn/v1");
  assert.equal(normalizeOpenAICompatibleBaseUrl("https://api.openai.com/v1"), "https://api.openai.com/v1");
  assert.equal(normalizeOpenAICompatibleBaseUrl("https://api.z.ai/api/paas/v4"), "https://api.z.ai/api/paas/v4");
  assert.equal(normalizeOpenAICompatibleBaseUrl("http://127.0.0.1:3000/v1"), "http://127.0.0.1:3000/v1");
  assert.equal(rewriteLoopbackBaseUrlForBoxHost("https://token.sensenova.cn/v1/chat/completions", false), "https://token.sensenova.cn/v1");
  const parsed = parseInferenceEndpointsDocument({
    schemaVersion: 1,
    active: "model-5",
    endpoints: [{
      id: "model-5",
      kind: "openai-compatible",
      baseURL: "https://token.sensenova.cn/v1/chat/completions",
      apiKeySecret: "KEY_2",
      model: "glm-5.2",
    }],
  });
  assert.equal(parsed?.endpoints[0]?.baseURL, "https://token.sensenova.cn/v1");
});

test("loopback API URLs rewrite to the Docker host only inside the box", async () => {
  const { rewriteLoopbackBaseUrlForBoxHost } = await load();
  assert.equal(rewriteLoopbackBaseUrlForBoxHost("http://127.0.0.1:3000/v1", false), "http://127.0.0.1:3000/v1");
  assert.equal(rewriteLoopbackBaseUrlForBoxHost("http://127.0.0.1:3000/v1", true), "http://host.docker.internal:3000/v1");
  assert.equal(rewriteLoopbackBaseUrlForBoxHost("http://localhost:3000/v1", true), "http://host.docker.internal:3000/v1");
  assert.equal(rewriteLoopbackBaseUrlForBoxHost("https://openrouter.ai/api/v1", true), "https://openrouter.ai/api/v1");
});

test("preset documents round-trip", async () => {
  const { documentFromPreset, parseInferenceEndpointsDocument } = await load();
  const parsed = parseInferenceEndpointsDocument(JSON.stringify(documentFromPreset("deepseek")));
  assert.equal(parsed?.active, "deepseek");
  assert.equal(parsed?.endpoints[0]?.baseURL, "https://api.deepseek.com/v1");
  assert.equal(parsed?.endpoints[0]?.model, "deepseek-v4-pro");
});

test("roles select chat, compact, and fallback endpoints", async () => {
  const { parseInferenceEndpointsDocument, endpointForRole, distinctEndpointForRole, imageGenerationEndpoint, inferenceEndpointRoles } = await load();
  const document = parseInferenceEndpointsDocument({
    schemaVersion: 1,
    active: "chat",
    roles: { chat: "chat", compact: "compact", fallback: "fallback" },
    endpoints: [
      { id: "chat", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: "openai/gpt-5.6-sol", contextWindow: 1_050_000, compactAt: 0.75 },
      { id: "compact", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: "google/gemini-3.7-flash", contextWindow: 1_048_576 },
      { id: "fallback", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: "deepseek/deepseek-v4-pro", contextWindow: 1_000_000 },
    ],
  });
  assert.equal(endpointForRole(document, "chat").model, "openai/gpt-5.6-sol");
  assert.equal(endpointForRole(document, "compact").model, "google/gemini-3.7-flash");
  assert.equal(distinctEndpointForRole(document, "fallback")?.model, "deepseek/deepseek-v4-pro");
  const legacy = parseInferenceEndpointsDocument({
    schemaVersion: 1,
    active: "openrouter",
    endpoints: [{ id: "openrouter", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: "openai/gpt-5.6-sol" }],
  });
  assert.equal(endpointForRole(legacy, "compact").id, "openrouter");
  assert.equal(distinctEndpointForRole(legacy, "fallback"), undefined);
});

test("image role is assigned from the pool and never falls back to the chat LLM", async () => {
  const { parseInferenceEndpointsDocument, imageGenerationEndpoint, inferenceEndpointRoles, endpointForRole } = await load();
  const unset = parseInferenceEndpointsDocument({
    schemaVersion: 1,
    active: "chat",
    roles: { chat: "chat" },
    endpoints: [
      { id: "chat", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: "openai/gpt-5.6-sol" },
      { id: "image", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: "openai/dall-e-3" },
    ],
  });
  assert.equal(imageGenerationEndpoint(unset), undefined);
  const assigned = parseInferenceEndpointsDocument({
    schemaVersion: 1,
    active: "chat",
    roles: { chat: "chat", image: "image" },
    endpoints: [
      { id: "chat", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: "openai/gpt-5.6-sol" },
      { id: "image", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: "openai/dall-e-3" },
    ],
  });
  assert.equal(imageGenerationEndpoint(assigned)?.model, "openai/dall-e-3");
  assert.equal(inferenceEndpointRoles(assigned).image, "image");
  assert.notEqual(imageGenerationEndpoint(assigned)?.model, endpointForRole(assigned, "chat").model);
});

test("fallback chain tries listed endpoints in order", async () => {
  const { parseInferenceEndpointsDocument, retryEndpointChain, fallbackEndpointIds } = await load();
  const document = parseInferenceEndpointsDocument({
    schemaVersion: 1,
    active: "chat",
    roles: { chat: "chat", compact: "compact", fallbacks: ["fallback", "fallback-2"] },
    endpoints: [
      { id: "chat", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: "openai/gpt-5.6-sol" },
      { id: "compact", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: "google/gemini-3.7-flash" },
      { id: "fallback", kind: "openai-compatible", baseURL: "https://relay-a.example/v1", apiKeySecret: "RELAY_A_API_KEY", model: "model-a" },
      { id: "fallback-2", kind: "openai-compatible", baseURL: "https://relay-b.example/v1", apiKeySecret: "RELAY_B_API_KEY", model: "model-b" },
    ],
  });
  assert.deepEqual(fallbackEndpointIds(document), ["fallback", "fallback-2"]);
  assert.deepEqual(retryEndpointChain(document, "chat").map((endpoint) => endpoint.id), ["chat", "fallback", "fallback-2"]);
  assert.deepEqual(retryEndpointChain(document, "compact").map((endpoint) => endpoint.id), ["compact", "chat", "fallback", "fallback-2"]);
});

test("chat stays first unless that chat slot itself failed twice", async () => {
  const { parseInferenceEndpointsDocument, retryEndpointChain } = await load();
  const base = {
    schemaVersion: 1,
    active: "chat",
    roles: { chat: "chat", fallbacks: ["fallback", "fallback-2"] },
    endpoints: [
      { id: "chat", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeySecret: "OPENROUTER_API_KEY", model: "openai/gpt-5.6-sol" },
      { id: "fallback", kind: "openai-compatible", baseURL: "https://relay-a.example/v1", apiKeySecret: "RELAY_A_API_KEY", model: "model-a" },
      { id: "fallback-2", kind: "openai-compatible", baseURL: "https://relay-b.example/v1", apiKeySecret: "RELAY_B_API_KEY", model: "model-b" },
    ],
  };
  const stuckOnFallback = parseInferenceEndpointsDocument({ ...base, sticky: { chat: "fallback", failures: { fallback: 0 } } });
  assert.deepEqual(retryEndpointChain(stuckOnFallback, "chat").map((endpoint) => endpoint.id), ["chat", "fallback", "fallback-2"]);
  const chatFailedOnce = parseInferenceEndpointsDocument({ ...base, sticky: { chat: "fallback", failures: { chat: 1 } } });
  assert.deepEqual(retryEndpointChain(chatFailedOnce, "chat").map((endpoint) => endpoint.id), ["chat", "fallback", "fallback-2"]);
  const chatFailedTwice = parseInferenceEndpointsDocument({ ...base, sticky: { chat: "fallback", failures: { chat: 2 } } });
  assert.deepEqual(retryEndpointChain(chatFailedTwice, "chat").map((endpoint) => endpoint.id), ["fallback", "fallback-2", "chat"]);
});

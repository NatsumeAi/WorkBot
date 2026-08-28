import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadInferenceRouter() {
  const source = await readFile(path.join(repoRoot, "source/shared/inference-router.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("missing provider is API; a saved pool is never Cursor", async () => {
  const { resolveSandInferenceProvider, usesLocalInferenceClock } = await loadInferenceRouter();
  assert.equal(resolveSandInferenceProvider(undefined), "openrouter");
  assert.equal(resolveSandInferenceProvider(null), "openrouter");
  assert.equal(resolveSandInferenceProvider("nope"), "openrouter");
  assert.equal(resolveSandInferenceProvider("openrouter"), "openrouter");
  assert.equal(resolveSandInferenceProvider("cursor", { endpoints: [{ id: "model-1" }] }), "openrouter");
  assert.equal(resolveSandInferenceProvider("cursor", { endpoints: [] }), "cursor");
  assert.equal(resolveSandInferenceProvider("claude-code"), "claude-code");
  assert.equal(usesLocalInferenceClock("cursor", { endpoints: [{ id: "model-1" }] }), true);
  assert.equal(usesLocalInferenceClock("cursor", { endpoints: [] }), false);
  assert.equal(usesLocalInferenceClock("openrouter"), true);
});

test("persist recovers the journal before the first prepare", async () => {
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ["source/host/runner/turn-settle.ts"],
    format: "esm",
    platform: "node",
    write: false,
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error("esbuild produced no turn-settle bundle");
  const { createTurnSettle } = await import(`data:text/javascript;base64,${Buffer.from(file.text).toString("base64")}`);
  const order = [];
  const settle = createTurnSettle({
    isSubagentRunner: false,
    transcriptMirror: {
      async recover() { order.push("recover"); },
      async prepareCheckpoint() { order.push("prepare"); },
      async abortCheckpoint() {},
      async commitCheckpoint() { order.push("commit"); },
      async skipCheckpoint() { order.push("skip"); },
    },
    getTranscriptId: () => "bot",
    getBlobStore: () => ({}),
    agentStore: () => ({
      handleCheckpoint: async () => {},
      getMetadata: () => undefined,
    }),
    setLocalState() {},
    ownsRunner: () => true,
    isRunSuperseded: () => false,
    latestPromptMessages: () => [],
    persistAnnouncedAgentProfile() {},
  }, { conversationId: "bot", profilePromptSnapshots: {} });
  const checkpoint = { summaryArchives: [], turnTimings: [] };
  settle.noteBaseState(checkpoint);
  await settle.persistStepCheckpoint({}, checkpoint);
  await settle.persistStepCheckpoint({}, checkpoint);
  assert.deepEqual(order, ["recover", "prepare", "commit", "prepare", "commit"]);
});

test("setInferenceProvider cannot persist Cursor when a model pool exists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openbot-provider-lock-"));
  const settingsPath = path.join(dir, "settings.json");
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ["source/shared/node/settings/sand-settings-store.ts"],
    format: "esm",
    platform: "node",
    write: false,
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error("esbuild produced no settings store bundle");
  const { SandSettingsStore } = await import(`data:text/javascript;base64,${Buffer.from(file.text).toString("base64")}`);
  const store = new SandSettingsStore(settingsPath);
  store.setInferenceEndpoints({ schemaVersion: 1, endpoints: [{ id: "model-1", kind: "openai-compatible", baseURL: "http://127.0.0.1:3000/v1", model: "DSV4PRO", apiKeySecret: "CUSTOM_API_KEY" }], active: "model-1" });
  store.setInferenceProvider("cursor");
  assert.equal(store.getInferenceProvider(), "openrouter");
  const raw = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(raw.inferenceProvider, "openrouter");
});

test("source desktop reads box provider and defaults to API", async () => {
  const main = await readFile(path.join(repoRoot, "source/electron-main/main-edge.ts"), "utf8");
  const router = await readFile(path.join(repoRoot, "source/shared/inference-router.ts"), "utf8");
  const settle = await readFile(path.join(repoRoot, "source/host/runner/turn-settle.ts"), "utf8");
  const composition = await readFile(path.join(repoRoot, "source/host/host-runner-composition.ts"), "utf8");
  const mirror = await readFile(path.join(repoRoot, "source/host/transcript-mirror/transcript-mirror-router.ts"), "utf8");
  const providers = await readFile(path.join(repoRoot, "source/host/extensions/inference/provider-session.ts"), "utf8");
  const retry = await readFile(path.join(repoRoot, "source/host/extensions/inference/inference-retry.ts"), "utf8");
  const cursorSession = await readFile(path.join(repoRoot, "source/host/extensions/inference/cursor-session.ts"), "utf8");
  const settings = await readFile(path.join(repoRoot, "source/host/extensions/settings/settings-service.ts"), "utf8");
  const panel = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/router-panel.tsx"), "utf8");
  assert.equal(main.includes('inferenceProvider ?? "cursor"'), false);
  assert.match(main, /settings\.inferenceProvider/);
  assert.match(router, /value === "cursor" && Array\.isArray\(endpoints\?\.endpoints\)/);
  assert.match(settle, /typeof preparedTranscriptMirror\.recover === "function"/);
  assert.match(composition, /isJournalEnabled: async \(\) => false/);
  assert.match(mirror, /if \(!await this\.isJournalEnabled\(\)\) return "legacy"/);
  assert.match(retry, /status === 401 \|\| status === 403\) return false/);
  assert.match(retry, /timeout\|ETIMEDOUT\|ECONNRESET\|ECONNREFUSED\|ENOTFOUND\|fetch failed\|EAI_AGAIN/);
  assert.match(providers, /persistedSecrets\(\)\[name\]\?\.trim\(\)/);
  assert.match(providers, /fromFile != null && fromFile.length > 0 \? fromFile : undefined/);
  assert.doesNotMatch(providers, /process\.env\[name\]/);
  const imageGen = await readFile(path.join(repoRoot, "source/host/extensions/inference/api-generate-image.ts"), "utf8");
  assert.doesNotMatch(imageGen, /process\.env\[name\]/);
  assert.match(cursorSession, /hostInferenceCanRunWithoutCursor\(\)/);
  assert.match(settings, /key === "inferenceProvider" \|\| key === "inferenceEndpoints"/);
  assert.match(panel, /value: "openrouter", label: "API"/);
});

test("401, timeout, and fetch failed never retry another endpoint", async () => {
  const { isRetryableInferenceError } = await import(
    `data:text/javascript;base64,${Buffer.from((await transform(
      await readFile(path.join(repoRoot, "source/host/extensions/inference/inference-retry.ts"), "utf8"),
      { format: "esm", loader: "ts", target: "es2022" },
    )).code).toString("base64")}`
  );
  assert.equal(isRetryableInferenceError({ status: 401 }), false);
  assert.equal(isRetryableInferenceError({ status: 403 }), false);
  assert.equal(isRetryableInferenceError(new Error("ETIMEDOUT")), false);
  assert.equal(isRetryableInferenceError(new Error("fetch failed")), false);
  assert.equal(isRetryableInferenceError(new Error("timeout")), false);
  assert.equal(isRetryableInferenceError({ status: 429 }), true);
  assert.equal(isRetryableInferenceError({ status: 503 }), true);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routerSourcePath = path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/router.ts");

async function loadOnboardingModule() {
  const source = await readFile(path.join(repoRoot, "frontend/src/recovered/features/onboarding/signed-in/model.ts"), "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

async function loadRouterModule() {
  const source = await readFile(routerSourcePath, "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("router provider preference defaults to API and round-trips every provider", async () => {
  const router = await loadRouterModule();
  assert.deepEqual(router.ROUTER_PROVIDERS.map(({ id }) => id), ["openrouter", "claude-code", "codex", "cursor"]);
  assert.equal(router.ROUTER_PROVIDERS[0].label, "API");
  assert.equal(router.parseRouterProviderPreference(null), "openrouter");
  assert.equal(router.parseRouterProviderPreference("not-json"), "openrouter");
  assert.equal(router.parseRouterProviderPreference(JSON.stringify({ schemaVersion: 1, provider: "unknown" })), "openrouter");

  let stored = null;
  const persistence = {
    async read(key) {
      assert.equal(key, router.ROUTER_PROVIDER_PERSISTENCE_KEY);
      return stored;
    },
    async write(key, value) {
      assert.equal(key, router.ROUTER_PROVIDER_PERSISTENCE_KEY);
      stored = value;
    }
  };
  for (const provider of router.ROUTER_PROVIDERS) {
    await router.saveRouterProvider(persistence, provider.id);
    assert.equal(await router.loadRouterProvider(persistence), provider.id);
  }
});

async function loadRecoveredPoolSave() {
  const source = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/router-pool.ts"), "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("one Save writes the open editor, pasted key, and pool document", async () => {
  const { prepareRouterPoolSave } = await loadRecoveredPoolSave();
  const slot = (id, extra = {}) => ({
    id,
    name: extra.name ?? id,
    provider: "custom",
    baseURL: extra.baseURL ?? "https://api.example.test/v1",
    secret: extra.secret ?? "CUSTOM_API_KEY",
    model: extra.model ?? "old-model",
    effort: "medium",
    contextWindow: "128000",
    maxInput: "64000",
    maxOutput: "32000",
    key: extra.key ?? "",
  });
  const prepared = prepareRouterPoolSave({
    pool: [slot("model-1")],
    keys: [{ id: "CUSTOM_API_KEY", label: "Empero", key: "" }],
    editing: slot("model-2", { name: "Kimi", model: "kimi-k3", key: "sk-test-key" }),
    chatId: "model-1",
    compactId: "",
    imageId: "",
    fallbackIds: [],
    compactAt: "0.75",
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.pool.length, 2);
  assert.equal(prepared.secrets.CUSTOM_API_KEY, "sk-test-key");
  assert.equal(prepared.document.endpoints.find((item) => item.id === "model-2")?.model, "kimi-k3");
  assert.equal(prepared.document.active, "model-1");
  assert.equal(prepared.document.endpoints[0]?.compactAt, 0.75);
  assert.deepEqual(prepared.document.keys, [{ id: "CUSTOM_API_KEY", label: "Empero" }]);
});

test("two keys stay two secrets; many models can share one key", async () => {
  const { nextKeyId, prepareRouterPoolSave } = await loadRecoveredPoolSave();
  assert.equal(nextKeyId([{ id: "CUSTOM_API_KEY" }]), "KEY_1");
  assert.equal(nextKeyId([{ id: "KEY_1" }, { id: "KEY_2" }]), "KEY_3");
  const slot = (id, secret) => ({
    id,
    name: id,
    provider: "custom",
    baseURL: secret === "KEY_2" ? "http://127.0.0.1:3000/v1" : "https://api.example.test/v1",
    secret,
    model: id,
    effort: "medium",
    contextWindow: "128000",
    maxInput: "64000",
    maxOutput: "32000",
    key: "",
  });
  const prepared = prepareRouterPoolSave({
    pool: [slot("model-1", "KEY_1"), slot("model-2", "KEY_2"), slot("model-3", "KEY_1")],
    keys: [
      { id: "KEY_1", label: "Empero", key: "sk-empero" },
      { id: "KEY_2", label: "NewAPI", key: "sk-newapi" },
    ],
    chatId: "model-1",
    compactId: "",
    imageId: "",
    fallbackIds: ["model-2"],
    compactAt: "0.5",
  });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.secrets, { KEY_1: "sk-empero", KEY_2: "sk-newapi" });
  assert.equal(prepared.document.endpoints.find((item) => item.id === "model-1")?.apiKeySecret, "KEY_1");
  assert.equal(prepared.document.endpoints.find((item) => item.id === "model-2")?.apiKeySecret, "KEY_2");
  assert.equal(prepared.document.endpoints.find((item) => item.id === "model-3")?.apiKeySecret, "KEY_1");
  assert.equal(prepared.document.keys.length, 2);
});

test("settings registry exposes Router and Server with the native settings icon contract", async () => {
  const source = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/view.tsx"), "utf8");
  assert.match(source, /\{ id: "router", label: "Router", icon: "git-branch" \}/);
  assert.match(source, /\{ id: "server", label: "Server", icon: "server" \}/);
});

test("unsigned users enter the shell without a Cursor session", async () => {
  const production = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8");
  assert.match(production, /const showSignIn = false;/);
  assert.match(production, /rendererRosterAccountSlot\(account\)/);
  const rosterStore = await readFile(path.join(repoRoot, "frontend/src/recovered/features/access/cover/roster-snapshot-store.ts"), "utf8");
  assert.match(rosterStore, /UNSIGNED_ROSTER_ACCOUNT_SLOT = "local"/);
  assert.match(rosterStore, /function rendererRosterAccountSlot/);
  assert.match(production, /accessRosterStore\.connect\(accountSlot\)/);
  assert.doesNotMatch(production, /isSignedIn: true,/);
  const onboarding = await loadOnboardingModule();
  assert.equal(onboarding.resolveOnboardingRoute({ isSignedIn: false, hasSeenOnboarding: false, agentCount: 0 }), "onboarding");
  assert.equal(onboarding.resolveOnboardingRoute({ isSignedIn: false, hasSeenOnboarding: true, agentCount: 0 }), "shell");
  assert.equal(onboarding.resolveOnboardingRoute({ isSignedIn: false, hasSeenOnboarding: false, agentCount: 1 }), "shell");
});

test("settings renderer source does not insert duplicate prepareRouterPoolSave patches", async () => {
  const patchPath = path.join(repoRoot, "scripts/lib/patch-inference-endpoints-asar.mjs");
  const rendererPatchPath = path.join(repoRoot, "scripts/lib/router-renderer-patch.mjs");
  await assert.rejects(() => readFile(patchPath), /ENOENT/);
  await assert.rejects(() => readFile(rendererPatchPath), /ENOENT/);
});

test("recovered settings source declares prepareRouterPoolSave once with Keys and proxy copy", async () => {
  const pool = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/router-pool.ts"), "utf8");
  const panel = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/router-panel.tsx"), "utf8");
  const server = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/server.tsx"), "utf8");
  const surface = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/desktop-surface.tsx"), "utf8");
  assert.equal((pool.match(/export function prepareRouterPoolSave/g) ?? []).length, 1);
  assert.match(panel, /title="Keys"/);
  assert.match(panel, /title="Models"/);
  assert.match(panel, /title="Assignments"/);
  assert.match(panel, /Add key/);
  assert.match(panel, /Add model/);
  assert.match(panel, /\{busy \? "Saving…" : "Save"\}/);
  assert.match(server, /: "Install"\}/);
  assert.match(server, />Connect<\/SandButton>/);
  assert.match(server, /Save proxy/);
  assert.match(server, /127\.0\.0\.1 is always direct/);
  assert.doesNotMatch(server, /<option value="env">/);
  assert.match(surface, /from "\.\/router-panel"/);
  assert.match(surface, /setInferenceRouter\(next\)/);
});

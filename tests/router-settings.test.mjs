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

test("router provider preference defaults to Cursor and round-trips every provider", async () => {
  const router = await loadRouterModule();
  assert.deepEqual(router.ROUTER_PROVIDERS.map(({ id }) => id), ["cursor", "claude-code", "codex", "openrouter"]);
  assert.equal(router.parseRouterProviderPreference(null), "cursor");
  assert.equal(router.parseRouterProviderPreference("not-json"), "cursor");
  assert.equal(router.parseRouterProviderPreference(JSON.stringify({ schemaVersion: 1, provider: "unknown" })), "cursor");

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

test("settings registry exposes Router and Server with the native settings icon contract", async () => {
  const source = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/view.tsx"), "utf8");
  assert.match(source, /\{ id: "router", label: "Router", icon: "git-branch" \}/);
  assert.match(source, /\{ id: "server", label: "Server", icon: "server" \}/);
});

test("unsigned users enter the shell without a Cursor session", async () => {
  const {
    patchOriginalCursorBootGate,
    patchOriginalSettingsRegistry,
    patchOriginalSettingsPanel,
  } = await import("../scripts/lib/router-renderer-patch.mjs");
  const source = await readFile(path.join(repoRoot, "src/app/dist/renderer/assets/index-UbX-y3il.js"), "utf8");
  const patched = patchOriginalCursorBootGate(source);
  assert.match(source, /gate:r\?"sign-in":"onboarding"/);
  assert.match(patched, /if\(s!==!0\)return\{kind:"landed",gate:"shell"/);
  assert.doesNotMatch(patched, /gate:r\?"sign-in":"onboarding"/);
  assert.doesNotMatch(patched, /e\.gate==="shell"&&e\.sessionFact===!0/);
  assert.match(patched, /skipOnboarding:\(\)=>\{u\(\{kind:"skip-onboarding",isSignedIn:!1\}\)/);
  assert.doesNotMatch(patched, /Sign in to Cursor in settings, then ask anything/);
  assert.match(patched, /:"Ask anything\."/);
  assert.match(patched, /F=LMt\(e\)&&!B/);
  assert.doesNotMatch(patched, /F=LMt\(e\)&&!B&&o/);
  assert.match(patched, /Connect a server/);
  assert.match(patched, /Uf\.settings\(\{section:"server"\}\)/);
  assert.match(patched, /getSelfHostConnection\(\)\.then/);
  assert.match(patched, /sand\.opened-server-settings/);
  assert.match(patched, /Ae=Ne\.status\.kind==="logged-in"\|\|oe/);
  const panelSource = await readFile(path.join(repoRoot, "src/app/dist/renderer/assets/index-BlqerJhg.js"), "utf8");
  let ubx = patchOriginalSettingsRegistry(source);
  ubx = patchOriginalCursorBootGate(ubx);
  const panel = patchOriginalSettingsPanel(panelSource);
  assert.match(ubx, /id:"server",label:"Server"/);
  assert.match(ubx, /Connect a server/);
  assert.match(panel, /RServerPanel/);
  assert.match(panel, /label:" ",variant:"card"/);
  assert.match(panel, /overflowWrap:"anywhere"/);
  assert.doesNotMatch(panel, /gap:8,padding:13/);
  const production = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8");
  assert.match(production, /const showSignIn = false;/);
  assert.doesNotMatch(production, /isSignedIn: true,/);
  const onboarding = await loadOnboardingModule();
  assert.equal(onboarding.resolveOnboardingRoute({ isSignedIn: false, hasSeenOnboarding: false, agentCount: 0 }), "onboarding");
  assert.equal(onboarding.resolveOnboardingRoute({ isSignedIn: false, hasSeenOnboarding: true, agentCount: 0 }), "shell");
  assert.equal(onboarding.resolveOnboardingRoute({ isSignedIn: false, hasSeenOnboarding: false, agentCount: 1 }), "shell");
});

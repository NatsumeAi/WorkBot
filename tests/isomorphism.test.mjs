import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadSource(entry) {
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    platform: "node",
    write: false,
    packages: "external",
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error(`esbuild produced no output for ${entry}`);
  return import(`data:text/javascript;base64,${Buffer.from(file.text).toString("base64")}`);
}

test("platform catalog lists every target and android live vs unsupported capabilities", async () => {
  const catalog = JSON.parse(await readFile(path.join(repoRoot, "manifests", "platforms.json"), "utf8"));
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(
    catalog.targets.map((target) => target.id),
    ["macos-arm64", "windows-x64", "linux-x64", "android"],
  );
  const android = catalog.targets.find((target) => target.id === "android");
  assert.equal(android.family, "thin-client");
  assert.equal(android.status, "implemented");
  assert.deepEqual(android.capabilities, {
    conversation: "live",
    auth: "live",
    inferenceRouter: "live",
    secrets: "live",
    mcp: "unsupported",
    remoteBox: "live",
    localDockerVm: "unsupported",
    vncComputer: "unsupported",
    windowChrome: "unsupported",
    webauthnSigner: "unsupported",
  });
  const macos = catalog.targets.find((target) => target.id === "macos-arm64");
  for (const capability of catalog.capabilities) {
    assert.equal(macos.capabilities[capability], "live");
  }
});

test("android capability set still exposes every DesktopBridge top-level key", async () => {
  const [{ DESKTOP_BRIDGE_TOP_LEVEL_KEYS: frontendKeys }, runtime, catalogJson] = await Promise.all([
    loadSource("frontend/src/recovered/contracts/desktop-bridge.ts"),
    loadSource("source/client-runtime/index.ts"),
    readFile(path.join(repoRoot, "manifests", "platforms.json"), "utf8"),
  ]);
  const android = JSON.parse(catalogJson).targets.find((target) => target.id === "android");
  const { client } = runtime.createMemoryTransportPair();
  const desktop = runtime.createDesktopBridge({ transport: client, target: android });
  assert.deepEqual([...runtime.DESKTOP_BRIDGE_TOP_LEVEL_KEYS], [...frontendKeys]);
  for (const key of frontendKeys) {
    assert.notEqual(desktop[key], undefined, `missing DesktopBridge key ${key}`);
    assert.notEqual(typeof desktop[key], "undefined");
  }
  assert.equal(typeof desktop.mcp.list, "function");
  assert.equal(typeof desktop.agent.getInferenceRouter, "function");
  assert.equal(typeof desktop.agent.getBoxRuntime, "function");
  assert.equal(typeof desktop.agent.getSelfHostConnection, "function");
  assert.equal(typeof desktop.agent.getOutboundProxy, "function");
  assert.equal(typeof desktop.agent.setOutboundProxy, "function");
  assert.equal(typeof desktop.windowControls.minimize, "function");
  assert.equal(typeof desktop.foreverBox.forceRecreate, "function");
});

test("coordinator frames round-trip on a fake Transport without Electron", async () => {
  const catalog = JSON.parse(await readFile(path.join(repoRoot, "manifests", "platforms.json"), "utf8"));
  const android = catalog.targets.find((target) => target.id === "android");
  const runtime = await loadSource("source/client-runtime/index.ts");
  const { client, server } = runtime.createMemoryTransportPair();
  const seen = [];
  const detach = server.subscribe((message) => {
    const { channel, frame } = message;
    if (frame.kind === "lifecycle" && frame.phase === "hello") {
      server.post({ channel, frame: { kind: "lifecycle", phase: "ready", protocolVersion: frame.protocolVersion } });
      return;
    }
    if (frame.kind !== "request") return;
    seen.push([channel, frame.method]);
    let value = { method: frame.method };
    if (frame.method === "getInferenceRouter") value = { provider: "openrouter", usage: null, local: {} };
    if (frame.method === "listAgents") value = [{ id: "agent-1", name: "Ada" }];
    server.post({
      channel,
      frame: { kind: "reply", requestId: frame.requestId, outcome: { status: "ok", value } },
    });
  });
  try {
    const desktop = runtime.createDesktopBridge({ transport: client, target: android });
    const router = await desktop.agent.getInferenceRouter();
    assert.equal(router.provider, "openrouter");
    const coordinator = runtime.createCoordinatorClient(client);
    const agents = await coordinator.request("listAgents", {});
    assert.deepEqual(agents, [{ id: "agent-1", name: "Ada" }]);
    assert.deepEqual(seen, [
      ["main", "getInferenceRouter"],
      ["coordinator", "listAgents"],
    ]);
  } finally {
    detach();
  }
});

test("unsupported methods return unsupported-capability instead of throwing is not a function", async () => {
  const catalog = JSON.parse(await readFile(path.join(repoRoot, "manifests", "platforms.json"), "utf8"));
  const android = catalog.targets.find((target) => target.id === "android");
  const runtime = await loadSource("source/client-runtime/index.ts");
  const { client } = runtime.createMemoryTransportPair();
  const desktop = runtime.createDesktopBridge({ transport: client, target: android });
  await assert.rejects(
    () => desktop.mcp.list(),
    (error) => error?.code === "unsupported-capability" && error.capability === "mcp",
  );
  await assert.rejects(
    () => desktop.agent.getBoxRuntime(),
    (error) => error?.code === "unsupported-capability" && error.capability === "localDockerVm",
  );
  await assert.rejects(
    () => desktop.windowControls.minimize(),
    (error) => error?.code === "unsupported-capability" && error.capability === "windowChrome",
  );
  assert.equal(typeof desktop.mcp.list, "function");
  assert.doesNotMatch(String(desktop.mcp.list), /is not a function/);
});

test("bootstrap hydrates asar without requiring a macOS-only package entry", async () => {
  const [bootstrap, pkg] = await Promise.all([
    readFile(path.join(repoRoot, "scripts", "bootstrap-runtime.mjs"), "utf8"),
    readFile(path.join(repoRoot, "package.json"), "utf8"),
  ]);
  assert.match(bootstrap, /GROK_BOT_018_ASAR/);
  assert.match(bootstrap, /hydrateSourcePayloadFromAsar/);
  assert.match(bootstrap, /Missing 0\.18\.0 app\.asar payload/);
  assert.match(bootstrap, /const archivedDigest = await sha256\(archivedDmg\)/);
  assert.match(bootstrap, /await fetch\(dmgUrl/);
  assert.ok(bootstrap.indexOf("await copyFile(archivedDmg, cachedDmg)") < bootstrap.indexOf("await fetch(dmgUrl"));
  assert.match(JSON.parse(pkg).scripts.package, /scripts\/package\.mjs/);
});

test("android shell does not relay through a desktop session-host", async () => {
  const source = await readFile(path.join(repoRoot, "targets", "android", "src", "desktop-shell.ts"), "utf8");
  assert.doesNotMatch(source, /session-host|sessionHost|17890/);
  assert.doesNotMatch(source, /connectWebSocketTransport/);
  assert.doesNotMatch(source, /MobileBridge/);
});

test("android packaging stages the shared client-UI, never its own frontend build", async () => {
  const packager = await readFile(path.join(repoRoot, "scripts", "package-android.mjs"), "utf8");
  assert.match(packager, /buildClientUi/);
  assert.match(packager, /installClientUiIntoWebRoot/);
  assert.match(packager, /stagedWebRootFindings/);
  assert.match(packager, /openbot-android\.apk/);
  assert.match(packager, /assembleRelease/);
  assert.doesNotMatch(packager, /desktop-shell\.ts/);
  assert.doesNotMatch(packager, /vite/);
  assert.doesNotMatch(packager, /frontend-shell/);
  const electronPackaging = await readFile(path.join(repoRoot, "scripts", "clean-build.mjs"), "utf8");
  assert.match(electronPackaging, /installClientOverridesIntoStage/);
});

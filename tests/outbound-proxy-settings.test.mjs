import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("outbound proxy is Off or Custom URL, never env vars, 127 always direct", async () => {
  const table = await readFile(path.join(repoRoot, "source/shared/rpc/main.ts"), "utf8");
  const edge = await readFile(path.join(repoRoot, "source/electron-main/main-edge.ts"), "utf8");
  const capabilities = await readFile(path.join(repoRoot, "source/shared/capability-methods.ts"), "utf8");
  const bridge = await readFile(path.join(repoRoot, "source/client-runtime/desktop-bridge.ts"), "utf8");
  const store = await readFile(path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts"), "utf8");
  const settings = await readFile(path.join(repoRoot, "source/host/extensions/settings/settings-service.ts"), "utf8");
  const proxy = await readFile(path.join(repoRoot, "source/shared/outbound-proxy.ts"), "utf8");
  const web = await readFile(path.join(repoRoot, "source/host/extensions/inference/box-web-tools.ts"), "utf8");
  const image = await readFile(path.join(repoRoot, "source/host/extensions/inference/api-generate-image.ts"), "utf8");

  for (const method of ["getOutboundProxy", "setOutboundProxy"]) {
    assert.match(table, new RegExp(`${method}: \\{ args:`));
    assert.match(edge, new RegExp(`${method}:`));
    assert.match(capabilities, new RegExp(`${method}: "remoteBox"`));
  }
  assert.match(bridge, /getOutboundProxy: \(\) => gatedCall\("remoteBox", "getOutboundProxy"\)/);
  assert.match(bridge, /setOutboundProxy: \(settings: unknown\) => gatedCall\("remoteBox", "setOutboundProxy", settings\)/);
  assert.match(store, /getOutboundProxyMode\(\): SandOutboundProxyMode \{ return this\.load\(\)\.outboundProxyMode \?\? "off"/);
  assert.match(settings, /applyOutboundProxyFromSettings/);
  assert.match(proxy, /hostnameIsLoopback/);
  assert.match(proxy, /curlProxyUrl/);
  assert.doesNotMatch(proxy, /mode === "env"/);
  assert.doesNotMatch(proxy, /HTTP_PROXY/);
  assert.doesNotMatch(proxy, /NO_PROXY/);
  assert.doesNotMatch(web, /HTTP_PROXY/);
  assert.doesNotMatch(web, /spawn\("curl"/);
  assert.doesNotMatch(image, /HTTP_PROXY/);
  assert.doesNotMatch(image, /spawn\("curl"/);
});

test("source: no Environment mode, curl follows Custom URL, 127 stays direct", async () => {
  const proxy = await readFile(path.join(repoRoot, "source/shared/outbound-proxy.ts"), "utf8");
  const settings = await readFile(path.join(repoRoot, "source/host/extensions/settings/settings-service.ts"), "utf8");
  const main = await readFile(path.join(repoRoot, "source/electron-main/main-edge.ts"), "utf8");
  const preload = await readFile(path.join(repoRoot, "source/client-runtime/desktop-bridge.ts"), "utf8");
  const server = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/server.tsx"), "utf8");
  assert.match(settings, /applyOutboundProxyFromSettings/);
  assert.match(proxy, /curlProxyUrl/);
  assert.match(proxy, /hostnameIsLoopback/);
  assert.doesNotMatch(proxy, /function webProxyUrl\(\) \{\n  return void 0;\n\}/);
  assert.doesNotMatch(proxy, /SAND_WEB_HTTP_PROXY \?\? process\.env\.HTTPS_PROXY/);
  assert.match(main, /getOutboundProxy: async \(\) => \{/);
  assert.match(preload, /getOutboundProxy: \(\) => gatedCall\("remoteBox", "getOutboundProxy"\)/);
  assert.match(server, /127\.0\.0\.1 is always direct/);
  assert.match(server, /Save proxy/);
  assert.match(server, /<option value="off">Off<\/option>/);
  assert.match(server, /<option value="custom">Custom URL<\/option>/);
  assert.doesNotMatch(server, /<option value="env">/);
  assert.doesNotMatch(server, /label="Environment"/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadTs(entry) {
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

test("no-server errors park retries and leave connected backoff unchanged", async () => {
  const reachability = await loadTs("source/shared/gateway-reachability.ts");
  const gateway = await loadTs("source/node-agent-coordinator/gateway/gateway-reachability.ts");
  const error = new Error(`No server is configured. Open Settings → Server to install or connect. ${reachability.GATEWAY_NO_SERVER_MESSAGE_MARKER}`);
  assert.equal(reachability.isNoServerConfiguredError(error), true);
  assert.equal(gateway.classifyGatewayError(error).outcome, "no_server");
  const wrapped = new Error(`main-execution-failure: ${error.message}`);
  assert.equal(reachability.isNoServerConfiguredError(wrapped), true);
  assert.equal(gateway.classifyGatewayError(wrapped).outcome, "no_server");
  assert.notEqual(gateway.classifyGatewayError(new Error("gateway events failed")).outcome, "no_server");

  const connector = await readFile(path.join(repoRoot, "source/electron-main/box/box-host-connector.ts"), "utf8");
  assert.match(connector, /GATEWAY_NO_SERVER_MESSAGE_MARKER/);
  assert.match(connector, /const envUrl = env\[GATEWAY_URL_ENV\]\?\.trim\(\) \?\? ""/);
  assert.doesNotMatch(connector, /if \(\(env\[GATEWAY_URL_ENV\]\?\.trim\(\) \?\? ""\)\.length > 0\) return new EnvDescriptorHostConnector/);

  const client = await readFile(path.join(repoRoot, "source/node-agent-coordinator/gateway/gateway-client.ts"), "utf8");
  assert.match(client, /SSE_RECONNECT_MIN_MS = 1_000/);
  assert.match(client, /SSE_RECONNECT_MAX_MS = 10_000/);
  assert.match(client, /parkedNoServer/);
  assert.match(client, /outcome === "access_denied"/);
  assert.match(client, /announceLive/);
  assert.match(client, /GATEWAY_SSE_ACCEPT_HEADERS/);
  assert.match(client, /reconnectBackoff\.schedule\(failedAttempts/);
  assert.doesNotMatch(client, /SSE_RECONNECT_MIN_MS = 0/);

  const webauthn = await readFile(path.join(repoRoot, "source/node-agent-coordinator/main.ts"), "utf8");
  assert.match(webauthn, /initialDelayMs: 1_000/);
  assert.match(webauthn, /maxDelayMs: 30_000/);
  assert.match(webauthn, /HTTP 401\|HTTP 403\|HTTP 404/);
  assert.match(webauthn, /webauthnProvider\?\.start\(\)/);
  assert.doesNotMatch(webauthn, /webauthnProvider\.start\(\);/);

  const localExec = await readFile(path.join(repoRoot, "source/node-agent-coordinator/local-exec/supervisor.ts"), "utf8");
  assert.match(localExec, /idleForMissingServer/);
  assert.match(localExec, /idleUntilStreamLive/);
  assert.match(localExec, /skipDaemonWithoutCredential/);
  assert.match(localExec, /LOCAL_EXEC_DAEMON_REFRESH_INTERVAL_MS = 30_000/);
  assert.match(localExec, /LOCAL_EXEC_DAEMON_LIVENESS_INTERVAL_MS = 1_000/);
});

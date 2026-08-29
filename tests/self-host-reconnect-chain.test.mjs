import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  asarSyncLinuxHost,
  asarSyncLinuxMain,
  asarSyncLinuxPanel,
  asarSyncLinuxUbx,
  asarSyncWinMain,
  skipUnlessAllExist,
} from "./harness/optional-pack.mjs";

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
  const outfile = path.join(repoRoot, `.tmp-test-${randomUUID()}.mjs`);
  await writeFile(outfile, file.text);
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    await unlink(outfile).catch(() => {});
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") throw new Error("server has no port");
      resolve(address.port);
    });
  });
}

test("packaged launch renames .grokbot into ~/.openbot and does not keep a second root", async () => {
  const migration = await loadTs("source/electron-main/startup/startup-data-root-migration.ts");
  const home = mkdtempSync(path.join(tmpdir(), "openbot-home-"));
  const grokbot = path.join(home, ".grokbot");
  const openbot = path.join(home, ".openbot");
  mkdirSync(grokbot);
  writeFileSync(path.join(grokbot, "settings.json"), "{}\n");
  writeFileSync(path.join(grokbot, ".grokbot-data-root-v1"), '{"version":1}\n');
  const settlement = migration.settleStartupDataRoot({
    isPackaged: true,
    isLabBuild: false,
    hasDataRootOverride: false,
    hasIsolatedUserData: false,
    homeDir: home,
    isProcessAlive: () => false,
    isSandHostProcess: () => false,
  });
  assert.equal(settlement.route, "canonical");
  assert.equal(settlement.reason, "migrated");
  assert.equal(settlement.root, openbot);
  assert.equal(migration.inspectDataRootDirectory(grokbot), "absent");
  assert.equal(migration.inspectDataRootDirectory(openbot), "directory");
  assert.equal(migration.hasDataRootMarker(openbot), true);
  assert.equal(readFileSync(path.join(openbot, "settings.json"), "utf8"), "{}\n");
  rmSync(home, { recursive: true, force: true });
});

test("reconnect chain writes one credential file then connects from that file without Cursor", async () => {
  const credentials = await loadTs("source/electron-main/box/self-host-credentials.ts");
  const connectorMod = await loadTs("source/electron-main/box/box-host-connector.ts");
  const edgeMod = await loadTs("source/electron-main/box/self-host-edge.ts");
  const directory = await mkdtemp(path.join(tmpdir(), "openbot-reconnect-"));
  const settingsPath = path.join(directory, "settings.json");
  writeFileSync(settingsPath, "{}\n");
  const token = "c".repeat(32);
  const server = createServer((request, response) => {
    if (request.url !== "/events") {
      response.writeHead(404).end();
      return;
    }
    const auth = request.headers.authorization ?? "";
    if (auth !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end();
  });
  const port = await listen(server);
  const gatewayUrl = `http://127.0.0.1:${port}`;
  let coordinatorRestarts = 0;
  const edge = edgeMod.createSelfHostEdgePort({
    settingsPath,
    restartCoordinator: () => { coordinatorRestarts += 1; },
    openInSystemBrowser: async () => {},
    resourcesPath: directory,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  });
  const missing = await edge.getConnection();
  assert.equal(missing.status, "missing");
  assert.equal(missing.hasToken, false);
  const saved = await edge.setConnection({
    gatewayUrl,
    token,
    host: "127.0.0.1",
    username: "box",
    port: 22,
    gatewayPort: port,
  });
  assert.equal(saved.hasToken, true);
  assert.equal(saved.status, "connected");
  assert.equal(coordinatorRestarts, 1);
  const credentialPath = credentials.selfHostCredentialPath(settingsPath);
  assert.equal(path.dirname(credentialPath), directory);
  assert.equal(path.basename(credentialPath), "self-host-gateway.json");
  const onDisk = JSON.parse(await readFile(credentialPath, "utf8"));
  assert.equal(onDisk.schemaVersion, 1);
  assert.equal(onDisk.gatewayUrl, gatewayUrl);
  assert.equal(onDisk.host, "127.0.0.1");
  const restored = await edge.getConnection();
  assert.equal(restored.gatewayUrl, gatewayUrl);
  assert.equal(restored.hasToken, true);
  assert.equal(restored.host, "127.0.0.1");
  assert.equal(restored.username, "box");
  assert.equal(restored.status, "connected");
  let peeked = 0;
  let brokered = 0;
  const connector = connectorMod.createRemoteHostConnector(
    {
      getAccessToken: async () => { throw new Error("must not mint a Cursor token"); },
      peekAccessToken: async () => { peeked += 1; return null; },
      getMachineId: () => "test-machine",
    },
    {},
    undefined,
    undefined,
    { read: () => credentials.readSelfHostGateway(settingsPath) },
  );
  const connection = await connector.connect();
  assert.equal(connection.baseUrl, gatewayUrl);
  assert.equal(connection.token, token);
  assert.equal(peeked, 0);
  assert.equal(brokered, 0);
  await credentials.clearSelfHostGateway(settingsPath);
  await assert.rejects(
    () => connectorMod.createRemoteHostConnector(
      {
        getAccessToken: async () => { throw new Error("must not mint a Cursor token"); },
        peekAccessToken: async () => null,
        getMachineId: () => "test-machine",
      },
      {},
      undefined,
      undefined,
      { read: () => credentials.readSelfHostGateway(settingsPath) },
    ).connect(),
    (error) => error instanceof connectorMod.SandNoServerConfiguredError,
  );
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

test("unsigned reconnect without a saved file parks as no_server instead of hitting the Cursor broker", async () => {
  const connectorMod = await loadTs("source/electron-main/box/box-host-connector.ts");
  const connector = connectorMod.createRemoteHostConnector(
    {
      getAccessToken: async () => { throw new Error("must not mint a Cursor token"); },
      peekAccessToken: async () => null,
      getMachineId: () => "test-machine",
    },
    {},
    undefined,
    undefined,
    { read: async () => null },
  );
  await assert.rejects(
    () => connector.connect(),
    (error) => error instanceof connectorMod.SandNoServerConfiguredError
      && String(error.message).includes("sand no server is configured (no_server)"),
  );
});

test("packed electron-main keeps one desktop root, one credential file, and the reconnect order", async (t) => {
  if (
    skipUnlessAllExist(
      t,
      [asarSyncLinuxMain, asarSyncWinMain, asarSyncLinuxHost, asarSyncLinuxPanel, asarSyncLinuxUbx],
      "unpacked asar sync missing; run pack:all",
    )
  ) {
    return;
  }
  const main = await readFile(asarSyncLinuxMain, "utf8");
  const winMain = await readFile(asarSyncWinMain, "utf8");
  const host = await readFile(asarSyncLinuxHost, "utf8");
  const panel = await readFile(asarSyncLinuxPanel, "utf8");
  const boot = await readFile(asarSyncLinuxUbx, "utf8");
  assert.match(main, /SAND_PRODUCTION_DATA_DIRNAME = "\.openbot"/);
  assert.match(main, /if \(isSandLabBuild\(\)\) return/);
  assert.match(main, /join\)\(homeDir, "\.grokbot"\)/);
  assert.match(main, /"self-host-gateway.json"/);
  assert.match(main, /async function probeGateway\(/);
  assert.match(main, /const stored = await selfHost2\?\.read\(\)/);
  assert.match(main, /if \(peekedCursorToken\.token == null\) throw new SandNoServerConfiguredError\(\)/);
  assert.match(main, /status: gatewayUrl\.length === 0 \? "missing"/);
  assert.doesNotMatch(main, /extraCredential/);
  assert.match(main, /SAND_BOX_DATA_ROOT = `\$\{SAND_BOX_HOME_DIR\}\/sand-data`/);
  assert.match(host, /SAND_BOX_DATA_ROOT = `\$\{SAND_BOX_HOME_DIR\}\/sand-data`/);
  assert.doesNotMatch(host, /SAND_BOX_DATA_ROOT = `\$\{SAND_BOX_HOME_DIR\}\/\$\{SAND_DATA_DIRNAME\}`/);
  assert.match(panel, /Token is saved on this computer/);
  assert.match(panel, /setSelfHostConnection\(\{gatewayUrl:s\.accessUrl\.trim\(\),host:s\.host\.trim\(\)/);
  assert.match(boot, /A2\?\.gatewayUrl\|\|A2\?\.hasToken\|\|A2\?\.envOverrides/);
  assert.match(boot, /if\(n\.kind!=="logged-in"\)return"local"/);
  assert.match(host, /entry\.kind === "send-message" \|\| isUserMessageEntry\(entry\)/);
  assert.match(host, /const sendMessageBefore = session\.db\.getTranscriptEntries\(\)\.filter\(\(entry\) => entry\.kind === "send-message"\)\.length/);
  assert.match(host, /if \(!delivered && latest\.endedOnSilentToolCalls === true/);
  assert.match(main, /Box did not accept Router settings/);
  assert.match(winMain, /async function probeGateway\(/);
  assert.match(winMain, /join\)\(homeDir, "\.grokbot"\)/);
  assert.match(winMain, /"self-host-gateway.json"/);
  assert.match(winMain, /const stored = await selfHost2\?\.read\(\)/);
});

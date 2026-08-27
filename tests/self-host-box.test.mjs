import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("self-host docker recipe matches the local VM image and publishes 0.0.0.0", async () => {
  const box = await loadTs("source/shared/self-host-box.ts");
  const local = await readFile(path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts"), "utf8");
  assert.equal(box.SELF_HOST_BOX_IMAGE, "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest");
  assert.match(local, new RegExp(box.SELF_HOST_BOX_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const args = box.selfHostDockerRunArgs({ token: "a".repeat(32), gatewayPort: 1340, remoteRoot: box.selfHostRemoteRoot("/home/alice") });
  assert.equal(box.selfHostRemoteRoot("/home/alice"), "/home/alice/openbot-box");
  assert.ok(args.some((part) => part.includes("src=/home/alice/openbot-box/host-main.cjs")));
  assert.equal(args.includes("--publish"), true);
  assert.ok(args.includes("0.0.0.0:1340:1340"));
  assert.ok(args.includes("SAND_GATEWAY_BIND_HOST=0.0.0.0") || args.includes("--env") && args.some((part) => part === "SAND_GATEWAY_BIND_HOST=0.0.0.0"));
  assert.ok(args.includes("SAND_GATEWAY_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") || args.some((part) => part.startsWith("SAND_GATEWAY_TOKEN=")));
  assert.equal(box.SELF_HOST_BOX_CONTAINER, "openbot-self-host");
  const oneLiner = box.selfHostOneLiner({ token: "a".repeat(32), gatewayPort: 1340 });
  assert.match(oneLiner, /^sh -c /);
  assert.match(oneLiner, /Pulling image/);
  assert.match(oneLiner, /\$DOCKER pull /);
  assert.match(oneLiner, /Starting container/);
  assert.match(oneLiner, /https:\/\/docs\.docker\.com\/engine\/install\//);
  assert.match(oneLiner, /\$\{HOME\}\/openbot-box/);
  assert.doesNotMatch(oneLiner, /\/opt\/openbot-box/);
  assert.match(oneLiner, /This user cannot run Docker/);
});

test("self-host gateway credentials persist next to settings with mode 0600", async () => {
  const credentials = await loadTs("source/electron-main/box/self-host-credentials.ts");
  const directory = await mkdtemp(path.join(tmpdir(), "openbot-self-host-"));
  const settingsPath = path.join(directory, "settings.json");
  const stored = await credentials.writeSelfHostGateway(settingsPath, {
    gatewayUrl: "http://192.168.1.10:1340",
    token: "b".repeat(32),
  });
  assert.equal(stored.gatewayUrl, "http://192.168.1.10:1340");
  const mode = (await stat(credentials.selfHostCredentialPath(settingsPath))).mode & 0o777;
  assert.equal(mode, 0o600);
  const loaded = await credentials.readSelfHostGateway(settingsPath);
  assert.ok(loaded);
  assert.equal(loaded.token, "b".repeat(32));
});

test("self-host SSH uses ssh2 and keeps errors short", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/box/self-host-ssh.ts"), "utf8");
  assert.match(source, /from "ssh2"/);
  assert.match(source, /hostVerifier/);
  assert.match(source, /forwardOut/);
  assert.match(source, /fastPut/);
  assert.match(source, /Can't reach that server\./);
  assert.match(source, /Wrong username, password, or key\./);
  assert.match(source, /Host key changed\./);
  assert.match(source, /onOutput/);
  assert.doesNotMatch(source, /spawn\(|execFile\(|\/usr\/bin\/ssh|child_process/);
});

test("install progress shows the last docker line without flooding the button", async () => {
  const box = await loadTs("source/shared/self-host-box.ts");
  assert.equal(box.selfHostVisibleProgressLine("\rabc\r4f4fb: Downloading 12MB/32MB\n"), "4f4fb: Downloading 12MB/32MB");
  assert.equal(box.selfHostVisibleProgressLine("   \n"), null);
  const long = "x".repeat(120);
  assert.equal(box.selfHostVisibleProgressLine(long).length, 96);
  assert.equal(box.selfHostVisibleProgressLine(long).endsWith("…"), true);
});

test("unpackaged self-host docs resolve inside this repository", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/box/self-host-edge.ts"), "utf8");
  assert.match(source, /new URL\("\.\.\/\.\.\/\.\.\/docs\/self-host\.md"/);
  assert.match(source, /GATEWAY_EVENTS_PATH/);
  assert.match(source, /Wrong token\./);
  assert.doesNotMatch(source, /\$\{gatewayUrl\}\/health/);
  const docs = await readFile(path.join(repoRoot, "docs/self-host.md"), "utf8");
  assert.match(docs, /SAND_HOST_GATEWAY_URL/);
  assert.match(docs, /0\.0\.0\.0/);
});

test("main edge and capability table serve the self-host RPCs", async () => {
  const table = await readFile(path.join(repoRoot, "source/shared/rpc/main.ts"), "utf8");
  const edge = await readFile(path.join(repoRoot, "source/electron-main/main-edge.ts"), "utf8");
  const capabilities = await readFile(path.join(repoRoot, "source/shared/capability-methods.ts"), "utf8");
  const connector = await readFile(path.join(repoRoot, "source/electron-main/box/box-host-connector.ts"), "utf8");
  const methods = ["getSelfHostConnection", "setSelfHostConnection", "getSelfHostInstallCommand", "installSelfHostBox", "testSelfHostGateway", "pickSelfHostKeyFile", "openSelfHostDocs"];
  for (const method of methods) {
    assert.match(table, new RegExp(`${method}: \\{ args:`));
    assert.match(edge, new RegExp(`${method}:`));
    assert.match(capabilities, new RegExp(`${method}: "remoteBox"`));
  }
  assert.match(connector, /class EnvDescriptorHostConnector/);
  assert.match(connector, /const envUrl = env\[GATEWAY_URL_ENV\]/);
  assert.match(connector, /const stored = await selfHost\?\.read\(\)/);
  assert.match(connector, /SandNoServerConfiguredError/);
  assert.match(connector, /peekAccessToken/);
  assert.match(connector, /GATEWAY_NO_SERVER_MESSAGE_MARKER/);
});

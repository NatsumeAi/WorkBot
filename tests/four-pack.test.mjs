import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import {
  ANDROID_MAIN_ACTIVITY_PATH,
  androidShellFindings,
  forwarderCoreFindings,
  forwarderGlueFindings,
  sha256Bytes,
  routerSettingsHasApi,
  stagedWebRootFindings,
  webRuntimeFindings,
} from "../scripts/lib/four-pack.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadTs(entry) {
  const result = await esbuild({
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

test("box gateway rejects every browser-origin request with 403, even when authenticated", async () => {
  const gateway = await loadTs("source/host/gateway-server.ts");
  const token = "four-pack-gate-test-token";
  const server = await gateway.startGatewayServer({
    api: new Proxy({}, { get: () => () => { throw new Error("not used by this probe"); } }),
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false }),
    startedAt: Date.now(),
    authToken: token,
    host: "127.0.0.1",
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const browserFetch = await fetch(`${base}/health`, { headers: { origin: "http://127.0.0.1:5173", authorization: `Bearer ${token}` } });
    assert.equal(browserFetch.status, 403);
    const nonBrowserFetch = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(nonBrowserFetch.status, 200);
    assert.equal((await nonBrowserFetch.json()).ok, true);
  } finally {
    await server.close();
  }
});

test("self-host address guard rejects loopback targets with a human hint", async () => {
  const guard = await loadTs("source/shared/self-host-address.ts");
  for (const bad of ["http://127.0.0.1:1340", "http://localhost:1340", "http://127.10.0.1:1340", "http://[::1]:1340", "http://0.0.0.0:1340"]) {
    const parsed = guard.parseSelfHostGatewayAddress(bad);
    assert.equal(parsed.ok, false, `${bad} must be rejected`);
    assert.equal(parsed.reason, guard.SELF_HOST_LOOPBACK_HINT);
    assert.match(parsed.reason, /192\.168\.1\.8:1340/);
  }
  for (const bad of ["127.0.0.1", "ftp://192.168.1.8", "http://", ""]) {
    assert.equal(guard.parseSelfHostGatewayAddress(bad).ok, false, `${bad} must be rejected`);
  }
  const good = guard.parseSelfHostGatewayAddress("http://192.168.1.8:1340");
  assert.equal(good.ok, true);
  assert.equal(good.url.hostname, "192.168.1.8");
});

test("client-UI manifest builder is deterministic and covers the pinned renderer and boot runtime", async (t) => {
  if (!existsSync(path.join(repoRoot, "src", "app", "dist", "renderer", "index.html"))) {
    t.skip("pinned renderer payload is not hydrated; run npm run bootstrap");
    return;
  }
  // Run the builder in a child process with a private UI directory so tests
  // never mutate the shared packaging state.
  const privateDir = await mkdtemp(path.join(tmpdir(), "client-ui-test-"));
  const probe = path.join(privateDir, "probe.mjs");
  await writeFile(probe, `
    const { buildClientUi } = await import(${JSON.stringify(path.join(repoRoot, "scripts", "lib", "four-pack.mjs"))});
    const first = await buildClientUi();
    const second = await buildClientUi({ force: true });
    console.log(JSON.stringify({ first: first.manifest, second: second.manifest }));
  `);
  try {
    const output = await new Promise((resolve, reject) => {
      execFile(process.execPath, [probe], {
        timeout: 120_000,
        env: { ...process.env, GROK_BOT_CLIENT_UI_DIR: path.join(privateDir, "ui-build") },
      }, (error, stdout, stderr) => {
        if (error != null) reject(new Error(`${stdout}${stderr}`.trim() || error.message));
        else resolve(stdout);
      });
    });
    const { first, second } = JSON.parse(output);
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.kind, "openbot-client-ui");
    assert.deepEqual(first.files, second.files);
    const paths = first.files.map(file => file.path);
    assert.ok(paths.includes("renderer/index.html"));
    assert.ok(paths.includes("client-overrides/boot.js"), "the web runtime boot must ride the same UI directory");
    assert.ok(paths.includes("client-overrides/mobile.css"));
    assert.ok(paths.includes("renderer/assets/index-BlqerJhg.js"));
    const overlayBytes = await readFile(path.join(repoRoot, "client-ui", "renderer-overlay", "assets", "index-BlqerJhg.js"));
    assert.equal(routerSettingsHasApi(overlayBytes.toString("utf8")), true);
    const builtSettings = first.files.find(file => file.path === "renderer/assets/index-BlqerJhg.js");
    assert.equal(builtSettings.bytes, overlayBytes.byteLength);
    assert.equal(builtSettings.sha256, sha256Bytes(overlayBytes));
    for (const file of first.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
    }
  } finally {
    await rm(privateDir, { recursive: true, force: true });
  }
});

test("staged web root rules fail closed on recovered/dev artifacts", () => {
  const clean = ["index.html", "assets/index.js", "client-overrides/mobile.css", "client-overrides/boot.js"];
  assert.deepEqual(stagedWebRootFindings(clean), []);
  const dirty = ["index.html", "desktop-shell.js", "assets/chunk.map", "client-overrides/mobile.css"];
  const findings = stagedWebRootFindings(dirty);
  assert.ok(findings.some(finding => finding.severity === "fail" && finding.message.includes("desktop-shell.js")));
  assert.ok(findings.some(finding => finding.severity === "fail" && finding.message.includes("sourcemap")));
  const noOverrides = stagedWebRootFindings(["index.html"]);
  assert.ok(noOverrides.some(finding => finding.severity === "fail" && finding.message.includes("client-overrides")));
});

test("forwarder core rules reject a proxy that leaks browser headers or buffers SSE", () => {
  const compliant = `
    static final String[] STRIPPED_HEADERS = { "Origin", "Referer", "Sec-Fetch-Site" };
    upstream.setRequestProperty("Accept-Encoding", "identity");
    upstream.setRequestProperty("Authorization", "Bearer " + token);
    upstream.setFixedLengthStreamingMode(contentLength);
    InputStream upstreamIn = upstream.getInputStream();
    pump(upstreamIn, out, Long.MAX_VALUE);
    PROXIED_PREFIXES = { "/api/", "/events", "/avatars/", "/health" };
    serverSocket.bind(new InetSocketAddress("127.0.0.1", port));
    LOOPBACK_MESSAGE
  `;
  assert.deepEqual(forwarderCoreFindings(compliant), []);
  const buffering = forwarderCoreFindings(compliant.replace("pump(upstreamIn, out, Long.MAX_VALUE);", "out.write(upstreamIn.readAllBytes());"));
  assert.ok(buffering.some(finding => finding.message.includes("never buffer a response stream")));
  const leaking = forwarderCoreFindings(compliant.replace("static final String[] STRIPPED_HEADERS = { \"Origin\", \"Referer\", \"Sec-Fetch-Site\" };", "static final String[] STRIPPED_HEADERS = {};"));
  assert.ok(leaking.some(finding => finding.message.includes("browser-origin headers")));
  const chatLogic = forwarderCoreFindings(compliant + "\n gateway.dispatchCommand(\"sendPrompt\", args, null); upstream.sendPrompt(args);");
  assert.ok(chatLogic.some(finding => finding.message.includes("must not contain chat logic")));
});

test("forwarder glue rules demand the Keystore token and forbid chat logic", () => {
  const compliant = "new SecretsStore(context).reveal(\"gatewayToken\"); boxConfig.getString(\"boxBaseUrl\", \"\");";
  assert.deepEqual(forwarderGlueFindings(compliant), []);
  const chat = forwarderGlueFindings(compliant + " transcriptManager.sendPrompt();");
  assert.ok(chat.some(finding => finding.message.includes("must not contain chat logic")));
});

test("android shell rules forbid file:// loading and require the forwarder origin", () => {
  const compliant = `
    startForwarder(GatewayForwarder.start(this));
    webView.getSettings().setAllowFileAccess(false);
    WebViewCompat.addDocumentStartJavaScript(webView, boot, origins);
    if (secrets.reveal("gatewayToken") != null) hasGatewayToken = true;
    webView.loadUrl("http://127.0.0.1:" + port + "/");
  `;
  assert.deepEqual(androidShellFindings(compliant), []);
  const fileBased = androidShellFindings(compliant.replace('webView.loadUrl("http://127.0.0.1:" + port + "/");', 'webView.loadUrl("file:///android_asset/www/index.html");'));
  assert.ok(fileBased.some(finding => finding.message.includes("file://")));
  const noBoot = androidShellFindings(compliant.replace("WebViewCompat.addDocumentStartJavaScript(webView, boot, origins);", ""));
  assert.ok(noBoot.some(finding => finding.message.includes("inject the web runtime")));
});

test("web runtime rules demand the loopback guard and the shared bridge contracts", async () => {
  const compliant = `
    import { parseSelfHostGatewayAddress } from "../../shared/self-host-address.js";
    const desktop = createDesktopBridge({ transport });
    const broker = createCoordinatorPortBroker({ invokeRequest });
    window.coordinatorPort = broker.bridge;
    const base = location.origin;
    installWebRuntime();
  `;
  assert.deepEqual(webRuntimeFindings(compliant), []);
  const hardcoded = webRuntimeFindings(`${compliant}\nconst box = "http://192.168.1.8:1340/api/listAgents";`);
  assert.ok(hardcoded.some(finding => finding.message.includes("absolute box gateway addresses")));
  const missingGuard = webRuntimeFindings("const base = location.origin;");
  assert.ok(missingGuard.some(finding => finding.message.includes("parseSelfHostGatewayAddress")));
  const entry = await readFile(path.join(repoRoot, "source", "client-runtime", "web", "entry.ts"), "utf8");
  assert.deepEqual(webRuntimeFindings(entry), []);
  assert.match(entry, /sandNeedsConnect/);
  const webEdge = await readFile(path.join(repoRoot, "source", "client-runtime", "web", "web-main-edge.ts"), "utf8");
  assert.match(webEdge, /coerceAttachmentBytes/);
  assert.doesNotMatch(webEdge, /!\(bytes instanceof Uint8Array\)/);
  const css = await readFile(path.join(repoRoot, "source", "client-overrides", "mobile.css"), "utf8");
  assert.match(css, /data-sand-needs-connect/);
  assert.match(css, /\.sand-loading/);
});

test("Java forwarder core passes the end-to-end proxy harness (headers, token, SSE streaming)", async (t) => {
  const javaHome = process.env.JAVA_HOME ?? "";
  const javacCandidates = javaHome ? [path.join(javaHome, "bin", "javac")] : [];
  let javac = javacCandidates.find(candidate => existsSync(candidate));
  if (javac == null) {
    for (const directory of process.env.PATH?.split(path.delimiter) ?? []) {
      for (const name of process.platform === "win32" ? ["javac.exe", "javac"] : ["javac"]) {
        const candidate = path.join(directory, name);
        if (existsSync(candidate)) { javac = candidate; break; }
      }
      if (javac != null) break;
    }
  }
  if (javac == null) {
    t.skip("no JDK on PATH; install one to run the forwarder harness");
    return;
  }
  const java = javac.replace(/javac(\.exe)?$/, "java$1");
  const core = path.join(repoRoot, "targets", "android", "app", "src", "main", "java", "com", "grokbot", "reconstructed", "ForwarderCore.java");
  const harness = path.join(repoRoot, "tests", "java", "ForwarderCoreTest.java");
  const scratch = await mkdtemp(path.join(tmpdir(), "forwarder-test-"));
  try {
    await run(javac, ["-d", scratch, core, harness]);
    const output = await new Promise((resolve, reject) => {
      execFile(java, ["-cp", scratch, "com.grokbot.reconstructed.ForwarderCoreTest"], { timeout: 60_000 }, (error, stdout, stderr) => {
        if (error != null) reject(new Error(`${stdout}${stderr}`.trim() || error.message));
        else resolve(stdout.trim());
      });
    });
    assert.match(output, /PASS/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error != null) reject(new Error(`${stdout}${stderr}`.trim() || error.message));
      else resolve(stdout);
    });
  });
}

test("linux windows and macos electron packs are one shared packer, not two product branches", async () => {
  const packer = await readFile(path.join(repoRoot, "scripts", "lib", "package-electron.mjs"), "utf8");
  const linux = await readFile(path.join(repoRoot, "scripts", "package-linux.mjs"), "utf8");
  const windows = await readFile(path.join(repoRoot, "scripts", "package-windows.mjs"), "utf8");
  const macos = await readFile(path.join(repoRoot, "scripts", "package-macos.mjs"), "utf8");
  const dispatcher = await readFile(path.join(repoRoot, "scripts", "package.mjs"), "utf8");
  const allPack = await readFile(path.join(repoRoot, "scripts", "package-all.mjs"), "utf8");
  assert.match(linux, /packageElectronDesktop\("linux-x64"\)/);
  assert.match(windows, /packageElectronDesktop\("windows-x64"\)/);
  assert.match(macos, /packageElectronDesktop\("macos-arm64"\)/);
  assert.doesNotMatch(linux, /buildFidelityReconstructedAsar/);
  assert.doesNotMatch(windows, /buildFidelityReconstructedAsar/);
  assert.doesNotMatch(macos, /buildFidelityReconstructedAsar/);
  assert.match(packer, /"linux-x64"/);
  assert.match(packer, /"windows-x64"/);
  assert.match(packer, /"macos-arm64"/);
  assert.match(packer, /packageElectronDesktops/);
  assert.match(packer, /archiveDesktopFolder/);
  assert.match(packer, /\$\{folder\}\.zip/);
  assert.match(dispatcher, /packageElectronDesktop\(target\.id\)/);
  assert.doesNotMatch(dispatcher, /package-linux\.mjs/);
  assert.doesNotMatch(dispatcher, /package-macos\.mjs/);
  assert.match(allPack, /package-electron\.mjs/);
});

test("electron stage copies the Windows overlay and records renderer-router-extension", async (t) => {
  if (!existsSync(path.join(repoRoot, "src", "app", "dist", "renderer", "index.html"))) {
    t.skip("pinned renderer payload is not hydrated; run npm run bootstrap");
    return;
  }
  const scratch = await mkdtemp(path.join(tmpdir(), "overlay-stage-"));
  try {
    const { installClientOverridesIntoStage, sha256Bytes: hash, routerSettingsHasApi } = await import("../scripts/lib/four-pack.mjs");
    await installClientOverridesIntoStage(scratch);
    const overlay = await readFile(path.join(repoRoot, "client-ui", "renderer-overlay", "assets", "index-BlqerJhg.js"));
    const staged = await readFile(path.join(scratch, "dist", "renderer", "assets", "index-BlqerJhg.js"));
    assert.equal(hash(staged), hash(overlay));
    assert.equal(routerSettingsHasApi(staged.toString("utf8")), true);
    const extension = JSON.parse(await readFile(path.join(scratch, "dist", "renderer-router-extension.json"), "utf8"));
    assert.equal(extension.mode, "original-renderer-settings-extension");
    assert.equal(extension.chunks.length, 2);
    const panel = extension.chunks.find(chunk => chunk.role === "panel");
    assert.equal(panel.patched.sha256, hash(overlay));
    const keys = Object.keys(extension).sort().join("\0");
    assert.equal(keys, ["chunks", "features", "mode", "schemaVersion", "transformations"].sort().join("\0"));
    const boot = await readFile(path.join(scratch, "dist", "client-overrides", "boot.js"), "utf8");
    assert.match(boot, /\ninstallWebRuntime\(\);/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("four-pack doc and scripts stay wired into the package entrypoints", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts["pack:all"], /scripts\/package-all\.mjs/);
  assert.match(pkg.scripts["pack:ui"], /scripts\/build-client-ui\.mjs/);
  assert.match(pkg.scripts["verify:four-pack"], /scripts\/verify-four-pack\.mjs/);
  const dispatcher = await readFile(path.join(repoRoot, "scripts", "package-all.mjs"), "utf8");
  assert.match(dispatcher, /verify-four-pack\.mjs/);
  assert.match(dispatcher, /GROK_BOT_TARGET/);
  assert.ok(existsSync(path.join(repoRoot, "docs", "FOUR-PACK.md")));
  assert.ok(existsSync(path.join(repoRoot, "source", "client-overrides", "mobile.css")));
  assert.ok(existsSync(ANDROID_MAIN_ACTIVITY_PATH));
});

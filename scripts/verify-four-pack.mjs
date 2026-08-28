import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { build as esbuild } from "esbuild";
import { extractFile, listPackage, statFile } from "@electron/asar";

import { outputApp, outputDir, repoRoot } from "./lib/config.mjs";
import {
  ANDROID_FORWARDER_CORE_PATH,
  ANDROID_FORWARDER_GLUE_PATH,
  ANDROID_MAIN_ACTIVITY_PATH,
  FOUR_PACK_STEP_REFS,
  WEB_RUNTIME_ENTRY,
  forwarderCoreFindings,
  forwarderGlueFindings,
  androidShellFindings,
  buildClientUi,
  loadClientUiManifest,
  sha256Bytes,
  stagedWebRootFindings,
  webRuntimeFindings,
} from "./lib/four-pack.mjs";
import { run } from "./lib/process.mjs";

const electronArtifacts = {
  "linux-x64": path.join(outputDir, "openbot-linux-x64", "resources", "app.asar"),
  "windows-x64": path.join(outputDir, "openbot-win32-x64", "resources", "app.asar"),
};
const androidStagedWww = path.join(repoRoot, "targets", "android", "app", "src", "main", "assets", "www");
const androidApk = path.join(repoRoot, "targets", "android", "app", "build", "outputs", "apk", "release", "app-release.apk");

const DEFAULT_REQUIRED = ["linux-x64", "windows-x64", "android"];

function parseList(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value?.split(",").map(entry => entry.trim()).filter(Boolean) ?? [];
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Map packaged ASAR entries to client-UI manifest paths. */
function manifestPathFor(relative) {
  if (relative.startsWith("dist/renderer/")) return `renderer/${relative.slice("dist/renderer/".length)}`;
  if (relative.startsWith("dist/client-overrides/")) return `client-overrides/${relative.slice("dist/client-overrides/".length)}`;
  return null;
}

async function collectAsarSections(archivePath) {
  const entries = [];
  for (const raw of listPackage(archivePath)) {
    const relative = raw.replace(/^\/+/, "");
    if (manifestPathFor(relative) == null) continue;
    try {
      const entry = statFile(archivePath, relative);
      if (typeof entry.size !== "number") continue;
      entries.push(relative);
    } catch {
      // Directory entries are excluded from the byte inventory.
    }
  }
  const collected = new Map();
  for (const relative of entries) {
    const bytes = extractFile(archivePath, relative);
    collected.set(manifestPathFor(relative), { bytes: bytes.byteLength, sha256: sha256Bytes(bytes) });
  }
  return collected;
}

async function collectWebRootSections(webRoot) {
  const collected = new Map();
  const walk = async (current, prefix) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(target, `${relative}/`);
      else collected.set(relative, { bytes: (await stat(target)).size, sha256: sha256Bytes(await readFile(target)) });
    }
  };
  await walk(webRoot, "");
  return collected;
}

async function extractApkWebRoot(apkPath) {
  const scratch = await mkdtemp(path.join(tmpdir(), "four-pack-apk-"));
  try {
    await run("unzip", ["-q", "-o", apkPath, "assets/www/*", "-d", scratch]);
    const webRoot = path.join(scratch, "assets", "www");
    if (!existsSync(webRoot)) {
      await rm(scratch, { recursive: true, force: true });
      return null;
    }
    return { webRoot, scratch };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw new Error(`Could not unpack the Android APK (${apkPath}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function compareSection(manifest, collected, section, label, findings) {
  const expected = manifest.files.filter(file => file.path.startsWith(`${section}/`)).map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }));
  const expectedPaths = expected.map(file => file.path).sort();
  const actualPaths = [...collected.keys()].filter(key => key.startsWith(`${section}/`)).sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    const missing = expectedPaths.filter(file => !actualPaths.includes(file));
    const extra = actualPaths.filter(file => !expectedPaths.includes(file));
    findings.push({
      target: label,
      check: 1,
      severity: "fail",
      message: `UI file inventory differs from the client-UI manifest`
        + `${missing.length > 0 ? `; missing: ${missing.slice(0, 5).join(", ")}` : ""}`
        + `${extra.length > 0 ? `; unexpected: ${extra.slice(0, 5).join(", ")}` : ""}`
        + `. The package is stale for the four-pack contract — rebuild with npm run pack:all.`,
    });
    return;
  }
  for (const file of expected) {
    const actual = collected.get(file.path);
    if (actual?.bytes !== file.bytes || actual?.sha256 !== file.sha256) {
      findings.push({ target: label, check: 1, severity: "fail", message: `UI byte drift at ${file.path} (${label})` });
    }
  }
}

/**
 * Probe the real box gateway: browser-origin requests must be rejected with
 * 403 even when authenticated, while non-browser requests must pass.
 */
async function probeGatewayOriginRule() {
  const bundled = await esbuild({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: [path.join(repoRoot, "source/host/gateway-server.ts")],
    format: "esm",
    platform: "node",
    write: false,
    packages: "external",
  });
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const token = "four-pack-origin-probe-token";
  const server = await module.startGatewayServer({
    api: new Proxy({}, { get: () => () => { throw new Error("not used by this probe"); } }),
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false }),
    startedAt: Date.now(),
    authToken: token,
    host: "127.0.0.1",
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const withOrigin = await fetch(`${base}/health`, { headers: { origin: "http://127.0.0.1:5173", authorization: `Bearer ${token}` } });
    if (withOrigin.status !== 403) {
      return { target: "box", check: 2, severity: "fail", message: `box gateway accepted a browser-origin request (status ${withOrigin.status}); Origin must always be rejected with 403` };
    }
    const withoutOrigin = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } });
    if (withoutOrigin.status !== 200) {
      return { target: "box", check: 2, severity: "fail", message: `box gateway rejected a non-browser authenticated request (status ${withoutOrigin.status})` };
    }
    return null;
  } finally {
    await server.close();
  }
}

async function androidNativeFindings() {
  const findings = [];
  const forwarderCoreReady = existsSync(ANDROID_FORWARDER_CORE_PATH);
  const forwarderGlueReady = existsSync(ANDROID_FORWARDER_GLUE_PATH);
  if (!forwarderCoreReady || !forwarderGlueReady) {
    findings.push({ target: "android", check: 2, severity: "not-ready", step: FOUR_PACK_STEP_REFS.forwarder, message: "GatewayForwarder.java is not implemented yet; the phone cannot reach the box without the local forwarder" });
  } else {
    findings.push(...forwarderCoreFindings(await readFile(ANDROID_FORWARDER_CORE_PATH, "utf8")).map(finding => ({ target: "android", step: FOUR_PACK_STEP_REFS.forwarder, ...finding })));
    findings.push(...forwarderGlueFindings(await readFile(ANDROID_FORWARDER_GLUE_PATH, "utf8")).map(finding => ({ target: "android", step: FOUR_PACK_STEP_REFS.forwarder, ...finding })));
  }
  if (existsSync(ANDROID_MAIN_ACTIVITY_PATH)) {
    findings.push(...androidShellFindings(await readFile(ANDROID_MAIN_ACTIVITY_PATH, "utf8")).map(finding => ({ target: "android", step: FOUR_PACK_STEP_REFS.shell, ...finding })));
  }
  if (!existsSync(WEB_RUNTIME_ENTRY)) {
    findings.push({ target: "android", check: 2, severity: "not-ready", step: FOUR_PACK_STEP_REFS.webRuntime, message: "source/client-runtime/web/entry.ts is not implemented yet; the page has no window.desktop/window.coordinatorPort provider" });
  } else {
    findings.push(...webRuntimeFindings(await readFile(WEB_RUNTIME_ENTRY, "utf8")).map(finding => ({ target: "android", step: FOUR_PACK_STEP_REFS.webRuntime, ...finding })));
  }
  if (!existsSync(path.join(repoRoot, "source", "client-overrides", "mobile.css"))) {
    findings.push({ target: "android", check: 3, severity: "not-ready", step: FOUR_PACK_STEP_REFS.mobileCss, message: "source/client-overrides/mobile.css is not implemented yet; narrow screens will not collapse the sidebar" });
  }
  return findings;
}

function stepFor(finding) {
  if (finding.step != null) return finding.step;
  if (finding.severity === "not-ready" && finding.message.includes("npm run pack:all")) return "docs/FOUR-PACK.md 步骤 7（打包入口）";
  return null;
}

async function main() {
  const args = process.argv;
  const targets = args.includes("--targets") ? parseList("--targets") : null;
  const required = args.includes("--require") ? parseList("--require") : DEFAULT_REQUIRED;
  const skipProbe = args.includes("--skip-probe");

  const findings = [];
  const notes = [];

  await buildClientUi();
  const manifest = (await loadClientUiManifest())?.manifest;
  if (manifest == null) throw new Error("client-UI manifest missing after buildClientUi()");

  const considered = targetId => targets == null || targets.includes(targetId);

  for (const [targetId, archivePath] of Object.entries(electronArtifacts)) {
    if (!considered(targetId)) continue;
    if (!await pathExists(archivePath)) {
      if (required.includes(targetId)) findings.push({ target: targetId, check: 1, severity: "not-ready", message: `packaged ASAR missing: ${archivePath} (run npm run pack:all)` });
      continue;
    }
    const collected = await collectAsarSections(archivePath);
    compareSection(manifest, collected, "renderer", targetId, findings);
    compareSection(manifest, collected, "client-overrides", targetId, findings);
  }

  const macArchive = path.join(outputApp, "Contents", "Resources", "app.asar");
  if (considered("macos-arm64")) {
    if (!await pathExists(macArchive)) {
      findings.push({
        target: "macos-arm64",
        check: 1,
        severity: process.platform === "darwin" && required.includes("macos-arm64") ? "not-ready" : "info",
        message: `packaged app missing: ${outputApp} (macOS packaging runs on Apple Silicon)`,
      });
    } else {
      const collected = await collectAsarSections(macArchive);
      compareSection(manifest, collected, "renderer", "macos-arm64", findings);
      compareSection(manifest, collected, "client-overrides", "macos-arm64", findings);
    }
  }

  if (considered("android")) {
    const webRoots = [];
    if (await pathExists(androidStagedWww)) webRoots.push({ label: "android:staged-www", root: androidStagedWww });
    if (await pathExists(androidApk)) {
      try {
        const extracted = await extractApkWebRoot(androidApk);
        if (extracted != null) webRoots.push({ label: "android:apk", root: extracted.webRoot, scratch: extracted.scratch });
      } catch (error) {
        notes.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (webRoots.length === 0 && required.includes("android")) {
      findings.push({ target: "android", check: 1, severity: "not-ready", message: `no Android package found (expected ${androidApk} or staged ${androidStagedWww}); run npm run pack:all` });
    }
    for (const { label, root, scratch } of webRoots) {
      try {
        const collected = await collectWebRootSections(root);
        const mapped = new Map();
        for (const [relative, entry] of collected) {
          // Web-root layout: renderer files sit at the top level, the
          // client-overrides directory keeps its name.
          mapped.set(relative.startsWith("client-overrides/") ? relative : `renderer/${relative}`, entry);
        }
        compareSection(manifest, mapped, "renderer", label, findings);
        compareSection(manifest, mapped, "client-overrides", label, findings);
        findings.push(...stagedWebRootFindings([...collected.keys()]).map(finding => ({ target: label, ...finding })));
      } finally {
        if (scratch != null) await rm(scratch, { recursive: true, force: true });
      }
    }
    findings.push(...await androidNativeFindings());
  }

  if (!skipProbe) {
    const probe = await probeGatewayOriginRule();
    if (probe != null) findings.push(probe);
  }

  const failed = findings.some(finding => finding.severity === "fail");
  const notReady = findings.some(finding => finding.severity === "not-ready");

  console.log("== four-pack verification ==");
  for (const note of notes) console.log(`note: ${note}`);
  if (findings.length === 0) {
    console.log("PASS: renderer parity, gateway origin rule, and Android shell rules are all green.");
  } else {
    for (const finding of findings) {
      const step = stepFor(finding);
      console.log(`${finding.severity.toUpperCase()} [check ${finding.check}] ${finding.target ?? "*"}: ${finding.message}${step == null ? "" : ` -> ${step}`}`);
    }
  }
  if (failed) process.exit(1);
  if (notReady) process.exit(2);
}

await main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

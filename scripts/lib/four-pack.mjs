import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { build as esbuild } from "esbuild";

import { buildDir, repoRoot } from "./config.mjs";

export const pinnedRendererRoot = path.join(repoRoot, "src", "app", "dist", "renderer");
/** Windows-shipped Router/settings bytes. Applied once on top of the pinned renderer; every package copies the result. */
export const rendererOverlayRoot = path.join(repoRoot, "client-ui", "renderer-overlay");
export const RENDERER_OVERLAY_ROLES = Object.freeze({
  "assets/index-BlqerJhg.js": "panel",
  "assets/index-UbX-y3il.js": "registry",
});
export const clientOverridesRoot = path.join(repoRoot, "source", "client-overrides");
// GROK_BOT_CLIENT_UI_DIR lets concurrent processes (e.g. tests) own private
// UI directories; packaging flows share the default.
export const clientUiBuildDir = process.env.GROK_BOT_CLIENT_UI_DIR?.trim()
  ? path.resolve(process.env.GROK_BOT_CLIENT_UI_DIR.trim())
  : path.join(buildDir, "client-ui");
export const clientUiRoot = path.join(clientUiBuildDir, "ui");
export const clientUiManifestPath = path.join(clientUiBuildDir, "client-ui-manifest.json");

const ROUTER_SETTINGS_OVERLAY = "assets/index-BlqerJhg.js";

export function routerSettingsHasApi(source) {
  return typeof source === "string"
    && source.includes('label:"API"')
    && source.includes("RRouterState")
    && source.includes("getInferenceRouter");
}

export const CLIENT_UI_SCHEMA_VERSION = 1;

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function walkFiles(root, current = root) {
  const found = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...await walkFiles(root, target));
    else if (entry.isFile()) found.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return found.sort();
}

async function inventoryOf(root) {
  const files = await walkFiles(root);
  const entries = [];
  for (const relative of files) {
    const bytes = await readFile(path.join(root, relative));
    entries.push({ path: relative, bytes: bytes.byteLength, sha256: sha256Bytes(bytes) });
  }
  return entries;
}

export function manifestFor(files, {
  rendererInventorySha256,
  overlayInventorySha256 = "none",
  overrides = false,
  webRuntimeSourceSha256 = "none",
  overridesInventorySha256 = "none",
} = {}) {
  return {
    schemaVersion: CLIENT_UI_SCHEMA_VERSION,
    kind: "openbot-client-ui",
    renderer: {
      artifactRoot: "src/app/dist/renderer",
      overlayRoot: "client-ui/renderer-overlay",
      inventorySha256: rendererInventorySha256,
      overlayInventorySha256,
      pinned: true,
    },
    clientOverrides: { present: overrides, inventorySha256: overridesInventorySha256 },
    webRuntimeSourceSha256,
    files,
  };
}

export function aggregateInventorySha256(manifest) {
  return sha256Bytes(Buffer.from(JSON.stringify(manifest.files)));
}

/**
 * Deterministic in-page runtime bundle for the thin-client WebView. Every
 * package carries the same bytes inside client-overrides/; only the Android
 * shell executes it (the desktop preload owns window.desktop there).
 */
export const webRuntimeBootEntry = path.join(repoRoot, "source", "client-runtime", "web", "entry.ts");

async function buildWebRuntimeBoot(outFile) {
  const shims = path.join(repoRoot, "source", "client-runtime", "web", "shims");
  await esbuild({
    absWorkingDir: repoRoot,
    entryPoints: [webRuntimeBootEntry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    sourcemap: false,
    minify: false,
    legalComments: "none",
    logLevel: "silent",
    outfile: outFile,
    // Desktop-only proxy tunneling; the thin client never executes these paths.
    external: ["node:http", "node:net", "node:tls"],
    banner: { js: "// Deterministic web runtime boot for the thin-client WebView (see docs/FOUR-PACK.md)." },
    define: { "process.env": "{}", "process.platform": '"android"' },
    plugins: [{
      name: "web-runtime-shims",
      setup(builder) {
        builder.onResolve({ filter: /^node:crypto$/ }, () => ({ path: path.join(shims, "node-crypto.ts") }));
        builder.onResolve({ filter: /inference-router-local(\.js)?$/ }, () => ({ path: path.join(shims, "inference-router-local.ts") }));
        builder.onResolve({ filter: /local-docker-host-connector(\.js)?$/ }, () => ({ path: path.join(shims, "local-docker-host-connector.ts") }));
      },
    }],
  });
}

/**
 * Build THE one UI directory shared by all four packages:
 *   ui/renderer/          byte-exact copy of the pinned shipped renderer
 *   ui/client-overrides/  inert sidecar files shipped to every package
 *   client-ui-manifest.json
 * Deterministic: same inputs produce the same manifest, so packagers may
 * rebuild it at will and the four-pack parity check still holds.
 */
export async function buildClientUi({ force = false } = {}) {
  if (!existsSync(path.join(pinnedRendererRoot, "index.html"))) {
    throw new Error("The pinned renderer payload is missing. Run `npm run bootstrap` (set GROK_BOT_018_ASAR on Linux) before packaging.");
  }
  const rendererInventory = await inventoryOf(pinnedRendererRoot);
  const rendererInventorySha256 = sha256Bytes(Buffer.from(JSON.stringify(rendererInventory.map(({ path: file, bytes, sha256 }) => ({ file, bytes, sha256 })))));
  const overlayInventory = existsSync(rendererOverlayRoot) ? await inventoryOf(rendererOverlayRoot) : [];
  const overlayInventorySha256 = overlayInventory.length === 0
    ? "none"
    : sha256Bytes(Buffer.from(JSON.stringify(overlayInventory.map(({ path: file, bytes, sha256 }) => ({ file, bytes, sha256 })))));

  const hasOverrides = existsSync(clientOverridesRoot);
  const bootReady = existsSync(webRuntimeBootEntry);
  const webRuntimeDir = path.join(repoRoot, "source", "client-runtime", "web");
  const webRuntimeSourceSha256 = existsSync(webRuntimeDir)
    ? sha256Bytes(Buffer.from(JSON.stringify(await inventoryOf(webRuntimeDir))))
    : "none";
  const overridesInventorySha256 = hasOverrides
    ? sha256Bytes(Buffer.from(JSON.stringify(await inventoryOf(clientOverridesRoot))))
    : "none";
  if (!force) {
    const cached = await loadClientUiManifest();
    const cachedHasBoot = cached?.manifest.files.some(file => file.path === "client-overrides/boot.js") === true;
    if (cached != null
      && cached.manifest.renderer.inventorySha256 === rendererInventorySha256
      && cached.manifest.renderer.overlayInventorySha256 === overlayInventorySha256
      && cached.manifest.clientOverrides.present === (hasOverrides && bootReady)
      && cached.manifest.webRuntimeSourceSha256 === webRuntimeSourceSha256
      && cached.manifest.clientOverrides.inventorySha256 === overridesInventorySha256
      && cachedHasBoot === bootReady) {
      const staged = await inventoryOf(clientUiRoot);
      if (JSON.stringify(staged) === JSON.stringify(cached.manifest.files)) {
        return { uiRoot: clientUiRoot, manifestPath: clientUiManifestPath, manifest: cached.manifest, cached: true };
      }
    }
  }

  await rm(clientUiRoot, { recursive: true, force: true });
  await mkdir(clientUiRoot, { recursive: true });
  await cp(pinnedRendererRoot, path.join(clientUiRoot, "renderer"), { recursive: true, dereference: false, preserveTimestamps: true });
  if (existsSync(rendererOverlayRoot)) {
    await cp(rendererOverlayRoot, path.join(clientUiRoot, "renderer"), { recursive: true, dereference: false, preserveTimestamps: true });
  }
  const routerSettings = path.join(clientUiRoot, "renderer", ROUTER_SETTINGS_OVERLAY);
  if (!existsSync(routerSettings) || !routerSettingsHasApi(await readFile(routerSettings, "utf8"))) {
    throw new Error(`Client-UI is missing the Windows Router settings page (${ROUTER_SETTINGS_OVERLAY}). Put the Windows truth under client-ui/renderer-overlay/.`);
  }
  if (hasOverrides) {
    await cp(clientOverridesRoot, path.join(clientUiRoot, "client-overrides"), { recursive: true, dereference: false, preserveTimestamps: true });
  }
  if (bootReady) {
    await mkdir(path.join(clientUiRoot, "client-overrides"), { recursive: true });
    await buildWebRuntimeBoot(path.join(clientUiRoot, "client-overrides", "boot.js"));
  }
  const files = await inventoryOf(clientUiRoot);
  const manifest = manifestFor(files, {
    rendererInventorySha256,
    overlayInventorySha256,
    overrides: hasOverrides && bootReady,
    webRuntimeSourceSha256,
    overridesInventorySha256,
  });
  await mkdir(clientUiBuildDir, { recursive: true });
  await writeFile(clientUiManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { uiRoot: clientUiRoot, manifestPath: clientUiManifestPath, manifest, cached: false };
}

export async function loadClientUiManifest() {
  if (!existsSync(clientUiManifestPath)) return null;
  const manifest = JSON.parse(await readFile(clientUiManifestPath, "utf8"));
  if (manifest?.schemaVersion !== CLIENT_UI_SCHEMA_VERSION || manifest?.kind !== "openbot-client-ui" || !Array.isArray(manifest.files)) {
    throw new Error(`${clientUiManifestPath} is not a valid client-UI manifest.`);
  }
  return { manifestPath: clientUiManifestPath, manifest };
}

/**
 * Copy the staged client-UI into an Android web root and fail closed on any
 * byte drift. The web root receives the renderer at its top level (index.html
 * at the root) plus the client-overrides directory verbatim.
 */
export async function installClientUiIntoWebRoot(webRoot, { manifest } = {}) {
  const built = manifest != null ? { uiRoot: clientUiRoot, manifest } : await buildClientUi();
  await rm(webRoot, { recursive: true, force: true });
  await mkdir(webRoot, { recursive: true });
  await cp(path.join(built.uiRoot, "renderer"), webRoot, { recursive: true, dereference: false, preserveTimestamps: true });
  if (await exists(path.join(built.uiRoot, "client-overrides"))) {
    await cp(path.join(built.uiRoot, "client-overrides"), path.join(webRoot, "client-overrides"), { recursive: true, dereference: false, preserveTimestamps: true });
  }
  const staged = await inventoryOf(webRoot);
  // The web root receives the renderer at its top level; map staged paths to
  // the manifest's renderer/ and client-overrides/ sections before comparing.
  const mapped = staged
    .map(file => file.path.startsWith("client-overrides/") ? file : { ...file, path: `renderer/${file.path}` })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (JSON.stringify(mapped) !== JSON.stringify(built.manifest.files)) {
    throw new Error(`Staged Android web root drifted from the client-UI manifest (${webRoot}).`);
  }
  return { webRoot, manifest: built.manifest };
}

/**
 * Electron packages install the ONE client-UI directory into the stage:
 *   dist/renderer         ← pinned renderer + Windows overlay (same bytes as Android www)
 *   dist/client-overrides ← sidecar (boot.js, mobile.css); desktop does not execute boot
 * Existing asar pack / shell install paths are unchanged; this only fills the stage.
 */
export async function installClientOverridesIntoStage(stageRoot) {
  const built = await buildClientUi();
  const rendererDestination = path.join(stageRoot, "dist", "renderer");
  await rm(rendererDestination, { recursive: true, force: true });
  await cp(path.join(built.uiRoot, "renderer"), rendererDestination, { recursive: true, dereference: false, preserveTimestamps: true });
  const routerSettings = await readFile(path.join(rendererDestination, ROUTER_SETTINGS_OVERLAY), "utf8");
  if (!routerSettingsHasApi(routerSettings)) {
    throw new Error(`Staged Electron renderer is missing the Windows Router settings page (${ROUTER_SETTINGS_OVERLAY}).`);
  }
  await writeRendererRouterExtension(stageRoot, rendererDestination);
  let overridesDestination = null;
  if (await exists(path.join(built.uiRoot, "client-overrides"))) {
    overridesDestination = path.join(stageRoot, "dist", "client-overrides");
    await rm(overridesDestination, { recursive: true, force: true });
    await cp(path.join(built.uiRoot, "client-overrides"), overridesDestination, { recursive: true, dereference: false, preserveTimestamps: true });
  }
  return { installed: true, rendererDestination, destination: overridesDestination };
}

/**
 * Mac checksum-pinned verification allows at most two patched renderer chunks
 * (panel + registry). Record the Windows overlay so Linux/Windows/macOS share
 * the same asar bytes without failing verifyChecksumPinnedRendererPackage.
 */
export async function writeRendererRouterExtension(stageRoot, rendererDestination) {
  const overlayFiles = existsSync(rendererOverlayRoot) ? await walkFiles(rendererOverlayRoot) : [];
  if (overlayFiles.length === 0) {
    throw new Error("Windows renderer overlay is empty; refusing to pack a Cursor-only settings page.");
  }
  if (overlayFiles.length > 2) {
    throw new Error(`Windows overlay has ${overlayFiles.length} files; mac renderer-extension contract allows at most two chunks.`);
  }
  const chunks = [];
  for (const relative of overlayFiles) {
    const role = RENDERER_OVERLAY_ROLES[relative];
    if (role == null) {
      throw new Error(`Windows overlay file ${relative} has no renderer-extension role (panel|registry).`);
    }
    const original = await readFile(path.join(pinnedRendererRoot, relative));
    const patched = await readFile(path.join(rendererDestination, relative));
    chunks.push({
      path: `dist/renderer/${relative}`,
      role,
      original: { bytes: original.byteLength, sha256: sha256Bytes(original) },
      patched: { bytes: patched.byteLength, sha256: sha256Bytes(patched) },
    });
  }
  const extension = {
    schemaVersion: 1,
    mode: "original-renderer-settings-extension",
    chunks,
    features: ["router-api-settings", "self-host-server"],
    transformations: ["windows-renderer-overlay"],
  };
  await mkdir(path.join(stageRoot, "dist"), { recursive: true });
  await writeFile(path.join(stageRoot, "dist", "renderer-router-extension.json"), `${JSON.stringify(extension)}\n`);
  return extension;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

// ---- four-pack verification rules -----------------------------------------

export const FOUR_PACK_STEP_REFS = {
  forwarder: "docs/FOUR-PACK.md 步骤 3（本机转发器）",
  shell: "docs/FOUR-PACK.md 步骤 4（WebView 壳改造）",
  webRuntime: "docs/FOUR-PACK.md 步骤 5（网页运行时）",
  mobileCss: "docs/FOUR-PACK.md 步骤 6（窄屏样式）",
};

export const ANDROID_FORWARDER_CORE_PATH = path.join(repoRoot, "targets", "android", "app", "src", "main", "java", "com", "grokbot", "reconstructed", "ForwarderCore.java");
export const ANDROID_FORWARDER_GLUE_PATH = path.join(repoRoot, "targets", "android", "app", "src", "main", "java", "com", "grokbot", "reconstructed", "GatewayForwarder.java");
export const ANDROID_MAIN_ACTIVITY_PATH = path.join(repoRoot, "targets", "android", "app", "src", "main", "java", "com", "grokbot", "reconstructed", "MainActivity.java");
export const WEB_RUNTIME_ENTRY = path.join(repoRoot, "source", "client-runtime", "web", "entry.ts");

/** The pure proxy core: browser headers out, token in, SSE streamed. */
export function forwarderCoreFindings(source) {
  const findings = [];
  const add = (severity, message) => findings.push({ check: 2, severity, message });
  if (!(/"Origin"/.test(source) && /"Referer"/.test(source) && /Sec-Fetch/.test(source))) {
    add("fail", "forwarder must strip browser-origin headers (Origin, Referer, Sec-Fetch-*) before proxying");
  }
  if (!/setRequestProperty\("Authorization", "Bearer "/.test(source)) add("fail", "forwarder must add the gateway token as Authorization: Bearer ... natively");
  if (!/getInputStream\(\)/.test(source) || !/pump\(/.test(source)) add("fail", "forwarder must pump the upstream response stream in bounded chunks (getInputStream + pump)");
  if (!/Accept-Encoding/.test(source) || !/"identity"/.test(source)) add("fail", "forwarder must request accept-encoding: identity so the SSE stream is never compressed");
  if (/readAllBytes\(\)/.test(source)) add("fail", "forwarder must never buffer a response stream (readAllBytes)");
  if (!/setFixedLengthStreamingMode/.test(source)) add("fail", "forwarder must forward request bodies with bounded streaming (setFixedLengthStreamingMode)");
  if (!(/\/api\//.test(source) && /\/events/.test(source) && /\/avatars\//.test(source) && /\/health/.test(source))) {
    add("fail", "forwarder must proxy /api, /events, /avatars and /health only");
  }
  if (!/"127\.0\.0\.1"/.test(source)) add("fail", "forwarder must bind and accept loopback only (127.0.0.1)");
  if (!/LOOPBACK_MESSAGE|loopback/i.test(source)) add("fail", "forwarder must refuse a loopback box address with a human message");
  if (/listAgents|sendPrompt\(|createAgent\(/.test(source.replace(/\/api\//g, ""))) add("fail", "forwarder must not contain chat logic (listAgents/sendPrompt/createAgent calls)");
  return findings;
}

/** The Android glue: Keystore token, stored box address, no chat logic. */
export function forwarderGlueFindings(source) {
  const findings = [];
  const add = (severity, message) => findings.push({ check: 2, severity, message });
  if (!/SecretsStore/.test(source) || !/gatewayToken/.test(source)) add("fail", "forwarder glue must take the gateway token from SecretsStore (Android Keystore), never from the page");
  if (!/boxBaseUrl/.test(source)) add("fail", "forwarder glue must expose the configured box address to the proxy");
  if (/listAgents|sendPrompt|createAgent|transcript/i.test(source)) add("fail", "forwarder glue must not contain chat logic");
  return findings;
}

export function androidShellFindings(mainActivitySource) {
  const findings = [];
  const add = (severity, message) => findings.push({ check: 3, severity, message });
  if (/loadUrl\(\s*"file:/.test(mainActivitySource)) add("fail", "MainActivity must load the UI from the local forwarder origin (http://127.0.0.1:<port>/), not file://");
  if (!/setAllowFileAccess\(\s*false\s*\)/.test(mainActivitySource)) add("fail", "MainActivity must disable file access (setAllowFileAccess(false))");
  if (!/GatewayForwarder/.test(mainActivitySource)) add("fail", "MainActivity must start GatewayForwarder and load http://127.0.0.1:<forwarder port>/");
  if (!/addDocumentStartJavaScript|boot\.js/.test(mainActivitySource)) add("fail", "MainActivity must inject the web runtime (client-overrides/boot.js) before the UI bundle runs");
  if (!/hasGatewayToken/.test(mainActivitySource)) add("fail", "MainActivity must expose hasGatewayToken() so the page can never read the gateway token itself");
  return findings;
}

export function webRuntimeFindings(entrySource) {
  const findings = [];
  const add = (severity, message) => findings.push({ check: 2, severity, message });
  if (/revealSecret\(/.test(entrySource) && /gatewayToken|selfHost.*token|boxToken/i.test(entrySource)) {
    add("fail", "web runtime must never read the gateway token; the forwarder adds it natively");
  }
  const foreign = [];
  for (const match of entrySource.matchAll(/https?:\/\/[^\s"'`)]+/gi)) {
    let url;
    try { url = new URL(match[0].replace(/[.,;]+$/, "")); } catch { continue; }
    const isGatewayPath = ["/api", "/events", "/avatars", "/health"].some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (isGatewayPath && !loopback) foreign.push(url.origin);
  }
  if (foreign.length > 0) {
    add("fail", `web runtime must not hardcode absolute box gateway addresses (${[...new Set(foreign)].join(", ")}); every gateway call goes through location.origin (the local forwarder)`);
  }
  if (!/parseSelfHostGatewayAddress/.test(entrySource)) add("fail", "web runtime Connect handling must validate the box address with parseSelfHostGatewayAddress (rejects 127.0.0.1 with a human hint)");
  if (!/createDesktopBridge/.test(entrySource) || !/createCoordinatorPortBroker|coordinatorPort/.test(entrySource)) {
    add("fail", "web runtime must install the same window.desktop / window.coordinatorPort contracts as the desktop preload");
  }
  if (!/(?:^|\n)\s*installWebRuntime\(\);/.test(entrySource)) {
    add("fail", "web runtime boot must call installWebRuntime() on load so the Android page actually gets window.desktop");
  }
  return findings;
}

export const RENDERER_FORBIDDEN_ANDROID_FILES = [
  "desktop-shell.js",
  "desktop-shell.js.map",
];

export function stagedWebRootFindings(files, { requireOverrides = true } = {}) {
  const findings = [];
  const add = (severity, message) => findings.push({ check: 1, severity, message });
  const relative = new Set(files);
  if (!relative.has("index.html")) add("fail", "staged web root is missing index.html (the pinned renderer entry)");
  for (const forbidden of RENDERER_FORBIDDEN_ANDROID_FILES) {
    if (relative.has(forbidden)) add("fail", `staged web root contains the recovered dev shell artifact ${forbidden}`);
  }
  for (const file of files) {
    if (file.endsWith(".map")) add("fail", `staged web root contains a sourcemap (${file}); the four-pack UI ships without dev artifacts`);
    if (file.includes("__reconstructed_health")) add("fail", `staged web root contains the dev health harness (${file})`);
  }
  if (requireOverrides && !files.some(file => file.startsWith("client-overrides/"))) {
    add("fail", "staged web root is missing client-overrides/; all four packages must carry the same sidecar files");
  }
  return findings;
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import {
  packedAndroidApk,
  packedLinuxAsar,
  packedWindowsAsar,
  skipUnlessExists,
} from "./harness/optional-pack.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overlayUbx = path.join(repoRoot, "client-ui/renderer-overlay/assets/index-UbX-y3il.js");
const overlayPanel = path.join(repoRoot, "client-ui/renderer-overlay/assets/index-BlqerJhg.js");

function parseModule(source, label) {
  try {
    acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    assert.fail(`${label} parse failed: ${error.message}`);
  }
}

function assertSettingsPanel(source, label) {
  parseModule(source, label);
  assert.equal(
    (source.match(/function prepareRouterPoolSave/g) ?? []).length,
    1,
    `${label} must declare prepareRouterPoolSave once`,
  );
  assert.match(source, /Ta as SettingsModal/, `${label} must export SettingsModal`);
  assert.match(source, /function RServerPanel/, `${label} missing RServerPanel`);
  assert.match(source, /function RRouterPanel/, `${label} missing RRouterPanel`);
  assert.match(
    source,
    /window\.desktop\?\.agent\?\.getSelfHostConnection\?\./,
    `${label} Server panel must not throw if getSelfHostConnection is missing`,
  );
  assert.match(
    source,
    /window\.desktop\?\.agent\?\.onSelfHostInstallProgress\?\./,
    `${label} Server panel must not throw if onSelfHostInstallProgress is missing`,
  );
}

function assertChatOverlay(source, label) {
  parseModule(source, label);
  assert.match(source, /overlay:settings/, `${label} missing settings overlay entry`);
  assert.match(source, /id:"router",label:"Router"/, `${label} missing Router section`);
  assert.match(source, /id:"server",label:"Server"/, `${label} missing Server section`);
  assert.match(
    source,
    /function qht\(n\)\{const e=typeof n==="string"\?n\.trim\(\):""/,
    `${label} qht must not call trim on non-string content`,
  );
  assert.match(
    source,
    /function CEn\(n\)\{return typeof n==="string"&&EEn\.test/,
    `${label} CEn must not call trim on non-string content`,
  );
  assert.match(
    source,
    /typeof window\.desktop\?\.agent\?\.getSelfHostConnection==="function"/,
    `${label} auto-open Server must not throw if getSelfHostConnection is missing`,
  );
  assert.match(
    source,
    /x=h&&typeof r==="string"&&r\.length===0/,
    `${label} WWn must not read .length on non-string content`,
  );
  assert.match(
    source,
    /function Tpt\(n\)\{const e=typeof n==="string"\?n\.trim\(\):""/,
    `${label} Tpt must not call trim on non-string content`,
  );
  assert.match(
    source,
    /x=typeof s==="string"\?s\.trim\(\):""/,
    `${label} BPn must not call trim on non-string content`,
  );
  assert.match(
    source,
    /function MPn\(\{content:n,readyMetadata:e,promoteStandaloneLinks:t,isCacheable:s\}\)\{n=typeof n==="string"\?n:""/,
    `${label} MPn must coerce non-string markdown children to empty string`,
  );
}

test("overlay settings panel parses once and does not throw on missing desktop.agent", async () => {
  const panel = await readFile(overlayPanel, "utf8");
  assertSettingsPanel(panel, "overlay panel");
});

test("overlay UbX message helpers tolerate non-string content so every bubble does not hit the inline error boundary", async () => {
  const ubx = await readFile(overlayUbx, "utf8");
  assertChatOverlay(ubx, "overlay UbX");
});

test("packed linux asar settings chunk and UbX stay loadable", async (t) => {
  if (skipUnlessExists(t, packedLinuxAsar, "packed linux asar missing; run pack:all")) return;
  const { extractFile } = await import("@electron/asar");
  const panel = extractFile(packedLinuxAsar, "dist/renderer/assets/index-BlqerJhg.js").toString("utf8");
  const ubx = extractFile(packedLinuxAsar, "dist/renderer/assets/index-UbX-y3il.js").toString("utf8");
  assertSettingsPanel(panel, "packed linux panel");
  assertChatOverlay(ubx, "packed linux UbX");
  assertPackedSidecars(ubx, "packed linux UbX");
});

function assertPackedSidecars(source, label) {
  assert.match(source, /void function __sandJumpToBottom/, `${label} missing jump-to-bottom`);
  assert.match(source, /void function __sandRewindFromHere/, `${label} missing rewind-from-here`);
  assert.match(source, /shouldInjectIntoMenu/, `${label} rewind must skip in-row React menus`);
  assert.match(source, /observer\.disconnect/, `${label} rewind observer must disconnect before inject`);
  assert.match(source, /subscribePort/, `${label} rewind must use subscribePort, not rewrite frozen claim`);
  assert.doesNotMatch(source, /bridge\.claim\s*=/, `${label} rewind must not assign coordinatorPort.claim`);
}

test("packed windows asar settings chunk matches linux", async (t) => {
  if (skipUnlessExists(t, packedWindowsAsar, "packed windows asar missing; run pack:all")) return;
  const { extractFile } = await import("@electron/asar");
  const panel = extractFile(packedWindowsAsar, "dist/renderer/assets/index-BlqerJhg.js").toString("utf8");
  const ubx = extractFile(packedWindowsAsar, "dist/renderer/assets/index-UbX-y3il.js").toString("utf8");
  assertSettingsPanel(panel, "packed windows panel");
  assertChatOverlay(ubx, "packed windows UbX");
  assertPackedSidecars(ubx, "packed windows UbX");
});

test("packed android apk copies the same settings overlay", async (t) => {
  if (skipUnlessExists(t, packedAndroidApk, "packed android apk missing; run pack:all")) return;
  const panel = execFileSync("unzip", ["-p", packedAndroidApk, "assets/www/assets/index-BlqerJhg.js"], {
    maxBuffer: 8 * 1024 * 1024,
  }).toString("utf8");
  const ubx = execFileSync("unzip", ["-p", packedAndroidApk, "assets/www/assets/index-UbX-y3il.js"], {
    maxBuffer: 32 * 1024 * 1024,
  }).toString("utf8");
  assertSettingsPanel(panel, "packed android panel");
  assertChatOverlay(ubx, "packed android UbX");
  assertPackedSidecars(ubx, "packed android UbX");
});

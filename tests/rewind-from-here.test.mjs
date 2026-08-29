import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rewindSource = path.join(repoRoot, "source", "client-overrides", "rewind-from-here.js");

async function loadLogic() {
  const source = await readFile(rewindSource, "utf8");
  const sandbox = { globalThis: {} };
  sandbox.globalThis.globalThis = sandbox.globalThis;
  new Function("globalThis", source)(sandbox.globalThis);
  return sandbox.globalThis.__sandRewindLogic;
}

test("rewind menu is only offered on the user's own message row", async () => {
  const logic = await loadLogic();
  assert.equal(logic.shouldShowRewind("user", "t2u"), true);
  assert.equal(logic.shouldShowRewind("assistant", "t1s0"), false);
  assert.equal(logic.shouldShowRewind("user", ""), false);
  assert.equal(
    logic.isUserRow({ getAttribute: (name) => (name === "data-role" ? "user" : name === "data-entry-id" ? "t2u" : null) }),
    true,
  );
});

test("overlay copy is restart-from-here, not unsend, and is not in ProductionRenderer", async () => {
  const source = await readFile(rewindSource, "utf8");
  assert.match(source, /void function __sandRewindFromHere/);
  assert.match(source, /从这里重来/);
  assert.match(source, /不会撤销已经做过的/);
  assert.match(source, /rewindTranscript/);
  assert.doesNotMatch(source, /ProductionRenderer/);
  const recovered = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8").catch(() => "");
  assert.equal(recovered.includes("__sandRewindFromHere"), false);
  assert.equal(recovered.includes("rewindTranscript"), false);
});

test("appendRewindFromHere writes the marker once onto a fake UbX module", async () => {
  const { appendRewindFromHere } = await import(pathToFileURL(path.join(repoRoot, "scripts/lib/four-pack.mjs")).href);
  const dir = await mkdtemp(path.join(tmpdir(), "openbot-rewind-"));
  const ubx = path.join(dir, "index-UbX-y3il.js");
  await writeFile(ubx, "const x = 1;\nexport { x };\n");
  try {
    assert.equal(await appendRewindFromHere(ubx), true);
    const once = await readFile(ubx, "utf8");
    assert.match(once, /void function __sandRewindFromHere/);
    assert.equal(await appendRewindFromHere(ubx), false);
    const twice = await readFile(ubx, "utf8");
    assert.equal(twice.split("__sandRewindFromHere").length, once.split("__sandRewindFromHere").length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("packed linux asar UbX includes 从这里重来 on the official chat bundle", async () => {
  const { extractFile } = await import("@electron/asar");
  const asar = path.join(repoRoot, "dist/openbot-linux-x64/resources/app.asar");
  assert.equal(existsSync(asar), true, "packed linux asar missing; run pack:all");
  const packed = extractFile(asar, "dist/renderer/assets/index-UbX-y3il.js").toString("utf8");
  assert.match(packed, /void function __sandRewindFromHere/);
  assert.match(packed, /从这里重来/);
  assert.match(packed, /rewindTranscript/);
});

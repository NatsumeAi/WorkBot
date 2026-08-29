import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packedLinuxAsar, skipUnlessExists } from "./harness/optional-pack.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jumpSource = path.join(repoRoot, "source/client-overrides/jump-to-bottom.js");

async function loadLogic() {
  const source = await readFile(jumpSource, "utf8");
  const sandbox = { globalThis: {} };
  sandbox.globalThis.globalThis = sandbox.globalThis;
  new Function("globalThis", source)(sandbox.globalThis);
  return sandbox.globalThis.__sandJumpLogic;
}

test("jump-to-bottom shows only when the transcript is scrolled away from the latest", async () => {
  const logic = await loadLogic();
  assert.equal(typeof logic?.awayFromBottom, "function");
  assert.equal(logic.awayFromBottom({ scrollHeight: 800, scrollTop: 0, clientHeight: 400 }), true);
  assert.equal(logic.awayFromBottom({ scrollHeight: 400, scrollTop: 0, clientHeight: 400 }), false);
  assert.equal(logic.awayFromBottom({ scrollHeight: 800, scrollTop: 400, clientHeight: 400 }), false);
});

test("jump uses the official virtual transcript viewport and inner height, not a parent overflow walk", async () => {
  const logic = await loadLogic();
  assert.equal(typeof logic.pickScroller, "function");
  assert.equal(typeof logic.metricsOf, "function");
  const transcript = { id: "vt", className: "sand-virtual-transcript", overflowY: "hidden", scrollHeight: 400, clientHeight: 400, scrollTop: 0 };
  const overflowingParent = { id: "shell", overflowY: "auto", scrollHeight: 900, clientHeight: 400, scrollTop: 0 };
  assert.equal(logic.pickScroller(transcript, overflowingParent), transcript);
  const inner = { scrollHeight: 0, offsetHeight: 0, style: { height: "1200px" } };
  const metrics = logic.metricsOf({
    scrollTop: 0,
    clientHeight: 400,
    scrollHeight: 400,
    querySelector: (sel) => (sel === ".sand-virtual-transcript__inner" ? inner : null),
  });
  assert.equal(metrics.scrollHeight, 1200);
  assert.equal(logic.awayFromBottom(metrics), true);
  const source = await readFile(jumpSource, "utf8");
  assert.match(source, /position:\s*fixed/);
  assert.match(source, /doc\.body/);
  assert.doesNotMatch(source, /overflowParent/);
  assert.doesNotMatch(source, /stage\.appendChild/);
});

test("overlay inject marker is the official chat bundle, not recovered ProductionRenderer", async () => {
  const source = await readFile(jumpSource, "utf8");
  assert.match(source, /void function __sandJumpToBottom/);
  assert.match(source, /sand-virtual-transcript/);
  assert.match(source, /跳到最新/);
  const recovered = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8").catch(() => "");
  assert.equal(recovered.includes("__sandJumpToBottom"), false);
});

test("appendJumpToBottom writes the marker once onto a fake UbX module", async () => {
  const { appendJumpToBottom } = await import(pathToFileURL(path.join(repoRoot, "scripts/lib/four-pack.mjs")).href);
  const dir = await mkdtemp(path.join(tmpdir(), "openbot-jump-"));
  const ubx = path.join(dir, "index-UbX-y3il.js");
  await writeFile(ubx, "const x = 1;\nexport { x };\n");
  try {
    assert.equal(await appendJumpToBottom(ubx), true);
    const once = await readFile(ubx, "utf8");
    assert.match(once, /void function __sandJumpToBottom/);
    assert.equal(await appendJumpToBottom(ubx), false);
    const twice = await readFile(ubx, "utf8");
    assert.equal(twice.split("__sandJumpToBottom").length, once.split("__sandJumpToBottom").length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("packed linux asar UbX includes the jump-to-bottom marker", async (t) => {
  if (skipUnlessExists(t, packedLinuxAsar, "packed linux asar missing; run pack:all")) return;
  const { extractFile } = await import("@electron/asar");
  const packed = extractFile(packedLinuxAsar, "dist/renderer/assets/index-UbX-y3il.js").toString("utf8");
  assert.match(packed, /void function __sandJumpToBottom/);
  assert.match(packed, /跳到最新/);
  const overlay = packed.slice(packed.indexOf("void function __sandJumpToBottom"));
  assert.match(overlay, /position:\s*fixed/);
  assert.doesNotMatch(overlay, /stage\.appendChild/);
});

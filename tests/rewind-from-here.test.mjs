import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packedLinuxAsar, skipUnlessExists } from "./harness/optional-pack.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rewindSource = path.join(repoRoot, "source", "client-overrides", "rewind-from-here.js");

async function loadLogic() {
  const source = await readFile(rewindSource, "utf8");
  const sandbox = { globalThis: {} };
  sandbox.globalThis.globalThis = sandbox.globalThis;
  new Function("globalThis", source)(sandbox.globalThis);
  return sandbox.globalThis.__sandRewindLogic;
}

function mockNode(attrs, parent = null) {
  const node = {
    attrs,
    parentElement: parent,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    closest(selector) {
      let current = this;
      while (current != null) {
        if (selector === ".sand-message-action-anchor" && current.attrs.className === "sand-message-action-anchor") return current;
        if (selector === "[data-entry-id], [data-row-key]" && (current.attrs["data-entry-id"] != null || current.attrs["data-row-key"] != null)) return current;
        current = current.parentElement;
      }
      return null;
    },
  };
  return node;
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

test("rewind does not append into a Message actions menu that still sits inside a transcript row", async () => {
  const logic = await loadLogic();
  assert.equal(typeof logic.shouldInjectIntoMenu, "function");
  assert.equal(typeof logic.isInRowMenu, "function");
  const rowMenu = {
    getAttribute: (name) => (name === "aria-label" ? "Message actions" : null),
    closest: (selector) => (selector === "[data-entry-id], [data-row-key]" ? { id: "row" } : null),
  };
  const portaledMenu = {
    getAttribute: (name) => (name === "aria-label" ? "Message actions" : null),
    closest: () => null,
  };
  assert.equal(logic.isRewindMenu(rowMenu), true);
  assert.equal(logic.isInRowMenu(rowMenu), true);
  assert.equal(logic.shouldInjectIntoMenu(rowMenu), false);
  assert.equal(logic.shouldInjectIntoMenu(portaledMenu), true);
  const source = await readFile(rewindSource, "utf8");
  assert.match(source, /shouldInjectIntoMenu/);
  assert.match(source, /observer\.disconnect/);
});

test("official right-click row is data-row-key without --menu-open or data-entry-id", async () => {
  const logic = await loadLogic();
  assert.equal(typeof logic.rowFromTarget, "function");
  assert.equal(typeof logic.entryIdFromRow, "function");
  assert.equal(typeof logic.isRewindMenu, "function");
  const row = mockNode({ "data-row-key": "t2u", "data-role": "user" });
  const anchor = mockNode({ className: "sand-message-action-anchor" }, row);
  row.parentElement = null;
  anchor.parentElement = row;
  const target = mockNode({ className: "sand-message-text" }, anchor);
  const found = logic.rowFromTarget(target);
  assert.equal(logic.entryIdFromRow(found), "t2u");
  assert.equal(found.getAttribute("data-role"), "user");
  assert.equal(logic.shouldShowRewind(found.getAttribute("data-role"), logic.entryIdFromRow(found)), true);
  assert.equal(logic.isUserRow(found), true);
  assert.equal(logic.isRewindMenu({ getAttribute: (name) => (name === "aria-label" ? "Message actions" : null) }), true);
  assert.equal(logic.isRewindMenu({ getAttribute: (name) => (name === "aria-label" ? "More message actions" : null) }), false);
  const source = await readFile(rewindSource, "utf8");
  assert.match(source, /data-row-key/);
  assert.match(source, /contextmenu/);
  assert.doesNotMatch(source, /sand-message-action-anchor--menu-open/);
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

test("rewind sidecar does not throw when coordinatorPort.claim is a frozen contextBridge property", async () => {
  const source = await readFile(rewindSource, "utf8");
  assert.doesNotMatch(source, /bridge\.claim\s*=/);
  assert.doesNotMatch(source, /\.claim\s*=\s*function/);
  assert.match(source, /subscribePort/);
  const bridge = {};
  Object.defineProperty(bridge, "claim", {
    value: () => null,
    writable: false,
    configurable: false,
  });
  const sandbox = {
    globalThis: {
      coordinatorPort: bridge,
      document: {
        addEventListener() {},
        querySelectorAll() { return []; },
        documentElement: {},
        readyState: "complete",
      },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
    },
  };
  sandbox.globalThis.globalThis = sandbox.globalThis;
  assert.doesNotThrow(() => new Function("globalThis", source)(sandbox.globalThis));
});

test("rewind captures the coordinator port through subscribePort, not by rewriting claim", async () => {
  const source = await readFile(rewindSource, "utf8");
  const brokerSource = await readFile(
    path.join(repoRoot, "source/electron-preload/coordinator-port-bridge.ts"),
    "utf8",
  );
  assert.match(brokerSource, /subscribePort\(listener\)/);
  const received = [];
  const listeners = [];
  let owner = null;
  const bridge = {
    claim(consumer) {
      if (owner != null) return null;
      owner = consumer;
      return { request() {}, release() { owner = null; } };
    },
    subscribePort(listener) {
      listeners.push(listener);
      return () => {};
    },
  };
  const sandbox = {
    globalThis: {
      coordinatorPort: bridge,
      document: {
        addEventListener() {},
        querySelectorAll() { return []; },
        documentElement: {},
        readyState: "complete",
      },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
    },
  };
  sandbox.globalThis.globalThis = sandbox.globalThis;
  new Function("globalThis", source)(sandbox.globalThis);
  const official = { onPort(port) { received.push(`official:${port.id}`); } };
  assert.notEqual(bridge.claim(official), null);
  const port = { id: "p1", addEventListener() {}, postMessage() {} };
  owner.onPort(port);
  for (const listener of listeners) listener(port);
  assert.equal(received.includes("official:p1"), true);
  assert.equal(listeners.length, 1);
  assert.equal(sandbox.globalThis.__sandRewindLogic.capturedPort(), port);
});

test("packed linux asar UbX includes 从这里重来 on the official chat bundle", async (t) => {
  if (skipUnlessExists(t, packedLinuxAsar, "packed linux asar missing; run pack:all")) return;
  const { extractFile } = await import("@electron/asar");
  const packed = extractFile(packedLinuxAsar, "dist/renderer/assets/index-UbX-y3il.js").toString("utf8");
  assert.match(packed, /void function __sandRewindFromHere/);
  assert.match(packed, /从这里重来/);
  assert.match(packed, /rewindTranscript/);
  const overlay = packed.slice(packed.indexOf("void function __sandRewindFromHere"));
  assert.match(overlay, /data-row-key/);
  assert.match(overlay, /shouldInjectIntoMenu/);
  assert.match(overlay, /observer\.disconnect/);
  assert.match(overlay, /subscribePort/);
  assert.doesNotMatch(overlay, /bridge\.claim\s*=/);
  assert.doesNotMatch(overlay, /sand-message-action-anchor--menu-open/);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadTs(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "openbot-unsigned-"));
  const output = path.join(temporary, `${path.basename(entry, ".ts")}.mjs`);
  await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: [path.join(repoRoot, entry)],
    format: "esm",
    outfile: output,
    packages: "external",
    platform: "node",
  });
  return {
    module: await import(`${pathToFileURL(output).href}?${Date.now()}`),
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

test("unsigned Cursor status still has a coordinator account slot", async () => {
  const loaded = await loadTs("source/shared/auth.ts");
  try {
    const { cursorAccountSlot, LOCAL_UNSIGNED_ACCOUNT_SLOT } = loaded.module;
    assert.equal(LOCAL_UNSIGNED_ACCOUNT_SLOT, "local");
    assert.equal(cursorAccountSlot({ kind: "logged-out" }), "local");
    assert.equal(cursorAccountSlot({ kind: "logging-in" }), "local");
    assert.equal(cursorAccountSlot({ kind: "logged-in", authId: "user-1" }), "user-1");
  } finally {
    await loaded.dispose();
  }
});

test("coordinator starts for a logged-out Cursor status", async () => {
  const loaded = await loadTs("source/electron-main/coordinator/coordinator-account-runtime.ts");
  try {
    const created = [];
    const authorized = [];
    const runtime = loaded.module.createCoordinatorAccountRuntime({
      createRuntime: () => {
        created.push("runtime");
        return {
          requestRendererPort() {},
          revokeRendererPortRequest() {},
          restart: async () => {},
          dispose: async () => {},
        };
      },
      authorizeAccount: async (slot, context) => {
        authorized.push({ slot, context });
        return true;
      },
      revokeRefusedAccount: async () => ({ kind: "ok", status: { kind: "logged-out" } }),
      prepareAccountTransition: async () => {},
      resetAccountState() {},
      revokeMainDataPort() {},
      deliverStatus() {},
      onProblem() {},
    });
    await runtime.start({ kind: "logged-out" });
    assert.deepEqual(authorized, [{ slot: "local", context: { isStartup: true, previousSlot: undefined } }]);
    assert.deepEqual(created, ["runtime"]);
    await runtime.dispose();
  } finally {
    await loaded.dispose();
  }
});

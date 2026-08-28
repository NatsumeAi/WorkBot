import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ["source/host/host-paths.ts"],
    format: "esm",
    platform: "node",
    write: false,
    packages: "external",
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error("esbuild produced no output");
  return import(`data:text/javascript;base64,${Buffer.from(file.text).toString("base64")}`);
}

test("OpenBot production and box data roots are not Grok Bot paths", async () => {
  const {
    SAND_PRODUCTION_DATA_DIRNAME,
    SAND_DATA_DIRNAME,
    SAND_BOX_DATA_ROOT,
    getSandProductionRootDir,
    getSandRootDir,
  } = await load();
  assert.equal(SAND_PRODUCTION_DATA_DIRNAME, ".openbot");
  assert.equal(SAND_DATA_DIRNAME, "openbot-data");
  assert.equal(SAND_BOX_DATA_ROOT, "/home/box/sand-data");
  assert.equal(getSandProductionRootDir("/home/someone"), "/home/someone/.openbot");
  assert.equal(path.basename(getSandProductionRootDir(homedir())), ".openbot");
  assert.notEqual(SAND_PRODUCTION_DATA_DIRNAME, ".grokbot");
  assert.notEqual(SAND_DATA_DIRNAME, "sand-data");
  assert.equal(getSandRootDir("/home/someone"), "/home/someone/.openbot");
});

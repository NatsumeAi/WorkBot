import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error(`esbuild produced no output for ${entry}`);
  const outfile = path.join(repoRoot, `.tmp-test-${randomUUID()}.mjs`);
  await writeFile(outfile, file.text);
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    await unlink(outfile).catch(() => {});
  }
}

test("Task types include computerUse/browserUse when the box desktop is live", async () => {
  const {
    buildProductionSubagentConfigs,
    productionSubagentTypeNames,
  } = await loadTs("source/host/runner/production-subagent-configs.ts");
  const empty = buildProductionSubagentConfigs({
    isSubagentRunner: false,
    remoteBoxHasDesktop: false,
    remoteBoxAvailable: false,
    browserUseOffered: false,
    multitaskEnabled: false,
    systemPromptOverridden: false,
  });
  assert.equal(empty, undefined);

  const boxed = buildProductionSubagentConfigs({
    isSubagentRunner: false,
    remoteBoxHasDesktop: true,
    remoteBoxAvailable: true,
    browserUseOffered: true,
    multitaskEnabled: false,
    systemPromptOverridden: false,
  });
  assert.deepEqual(productionSubagentTypeNames(boxed), ["computerUse", "browserUse"]);

  const child = buildProductionSubagentConfigs({
    isSubagentRunner: true,
    remoteBoxHasDesktop: true,
    remoteBoxAvailable: true,
    browserUseOffered: true,
    multitaskEnabled: true,
    systemPromptOverridden: false,
  });
  assert.equal(child, undefined);
});

test("Auto-review stays off when the Cursor classifier is not available", async () => {
  const { resolveSandAutoReviewModes } = await loadTs(
    "source/host/runner/sand-auto-review.ts",
  );
  const modes = resolveSandAutoReviewModes({
    settingsEnabled: true,
    enforceEnabled: true,
    classifierAvailable: false,
  });
  assert.equal(modes.boxShell, "off");
  assert.equal(modes.hostShell, "off");
  assert.equal(modes.computer, "off");
});

test("host wires Task types, browserUse without Cursor, and a live subagent shell", async () => {
  const composition = await readFile(
    path.join(repoRoot, "source/host/host-runner-composition.ts"),
    "utf8",
  );
  const experiments = await readFile(
    path.join(repoRoot, "source/host/extensions/experiments/extension.ts"),
    "utf8",
  );
  const autoReview = await readFile(
    path.join(repoRoot, "source/host/extensions/auto-review/auto-review-service.ts"),
    "utf8",
  );
  assert.match(composition, /buildProductionSubagentConfigs\(/);
  assert.doesNotMatch(composition, /subagentConfigs: \[\]/);
  assert.doesNotMatch(composition, /productionTurnRunShell: undefined/);
  assert.match(composition, /isComputerUseSubagentType\(args\.subagentType\)/);
  assert.match(experiments, /usesLocalInferenceClock/);
  assert.match(experiments, /isBrowserUseSubagentEnabled:/);
  assert.match(autoReview, /classifierAvailable/);
});

test("live box host-main has Task types, local browserUse, and auto-review off without Cursor", async () => {
  const liveHost = "/home/natsume/openbot-box/host-main.cjs";
  const host = await readFile(liveHost, "utf8");
  assert.match(host, /name: "computerUse"/);
  assert.match(host, /name: "browserUse"/);
  assert.match(host, /usesLocalInferenceClock\(settings\.getInferenceProvider/);
  assert.match(host, /classifierAvailable: this\.deps\.auth\.peekAccessToken/);
  assert.doesNotMatch(host, /productionTurnRunShell: void 0/);
});

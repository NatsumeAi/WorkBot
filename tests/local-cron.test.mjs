import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("pure cron is due on the box clock, not Cursor cloud", async () => {
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ["source/host/extensions/automations/local-cron-scheduler.ts"],
    format: "esm",
    platform: "node",
    write: false,
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error("esbuild produced no local-cron bundle");
  const { isDueLocalCron, nextLocalCronAt } = await import(`data:text/javascript;base64,${Buffer.from(file.text).toString("base64")}`);
  const createdAt = Date.now() - 70_000;
  const automation = {
    id: "one-minute-test",
    isEnabled: true,
    createdAt,
    lastRunAt: null,
    trigger: { type: "cron", schedule: "@every 1 m" },
  };
  const dueAt = nextLocalCronAt(automation);
  assert.equal(dueAt, createdAt + 60_000);
  assert.equal(isDueLocalCron(automation, createdAt + 61_000), true);
  assert.equal(isDueLocalCron(automation, createdAt + 1_000), false);
  assert.equal(isDueLocalCron({ ...automation, isEnabled: false }, createdAt + 61_000), false);
  assert.equal(isDueLocalCron({
    ...automation,
    trigger: { type: "slack", channel: "#x", match: { kind: "mention" } },
  }, createdAt + 61_000), false);
});

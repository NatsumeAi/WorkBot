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

test("daily cron uses settings timezone, not the box UTC wall", async () => {
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
  const b64 = Buffer.from(file.text).toString("base64");
  const { spawnSync } = await import("node:child_process");
  const script = `
    const { isDueLocalCron, LocalCronScheduler } = await import("data:text/javascript;base64,${b64}");
    const lastRunAt = 1787910012226;
    const at1745HongKong = 1787910300000;
    const automation = {
      id: "greet",
      isEnabled: true,
      createdAt: lastRunAt - 1000,
      lastRunAt,
      trigger: { type: "cron", schedule: "45 17 * * *" },
    };
    if (isDueLocalCron(automation, at1745HongKong) !== false) {
      console.error("utc-wall must not treat 17:45 as Hong Kong");
      process.exit(2);
    }
    if (isDueLocalCron(automation, at1745HongKong, "Asia/Hong_Kong") !== true) {
      console.error("Hong Kong 17:45 must be due");
      process.exit(3);
    }
    let fired = false;
    const scheduler = new LocalCronScheduler({
      isLocalClock: () => true,
      isReady: () => true,
      getTimeZone: () => "Asia/Hong_Kong",
      now: () => at1745HongKong,
      listAutomations: async () => [{ agentId: "agent", automation }],
      fire: async () => { fired = true; },
    });
    scheduler.start();
    scheduler.stop();
    await new Promise((r) => setImmediate(r));
    if (fired !== true) {
      console.error("tick must fire when settings timezone says due");
      process.exit(4);
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TZ: "UTC" },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
});

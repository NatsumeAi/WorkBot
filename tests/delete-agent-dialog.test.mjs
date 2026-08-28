import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink, writeFile, readFile } from "node:fs/promises";
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
    packages: "external",
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

function never() {
  return new Promise(() => {});
}

function stubExtensions() {
  const apis = {
    transcript: {
      deleteAgents: async () => ({ transcript: [] }),
      deleteAgent: async () => ({ transcript: [] }),
    },
    attachments: {},
    automations: {
      deleteAgentSchedules: () => never(),
    },
    "managed-setup": {},
    settings: {},
    "local-tool-permission": {},
    telemetry: {
      analytics: { markActive() {}, trackEvent() {} },
      logs: { reportAgentOpen() {} },
      noteSandModelExperimentActive() {},
    },
    "cross-user-sharing": {
      noteAgentDeleted: async () => {},
    },
    session: {
      forgetHandoff() {},
    },
  };
  return {
    api(id) {
      return apis[id] ?? {};
    },
  };
}

test("deleteAgents returns after the bot is gone even if box window teardown never finishes", async () => {
  const { createHostGatewayApi } = await loadTs("source/host/host-gateway-api.ts");
  let released = 0;
  const api = createHostGatewayApi({
    extensions: stubExtensions(),
    hostEvents: { emit() {} },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: () => {
      released += 1;
      return never();
    },
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission() {},
  });
  const result = await Promise.race([
    api.deleteAgents({ ids: ["bot-1"] }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("deleteAgents hung after the bot was already deleted")), 250);
    }),
  ]);
  assert.deepEqual(result, { transcript: [] });
  assert.equal(released, 1);

  const gateway = await readFile(
    path.join(repoRoot, "source/host/host-gateway-api.ts"),
    "utf8",
  );
  assert.match(gateway, /void deps\.releaseAgentBox\(id\)/);
  assert.match(gateway, /void deps\.releaseAgentBox\(args\.id\)/);

  const host = await readFile("/tmp/openbot-asar-sync/linux/dist/host/host-main.cjs", "utf8");
  assert.match(host, /void deps\.releaseAgentBox\(id\)/);
  assert.match(host, /void deps\.releaseAgentBox\(args\.id\)/);
  assert.doesNotMatch(host, /await deps\.releaseAgentBox\(id\)/);
  assert.doesNotMatch(host, /await deps\.releaseAgentBox\(args\.id\)/);

  const packedLinux = await readFile(
    path.join(repoRoot, "dist/openbot-linux-x64/resources/app.asar"),
  );
  assert.ok(
    packedLinux.includes(Buffer.from("void deps.releaseAgentBox(id)")),
    "packed linux asar missing fire-and-forget deleteAgents",
  );
  assert.ok(
    !packedLinux.includes(Buffer.from("await deps.releaseAgentBox(id)")),
    "packed linux asar still awaits box teardown on deleteAgents",
  );
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { extractFile } from "@electron/asar";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadLocalInstalls() {
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ["source/shared/node/mcp/local-mcp-installs.ts"],
    format: "esm",
    platform: "node",
    write: false,
    packages: "external",
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error("esbuild produced no local-installs bundle");
  return import(`data:text/javascript;base64,${Buffer.from(file.text).toString("base64")}`);
}

test("marketplace Add without a Cursor token writes local MCP config and never calls installUserPlugin", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openbot-unsigned-plugin-"));
  const settingsPath = path.join(dir, "settings.json");
  try {
    const local = await loadLocalInstalls();
    let cursorInstalls = 0;
    const plugin = {
      pluginId: "42",
      name: "demo",
      displayName: "Demo Plugin",
      description: "",
      category: "MCP",
      logoUrl: undefined,
      homepage: undefined,
      sourceUrls: ["https://github.com/example/demo/blob/main/mcp.json"],
      connectors: [{ name: "demo", description: "" }],
      skills: [],
      variableFields: [],
    };
    const pathKind = await local.installFromCatalog({
      plugin,
      token: async () => null,
      core: {
        bestEffortToken: async () => null,
        requireAccountWriter() {
          return {
            async installPlugin() {
              cursorInstalls += 1;
              throw new Error("installUserPlugin must not run without Cursor login");
            },
          };
        },
        getMachineId: async () => "test-machine",
        fetchPluginServers: async () => ({
          demo: { url: "https://example.test/mcp", type: "http" },
        }),
        settingsPath,
      },
    });
    assert.equal(pathKind, "local");
    assert.equal(cursorInstalls, 0);
    const installs = local.readLocalMcpInstalls(settingsPath);
    assert.equal(installs.length, 1);
    assert.equal(installs[0].pluginId, "42");
    assert.equal(installs[0].servers[0].config.url, "https://example.test/mcp");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsigned Add still works when Cursor account servers are missing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openbot-unsigned-plugin-merge-"));
  const settingsPath = path.join(dir, "settings.json");
  try {
    const local = await loadLocalInstalls();
    local.writeLocalMcpInstalls(settingsPath, [{
      pluginId: "7",
      displayName: "Local",
      servers: [{ id: "9000000001", name: "demo", serverIdentifier: "demo", config: { url: "https://example.test/mcp", type: "http" } }],
    }]);
    const merged = local.mergeLocalInstallDisplay(null, { settingsPath });
    assert.equal(merged.cacheScope, "local");
    assert.equal(merged.servers.length, 1);
    assert.equal(merged.servers[0].config.url, "https://example.test/mcp");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("packed asar installs marketplace plugins without a Cursor account writer", async () => {
  const packedPath = path.join(repoRoot, "dist/workbot-linux-x64/resources/app.asar");
  const main = extractFile(packedPath, "dist/electron-main/main.cjs").toString("utf8");
  const host = extractFile(packedPath, "dist/host/host-main.cjs").toString("utf8");
  for (const [label, source] of [["main", main], ["host", host]]) {
    assert.ok(source.includes("mcp-local-installs.json"), `packed ${label} missing local installs file`);
    assert.ok(source.includes("__sandLM.installFromCatalog"), `packed ${label} missing unsigned install path`);
  }
});

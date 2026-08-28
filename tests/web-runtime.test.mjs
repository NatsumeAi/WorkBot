import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let scratch = null;
let modules = null;

/**
 * Bundles the web runtime the same way the boot bundle does (same shims and
 * defines) but writes it to disk so bare imports resolve, then loads it.
 */
async function loadWebRuntime() {
  if (modules != null) return modules;
  scratch = await mkdtemp(path.join(tmpdir(), "web-runtime-test-"));
  const shims = path.join(repoRoot, "source", "client-runtime", "web", "shims");
  await esbuild({
    absWorkingDir: repoRoot,
    entryPoints: [
      path.join(repoRoot, "source", "client-runtime", "web", "web-main-transport.ts"),
      path.join(repoRoot, "source", "client-runtime", "web", "web-coordinator.ts"),
    ],
    outdir: scratch,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    sourcemap: false,
    logLevel: "silent",
    external: ["node:http", "node:net", "node:tls"],
    define: { "process.env": "{}", "process.platform": '"android"' },
    plugins: [{
      name: "web-runtime-shims",
      setup(builder) {
        builder.onResolve({ filter: /^node:crypto$/ }, () => ({ path: path.join(shims, "node-crypto.ts") }));
        builder.onResolve({ filter: /inference-router-local(\.js)?$/ }, () => ({ path: path.join(shims, "inference-router-local.ts") }));
        builder.onResolve({ filter: /local-docker-host-connector(\.js)?$/ }, () => ({ path: path.join(shims, "local-docker-host-connector.ts") }));
      },
    }],
  });
  modules = {
    main: await import(path.join(scratch, "web-main-transport.js")),
    coordinator: await import(path.join(scratch, "web-coordinator.js")),
  };
  return modules;
}

test.after(async () => {
  if (scratch != null) await rm(scratch, { recursive: true, force: true });
});

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: key => { map.delete(key); },
  };
}

function installFakeSandNative(native) {
  globalThis.window = { SandNative: native };
}

test("main transport serves the desktop main-edge semantics with web backends", async () => {
  const { main } = await loadWebRuntime();
  installFakeSandNative({
    listSecrets: () => JSON.stringify(["openrouter"]),
    revealSecret: key => key === "openrouter" ? "sk-test" : null,
    upsertSecrets: () => {},
    removeSecrets: () => {},
    getPref: () => "",
    setPref: () => {},
    clearPref: () => {},
    hasGatewayToken: () => true,
    probeGateway: () => JSON.stringify({ ok: false, message: "Can't reach that URL." }),
  });
  const storage = memoryStorage();
  const events = [];
  const transport = main.createWebMainTransport({
    storage,
    gateway: { dispatchCommand: async (method, args) => ({ method, args, echo: true }) },
    events: { postEvent: (family, payload) => events.push({ family, payload }) },
  });
  const reply = (frame) => new Promise((resolve, reject) => {
    const unsubscribe = transport.subscribe((message) => {
      if (message.channel !== "main" || message.frame.kind !== "reply" || message.frame.requestId !== frame.frame.requestId) return;
      unsubscribe();
      if (message.frame.outcome.status === "ok") resolve(message.frame.outcome.value);
      else reject(new Error(`${message.frame.outcome.failure.code}: ${message.frame.outcome.failure.message}`));
    });
    transport.post(frame);
  });
  const request = (method, args = {}) => reply({
    channel: "main",
    frame: { kind: "request", requestId: `r-${method}-${Math.random().toString(16).slice(2)}`, method, args },
  });

  // Theme rides the shared main-edge handler with a web controller.
  assert.equal((await request("getThemeState")).preference, "system");
  assert.equal((await request("setThemePreference", { preference: "light" })).preference, "light");
  assert.equal((await request("getThemeState")).preference, "light");
  assert.ok(events.some(event => event.family === "theme-changed" && event.payload.preference === "light"));

  // Onboarding + local storage semantics match desktop defaults.
  assert.equal(await request("getOnboardingSeen"), false);
  await request("setOnboardingSeen", { seen: true });
  assert.equal(await request("getOnboardingSeen"), true);

  // Secrets ride the hand-wired fallback (Keystore via SandNative), like desktop IPC.
  assert.deepEqual(await request("listSecrets"), ["openrouter"]);
  assert.equal(await request("revealSecret", { key: "openrouter" }), "sk-test");

  // Connect validation: loopback box addresses are refused with the human hint.
  const refused = await request("setSelfHostConnection", { gatewayUrl: "http://127.0.0.1:1340", token: "tok" });
  assert.equal(refused.status, "saved");
  assert.match(refused.statusMessage, /192\.168\.1\.8:1340/);
  const good = await request("setSelfHostConnection", { gatewayUrl: "http://192.168.1.8:1340", token: "tok" });
  assert.equal(good.hasToken, true);

  // Desktop-only capabilities fail with the same failure codes as desktop.
  await assert.rejects(request("checkForUpdates"), /main\/update-unavailable/);
  // Window controls are gated in the bridge on Android; the transport itself no-ops.
  await request("minimizeWindow");
  transport.close();
});

test("coordinator transport serves the hello/ready protocol over the forwarder base and never leaks a token", async () => {
  const { coordinator } = await loadWebRuntime();
  const seenRequests = [];
  const streams = [];
  const server = (await import("node:http")).createServer((req, res) => {
    seenRequests.push({ url: req.url, method: req.method, authorization: req.headers.authorization ?? null, acceptEncoding: req.headers["accept-encoding"] ?? null });
    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(":ping\n\n");
      streams.push(res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/listAgents") {
      res.writeHead(200, { "content-type": "application/json", "x-sand-mint-dedupe": "1" });
      res.end(JSON.stringify([{ id: "agent-1" }]));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const coordinatorRuntime = coordinator.createWebCoordinator({ resolveBaseUrl: () => base });
    const coordinatorTransport = coordinatorRuntime.transport;
    const replies = [];
    const unsubscribe = coordinatorTransport.subscribe(message => replies.push(message));
    coordinatorTransport.post({
      channel: "coordinator",
      frame: { kind: "lifecycle", phase: "hello", protocolVersion: 1 },
    });
    const ready = replies.find(message => message.frame.kind === "lifecycle" && message.frame.phase === "ready");
    assert.ok(ready != null, "coordinator must answer hello with ready");

    const listAgents = await new Promise((resolve, reject) => {
      const requestId = "r-listAgents";
      const unsubscribeOnce = coordinatorTransport.subscribe((message) => {
        if (message.channel !== "coordinator" || message.frame.kind !== "reply" || message.frame.requestId !== requestId) return;
        unsubscribeOnce();
        if (message.frame.outcome.status === "ok") resolve(message.frame.outcome.value);
        else reject(new Error(message.frame.outcome.failure.message));
      });
      coordinatorTransport.post({ channel: "coordinator", frame: { kind: "request", requestId, method: "listAgents", args: {} } });
    });
    assert.deepEqual(listAgents, [{ id: "agent-1" }]);

    // The page connects tokenless: no Authorization header ever leaves it.
    const command = seenRequests.find(entry => entry.url === "/api/listAgents");
    assert.ok(command != null, "gateway command reached the base URL");
    assert.equal(command.authorization, null, "the page must never send a gateway token");
    const events = seenRequests.find(entry => entry.url === "/events");
    assert.ok(events != null, "the coordinator opened the SSE stream");
    assert.equal(events.authorization, null);
    assert.equal(events.acceptEncoding, "identity", "the SSE stream must request identity encoding");

    unsubscribe();
    coordinatorTransport.close();
  } finally {
    for (const stream of streams) stream.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

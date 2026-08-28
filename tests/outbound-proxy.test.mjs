import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
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

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("only Off or Custom URL; env and HTTP_PROXY do nothing", async () => {
  const mod = await loadTs("source/shared/outbound-proxy.ts");
  assert.deepEqual(mod.resolveOutboundProxy({}), { kind: "direct" });
  assert.deepEqual(mod.resolveOutboundProxy({ mode: "off", customUrl: "http://127.0.0.1:7890" }), { kind: "direct" });
  assert.deepEqual(mod.resolveOutboundProxy({ mode: "env", customUrl: "http://127.0.0.1:7890" }), { kind: "direct" });
  assert.deepEqual(mod.resolveOutboundProxy({ mode: "custom", customUrl: "" }), { kind: "direct" });
  const custom = mod.resolveOutboundProxy({ mode: "custom", customUrl: "http://10.0.0.1:7890" });
  assert.equal(custom.kind, "proxy");
  assert.equal(custom.httpProxy, "http://10.0.0.1:7890");
  assert.equal(mod.isSandOutboundProxyMode("env"), false);
});

test("127 and localhost are always loopback", async () => {
  const mod = await loadTs("source/shared/outbound-proxy.ts");
  assert.equal(mod.hostnameIsLoopback("127.0.0.1"), true);
  assert.equal(mod.hostnameIsLoopback("127.0.0.2"), true);
  assert.equal(mod.hostnameIsLoopback("localhost"), true);
  assert.equal(mod.hostnameIsLoopback("::1"), true);
  assert.equal(mod.hostnameIsLoopback("openrouter.ai"), false);
  assert.equal(mod.hostnameIsLoopback("192.0.2.1"), false);
});

test("custom proxy never intercepts 127, and curlProxyUrl skips loopback", async () => {
  const mod = await loadTs("source/shared/outbound-proxy.ts");
  const hits = [];
  const origin = http.createServer((req, res) => {
    hits.push(`origin:${req.url}`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  const proxy = http.createServer((req, res) => {
    hits.push(`proxy:${req.method}:${req.url}`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("proxied");
  });
  const originPort = await listen(origin);
  const proxyPort = await listen(proxy);
  const loopbackUrl = `http://127.0.0.1:${originPort}/local`;
  try {
    mod.applyOutboundProxyFromSettings({
      outboundProxyMode: "custom",
      outboundProxyUrl: `http://127.0.0.1:${proxyPort}`,
    });
    const loopback = await fetch(loopbackUrl);
    assert.equal(loopback.status, 200);
    assert.equal(await loopback.text(), "ok");
    assert.deepEqual(hits.filter((item) => item.startsWith("proxy:")), []);
    assert.equal(mod.curlProxyUrl(loopbackUrl), undefined);
    assert.equal(mod.curlProxyUrl("https://openrouter.ai/api/v1"), `http://127.0.0.1:${proxyPort}`);
    assert.equal(mod.curlProxyUrl(), undefined);

    const publicHit = await fetch("http://192.0.2.1/public");
    assert.equal(publicHit.status, 200);
    assert.equal(await publicHit.text(), "proxied");
    assert.ok(hits.some((item) => item.startsWith("proxy:GET:http://192.0.2.1/public")));

    mod.applyOutboundProxyFromSettings({ outboundProxyMode: "off" });
    const afterOff = await fetch(loopbackUrl);
    assert.equal(afterOff.status, 200);
    assert.equal(mod.curlProxyUrl("https://openrouter.ai/api/v1"), undefined);
  } finally {
    mod.applyOutboundProxyFromSettings({ outboundProxyMode: "off" });
    origin.close();
    proxy.close();
  }
});

test("https loopback stays direct even when Custom URL is set", { timeout: 15000 }, async () => {
  const mod = await loadTs("source/shared/outbound-proxy.ts");
  const dir = await mkdtemp(path.join(os.tmpdir(), "sand-op-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const hits = [];
  const origin = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (req, res) => {
    hits.push(`origin:${req.url}`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  const proxy = http.createServer();
  proxy.on("connect", (req, clientSocket) => {
    hits.push(`connect:${req.url}`);
    clientSocket.write("HTTP/1.1 500 No\r\n\r\n");
    clientSocket.destroy();
  });
  const originPort = await listen(origin);
  const proxyPort = await listen(proxy);
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const via = mod.createOutboundFetch(
      mod.resolveOutboundProxy({ mode: "custom", customUrl: `http://127.0.0.1:${proxyPort}` }),
    );
    const response = await Promise.race([
      via(`https://127.0.0.1:${originPort}/secure`),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout hits=${JSON.stringify(hits)}`)), 8000)),
    ]);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    const named = await Promise.race([
      via(`https://localhost:${originPort}/named`),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout named hits=${JSON.stringify(hits)}`)), 8000)),
    ]);
    assert.equal(named.status, 200);
    assert.equal(hits.filter((item) => String(item).startsWith("connect:")).length, 0);
    assert.ok(hits.includes("origin:/secure"));
    assert.ok(hits.includes("origin:/named"));
  } finally {
    if (previous == null) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    origin.close();
    proxy.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("source never reads or clears HTTP_PROXY", async () => {
  const proxy = await readFile(path.join(repoRoot, "source/shared/outbound-proxy.ts"), "utf8");
  const main = await readFile(path.join(repoRoot, "source/host/main.ts"), "utf8");
  assert.doesNotMatch(proxy, /HTTP_PROXY/);
  assert.doesNotMatch(proxy, /stripInheritedProxyEnv/);
  assert.doesNotMatch(main, /stripInheritedProxyEnv/);
  assert.doesNotMatch(main, /HTTP_PROXY/);
});

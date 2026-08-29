/**
 * Drive the packed Linux OpenBot through Chrome DevTools Protocol and actually
 * call window.desktop.stageAttachmentBytes the way the overlay wrapper does.
 * Prints one JSON object to stdout. Does not print tokens.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary = path.join(repoRoot, "dist/workbot-linux-x64/workbot");
const debugPort = Number(process.env.OPENBOT_ATTACH_PROBE_PORT ?? 19333);

function overlayEncodeSource() {
  return `
    function overlayEncode(e) {
      const u = e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes || []);
      let b = "";
      for (let i = 0; i < u.length; i += 32768) b += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
      return btoa(b);
    }
  `;
}

const pageScript = `
(async () => {
  ${overlayEncodeSource()}
  const out = {
    hasDesktop: typeof window.desktop !== "undefined",
    desktopType: typeof window.desktop,
    hasStage: false,
    encode: null,
    encodeError: null,
    overlayCall: null,
    overlayThrown: null,
    tinyCall: null,
    tinyThrown: null,
    hasTiny: false,
    twoArgTypedArray: null,
    twoArgThrown: null,
  };
  try {
    const bytes = new Uint8Array([104, 101, 108, 108, 111, 45, 102, 105, 108, 101]);
    out.encode = overlayEncode({ bytes });
  } catch (error) {
    out.encodeError = String(error && error.message ? error.message : error);
  }
  const desktop = window.desktop;
  if (desktop == null || typeof desktop.stageAttachmentBytes !== "function") {
    out.hasStage = false;
    return out;
  }
  out.hasStage = true;
  const bytes = new Uint8Array([104, 101, 108, 108, 111, 45, 102, 105, 108, 101]);
  try {
    const e = { filename: "probe-note.txt", bytes };
    out.overlayCall = await desktop.stageAttachmentBytes({
      filename: e.filename,
      bytesBase64: overlayEncode(e),
    });
  } catch (error) {
    out.overlayThrown = String(error && error.message ? error.message : error);
  }
  try {
    const e = { filename: "probe-note.txt", bytes };
    const stage = window.sandStageAttachment && window.sandStageAttachment.stage;
    out.hasTiny = typeof stage === "function";
    if (typeof stage === "function") {
      out.tinyCall = await stage({ filename: e.filename, bytesBase64: overlayEncode(e) });
    }
  } catch (error) {
    out.tinyThrown = String(error && error.message ? error.message : error);
  }
  try {
    out.twoArgTypedArray = await desktop.stageAttachmentBytes("probe-raw.txt", bytes);
  } catch (error) {
    out.twoArgThrown = String(error && error.message ? error.message : error);
  }
  return out;
})()
`;

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return await response.json();
}

async function waitForTargets(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no targets";
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      const page = targets.find((target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string");
      if (page != null) return page;
      lastError = `targets=${targets.map((t) => t.type).join(",") || "empty"}`;
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
    }
    await sleep(500);
  }
  throw new Error(`CDP not ready: ${lastError}`);
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed")));
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (waiter == null) return;
    pending.delete(message.id);
    if (message.error != null) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      ws.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      ws.close();
    },
  };
}

async function evaluate(client, expression, awaitPromise = true) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails != null) {
    const text = result.exceptionDetails.text ?? "evaluate threw";
    const value = result.exceptionDetails.exception?.description ?? text;
    throw new Error(value);
  }
  return result.result?.value;
}

async function waitForDesktop(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(client, `({ hasDesktop: typeof window.desktop !== "undefined", hasStage: typeof window.desktop?.stageAttachmentBytes === "function", href: location.href })`);
    if (last?.hasStage) return last;
    await sleep(500);
  }
  return last;
}

async function main() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "openbot-attach-probe-"));
  const userData = path.join(dataRoot, "electron-profile");
  const sandData = path.join(dataRoot, "sand");
  await writeFile(path.join(dataRoot, "probe-ready"), "1");
  const child = spawn("xvfb-run", [
    "-a",
    "-s",
    "-screen 0 1280x800x24",
    binary,
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userData}`,
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DISPLAY: "",
      SAND_USER_DATA_DIR: sandData,
      OPENBOT_USER_DATA_DIR: sandData,
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 80_000) stderr = stderr.slice(-40_000);
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    if (stdout.length > 40_000) stdout = stdout.slice(-20_000);
  });
  let client;
  try {
    const target = await waitForTargets(45_000);
    client = cdpClient(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send("Runtime.enable");
    const boot = await waitForDesktop(client, 45_000);
    const probe = boot?.hasStage ? await evaluate(client, pageScript) : { skipped: true, boot };
    const result = {
      ok: probe?.tinyCall?.ok === true || probe?.overlayCall?.ok === true,
      boot,
      probe,
      stderrTail: stderr.trim().slice(-4000),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: String(error && error.message ? error.message : error),
      stderrTail: stderr.trim().slice(-4000),
      stdoutTail: stdout.trim().slice(-1000),
    }, null, 2)}\n`);
    process.exitCode = 2;
  } finally {
    client?.close();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(3000),
    ]);
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
  }
}

await main();

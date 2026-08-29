import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { extractAll } = require("@electron/asar");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shellSrc = path.join(repoRoot, "dist/workbot-linux-x64");
const work = path.join(tmpdir(), `openbot-attach-diag-${Date.now()}`);
const debugPort = 19335;
const preloadDebug = path.join(work, "preload-debug.json");
const mainDebug = path.join(work, "main-debug.json");

function patchPreload(source) {
  const needle = "stageAttachmentBytes: (filename, bytes) => {";
  if (!source.includes(needle)) throw new Error("preload needle missing");
  const probe = `try{require("fs").writeFileSync(${JSON.stringify(preloadDebug)},JSON.stringify({filenameType:typeof filename,bytesUndef:bytes===void 0,filenameKeys:filename&&typeof filename==="object"?Object.keys(filename):null,innerFilename:filename&&filename.filename,hasB64:typeof (filename&&filename.bytesBase64)==="string",b64len:typeof (filename&&filename.bytesBase64)==="string"?filename.bytesBase64.length:null}));}catch(e){}`;
  return source.replace(needle, `${needle}\n      ${probe}`);
}

function patchMain(source) {
  const needle = "async stageBytes(filename, bytes) {";
  if (!source.includes(needle)) throw new Error("main needle missing");
  const probe = `try{const fs=require("fs");const args0=resolveStageAttachmentArgs(filename,bytes);const payload0=coerceAttachmentBytes(args0.bytes);fs.writeFileSync(${JSON.stringify(mainDebug)},JSON.stringify({filenameType:typeof filename,bytesUndef:bytes===void 0,rawKeys:filename&&typeof filename==="object"?Object.keys(filename):null,argsFilename:args0.filename,argsBytesType:typeof args0.bytes,payloadNull:payload0==null,payloadLen:payload0&&payload0.byteLength,staging:typeof deps2.getStagingDir==="function"?deps2.getStagingDir():null}));}catch(e){try{require("fs").writeFileSync(${JSON.stringify(mainDebug)},JSON.stringify({patchError:String(e)}));}catch{}}`;
  return source.replace(needle, `${needle}\n      ${probe}`);
}

async function waitForTargets(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "no targets";
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
      last = `targets=${targets.map((t) => t.type).join(",") || "empty"}`;
    } catch (error) {
      last = String(error && error.message ? error.message : error);
    }
    await sleep(400);
  }
  throw new Error(`CDP not ready: ${last}`);
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("cdp ws failed")));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      ws.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() { ws.close(); },
  };
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}

async function main() {
  await mkdir(path.join(work, "resources", "app"), { recursive: true });
  await cp(path.join(shellSrc, "workbot"), path.join(work, "workbot"));
  const skip = new Set(["workbot", "resources"]);
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir(shellSrc)) {
    if (skip.has(name)) continue;
    await symlink(path.join(shellSrc, name), path.join(work, name));
  }
  await symlink(path.join(shellSrc, "resources", "app.asar.unpacked"), path.join(work, "resources", "app.asar.unpacked"));
  extractAll(path.join(shellSrc, "resources", "app.asar"), path.join(work, "resources", "app"));
  const preloadPath = path.join(work, "resources", "app", "dist", "electron-preload", "preload.cjs");
  const mainPath = path.join(work, "resources", "app", "dist", "electron-main", "main.cjs");
  await writeFile(preloadPath, patchPreload(await readFile(preloadPath, "utf8")));
  await writeFile(mainPath, patchMain(await readFile(mainPath, "utf8")));

  const sandData = path.join(work, "sand");
  const userData = path.join(work, "electron-profile");
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 1280x800x24", path.join(work, "workbot"), `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`, "--no-sandbox", "--disable-gpu"], {
    env: { ...process.env, SAND_USER_DATA_DIR: sandData, OPENBOT_USER_DATA_DIR: sandData, ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
  child.stdout.on("data", (c) => { stderr += c.toString("utf8"); });
  let client;
  try {
    const target = await waitForTargets(45_000);
    client = cdp(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send("Runtime.enable");
    const deadline = Date.now() + 45_000;
    let boot = null;
    while (Date.now() < deadline) {
      boot = await evaluate(client, `({hasStage: typeof window.desktop?.stageAttachmentBytes==="function", href: location.href})`);
      if (boot?.hasStage) break;
      await sleep(400);
    }
    const probe = await evaluate(client, `(async()=>{
      const bytes=new Uint8Array([104,101,108,108,111,45,102,105,108,101]);
      let b=""; for(let i=0;i<bytes.length;i+=32768) b+=String.fromCharCode.apply(null,bytes.subarray(i,i+32768));
      const bytesBase64=btoa(b);
      const overlayCall=await window.desktop.stageAttachmentBytes({filename:"probe-note.txt",bytesBase64});
      return {overlayCall, bytesBase64};
    })()`);
    await sleep(500);
    let preloadSaw = null;
    let mainSaw = null;
    try { preloadSaw = JSON.parse(await readFile(preloadDebug, "utf8")); } catch {}
    try { mainSaw = JSON.parse(await readFile(mainDebug, "utf8")); } catch {}
    const out = { boot, probe, preloadSaw, mainSaw, stderrTail: stderr.trim().slice(-2000) };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exitCode = probe?.overlayCall?.ok === true ? 0 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error && error.message ? error.message : error), stderrTail: stderr.trim().slice(-3000) }, null, 2)}\n`);
    process.exitCode = 2;
  } finally {
    client?.close();
    child.kill("SIGTERM");
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(4000)]);
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

await main();

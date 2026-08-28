import { spawn } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shellSrc = path.join(repoRoot, "dist/openbot-linux-x64");
const work = path.join(tmpdir(), `openbot-attach-e2e-${Date.now()}`);

const mainJs = `
const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { coerceAttachmentBytes, resolveStageAttachmentArgs, normalizeAttachmentFilename } = require("./attachments.cjs");

app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");

const resultPath = process.env.OPENBOT_ATTACH_E2E_RESULT;
const stagingDir = process.env.OPENBOT_ATTACH_E2E_STAGING;

function jsonType(value) {
  if (value == null) return String(value);
  if (typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return "array";
  if (ArrayBuffer.isView(value)) return value.constructor.name;
  return "object keys=" + Object.keys(value).join(",");
}

ipcMain.handle("report-result", async (_event, payload) => {
  await writeFile(resultPath, JSON.stringify(payload));
  app.quit();
  return true;
});

ipcMain.handle("stage-debug", async (_event, raw) => {
  const received = {
    rawType: jsonType(raw),
    filename: raw && raw.filename,
    hasBytes: raw != null && raw.bytes != null,
    hasBytesBase64: raw != null && typeof raw.bytesBase64 === "string",
    bytesBase64Length: raw && typeof raw.bytesBase64 === "string" ? raw.bytesBase64.length : null,
  };
  const args = resolveStageAttachmentArgs(raw);
  const payload = coerceAttachmentBytes(args.bytes);
  const checks = {
    filename: args.filename,
    safe: normalizeAttachmentFilename(args.filename) != null,
    payloadNull: payload == null,
    payloadLength: payload == null ? null : payload.byteLength,
  };
  try {
    await mkdir(stagingDir, { recursive: true });
    const filePath = join(stagingDir, "probe-note.txt");
    if (payload != null) await writeFile(filePath, Buffer.from(payload));
    return { ok: payload != null && normalizeAttachmentFilename(args.filename) != null, received, checks, path: filePath, safeName: normalizeAttachmentFilename(args.filename) };
  } catch (error) {
    return { ok: false, received, checks, writeError: String(error && error.stack || error) };
  }
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: require("node:path").join(__dirname, "preload.cjs"),
    },
  });
  await window.loadFile(require("node:path").join(__dirname, "renderer.html"));
});
`;


const preloadJs = `
const { contextBridge, ipcRenderer } = require("electron");
const { coerceAttachmentBytes, resolveStageAttachmentArgs, encodeAttachmentBytesBase64 } = require("./attachments.cjs");

contextBridge.exposeInMainWorld("desktop", {
  reportResult: (payload) => ipcRenderer.invoke("report-result", payload),
  stageAttachmentBytes: (filename, bytes) => {
    const args = resolveStageAttachmentArgs(filename, bytes);
    const payload = coerceAttachmentBytes(args.bytes);
    const preloadSaw = {
      filenameType: typeof filename,
      bytesType: bytes === undefined ? "undefined" : Object.prototype.toString.call(bytes),
      argsFilename: args.filename,
      payloadNull: payload == null,
      payloadLength: payload == null ? null : payload.byteLength,
    };
    if (payload == null) {
      return ipcRenderer.invoke("stage-debug", { filename: args.filename, bytes: args.bytes, preloadSaw });
    }
    return ipcRenderer.invoke("stage-debug", {
      filename: args.filename,
      bytesBase64: encodeAttachmentBytesBase64(payload),
      preloadSaw,
    });
  },
});
`;

const rendererHtml = `<!doctype html>
<meta charset="utf-8">
<script>
function overlayEncode(e) {
  const u = e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes || []);
  let b = "";
  for (let i = 0; i < u.length; i += 32768) b += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
  return btoa(b);
}
(async () => {
  const out = { encode: null, encodeError: null, overlay: null, overlayThrown: null, windowsPath: null, twoArg: null, twoArgThrown: null, desktopKeys: window.desktop ? Object.keys(window.desktop) : null };
  try {
  const bytes = new Uint8Array([104,101,108,108,111,45,102,105,108,101]);
  try { out.encode = overlayEncode({ bytes }); }
  catch (error) { out.encodeError = String(error && error.message || error); }
  try {
    const e = { filename: "probe-note.txt", bytes };
    out.overlay = await window.desktop.stageAttachmentBytes({ filename: e.filename, bytesBase64: overlayEncode(e) });
    out.windowsPath = await window.desktop.stageAttachmentBytes({ filename: "C:\\\\Users\\\\nat\\\\photo.png", bytesBase64: overlayEncode(e) }, {});
  } catch (error) { out.overlayThrown = String(error && error.message || error); }
  try {
    out.twoArg = await window.desktop.stageAttachmentBytes("probe-raw.txt", bytes);
  } catch (error) { out.twoArgThrown = String(error && error.message || error); }
  } catch (error) {
    out.scriptError = String(error && error.message || error);
  }
  await window.desktop.reportResult(out);
})();
</script>
`;

async function waitForResultFile(filePath, timeoutMs) {
  const { readFile, access } = await import("node:fs/promises");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      await sleep(200);
    }
  }
  throw new Error("e2e result timeout");
}

async function main() {
  await rm(work, { recursive: true, force: true });
  await mkdir(path.join(work, "resources", "app"), { recursive: true });
  const binary = path.join(work, "openbot");
  await cp(path.join(shellSrc, "openbot"), binary);
  const skip = new Set(["openbot", "resources"]);
  const { readdir, symlink } = await import("node:fs/promises");
  for (const name of await readdir(shellSrc)) {
    if (skip.has(name)) continue;
    await symlink(path.join(shellSrc, name), path.join(work, name));
  }
  const appDir = path.join(work, "resources", "app");
  await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ["source/shared/media/attachment-bytes.ts"],
    format: "cjs",
    platform: "node",
    outfile: path.join(appDir, "attachments.cjs"),
  });
  await writeFile(path.join(appDir, "package.json"), JSON.stringify({ name: "attach-e2e", main: "main.cjs" }));
  await writeFile(path.join(appDir, "main.cjs"), mainJs);
  await writeFile(path.join(appDir, "preload.cjs"), preloadJs);
  await writeFile(path.join(appDir, "renderer.html"), rendererHtml);

  const stagingDir = path.join(work, "staging");
  const resultPath = path.join(work, "result.json");
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 800x600x24", binary, "--no-sandbox", "--disable-gpu"], {
    env: {
      ...process.env,
      OPENBOT_ATTACH_E2E_STAGING: stagingDir,
      OPENBOT_ATTACH_E2E_RESULT: resultPath,
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
  child.stdout.on("data", (c) => { stderr += c.toString("utf8"); });
  try {
    const result = await waitForResultFile(resultPath, 60_000);
    process.stdout.write(`${JSON.stringify({ result, stderrTail: stderr.slice(-2000) }, null, 2)}\n`);
    process.exitCode = result?.overlay?.ok === true && result?.windowsPath?.ok === true ? 0 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error), stderrTail: stderr.slice(-3000) }, null, 2)}\n`);
    process.exitCode = 2;
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(4000)]);
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

await main();

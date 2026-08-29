import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const master = path.join(repoRoot, "branding/openbot-icon.png");
const android = path.join(repoRoot, "targets/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png");

function pngSize(buf) {
  assert.equal(buf.subarray(0, 8).toString("binary"), "\x89PNG\r\n\x1a\n");
  assert.equal(buf.subarray(12, 16).toString("binary"), "IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("branding icon is a square PNG with white canvas removed", () => {
  const buf = readFileSync(master);
  const { width, height } = pngSize(buf);
  assert.equal(width, 1024);
  assert.equal(height, 1024);
  assert.equal(buf.includes("JFIF"), false);
});

test("android launcher is the same mark at 256", () => {
  const { width, height } = pngSize(readFileSync(android));
  assert.equal(width, 256);
  assert.equal(height, 256);
});

test("packer stamps branding icon into the shell binary, not only beside asar", async () => {
  const embed = await readFile(path.join(repoRoot, "scripts/lib/embed-app-icon.mjs"), "utf8");
  assert.match(embed, /embedWindowsExeIcon/);
  assert.match(embed, /installShellAppIcon/);
  const shell = await readFile(path.join(repoRoot, "scripts/lib/electron-official-shell.mjs"), "utf8");
  assert.match(shell, /installShellAppIcon/);
  const main = await readFile(path.join(repoRoot, "source/electron-main/main.ts"), "utf8");
  assert.match(main, /const icon = deps\.devAppIcon;/);
  assert.equal(main.includes("isPackaged ? undefined : deps.devAppIcon"), false);
  const resources = await readFile(path.join(repoRoot, "source/electron-main/main-production-services.ts"), "utf8");
  assert.match(resources, /SAND_DEV_APP_ICON/);
  assert.match(resources, /icon\.png/);
});

function icoPngMarker() {
  const ico = readFileSync(path.join(repoRoot, "branding/openbot-icon.ico"));
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let last = -1;
  for (let i = 0; i < ico.length;) {
    const next = ico.indexOf(sig, i);
    if (next < 0) break;
    last = next;
    i = next + 1;
  }
  assert.notEqual(last, -1);
  return ico.subarray(last, last + 64);
}

test("packed linux shell uses branding icon next to the binary, not only beside asar", () => {
  const linuxRoot = path.join(repoRoot, "dist/workbot-linux-x64");
  const besideBinary = path.join(linuxRoot, "icon.png");
  const besideAsar = path.join(linuxRoot, "resources/icon.png");
  assert.equal(existsSync(besideBinary), true, "packed linux binary-dir icon missing; run pack:all");
  assert.equal(existsSync(besideAsar), true, "packed linux resources/icon.png missing; run pack:all");
  const { width, height } = pngSize(readFileSync(besideBinary));
  assert.equal(width, 1024);
  assert.equal(height, 1024);
  assert.equal(readFileSync(besideBinary).equals(readFileSync(besideAsar)), true);
});

test("packed windows exe embeds branding ico instead of stock Electron", () => {
  const exe = path.join(repoRoot, "dist/workbot-win32-x64/workbot.exe");
  assert.equal(existsSync(exe), true, "packed windows exe missing; run pack:all");
  const bytes = readFileSync(exe);
  const marker = icoPngMarker();
  assert.equal(bytes.includes(marker), true, "workbot.exe still has the default Electron icon");
});

test("embedWindowsExeIcon writes branding ico into a PE copy", async () => {
  const { mkdtemp, copyFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { embedWindowsExeIcon } = await import(pathToFileURL(path.join(repoRoot, "scripts/lib/embed-app-icon.mjs")).href);
  const src = path.join(repoRoot, "dist/workbot-win32-x64/workbot.exe");
  assert.equal(existsSync(src), true, "need a packed windows exe to copy");
  const dir = await mkdtemp(path.join(tmpdir(), "workbot-ico-"));
  const copy = path.join(dir, "workbot.exe");
  try {
    await copyFile(src, copy);
    const marker = icoPngMarker();
    const before = readFileSync(copy).includes(marker);
    await embedWindowsExeIcon(copy, path.join(repoRoot, "branding/openbot-icon.ico"));
    const after = readFileSync(copy).includes(marker);
    assert.equal(after, true);
    if (before) return;
    assert.equal(before, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

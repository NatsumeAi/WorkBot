import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const packedLinuxAsar = path.join(repoRoot, "dist/workbot-linux-x64/resources/app.asar");
export const packedWindowsAsar = path.join(repoRoot, "dist/workbot-win32-x64/resources/app.asar");
export const packedWindowsExe = path.join(repoRoot, "dist/workbot-win32-x64/workbot.exe");
export const packedLinuxRoot = path.join(repoRoot, "dist/workbot-linux-x64");
export const packedAndroidApk = path.join(repoRoot, "dist/workbot-android.apk");

export const asarSyncLinuxHost = "/tmp/openbot-asar-sync/linux/dist/host/host-main.cjs";
export const asarSyncLinuxMain = "/tmp/openbot-asar-sync/linux/dist/electron-main/main.cjs";
export const asarSyncLinuxUbx = "/tmp/openbot-asar-sync/linux/dist/renderer/assets/index-UbX-y3il.js";
export const asarSyncLinuxPanel = "/tmp/openbot-asar-sync/linux/dist/renderer/assets/index-BlqerJhg.js";
export const asarSyncWinMain = "/tmp/openbot-asar-sync/win-full/dist/electron-main/main.cjs";

export function skipUnlessExists(t, file, reason) {
  if (existsSync(file)) return false;
  t.skip(reason);
  return true;
}

export function skipUnlessAllExist(t, files, reason) {
  if (files.every((file) => existsSync(file))) return false;
  t.skip(reason);
  return true;
}

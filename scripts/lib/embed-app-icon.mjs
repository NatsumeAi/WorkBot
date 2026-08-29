import { readFile, writeFile, cp, access } from "node:fs/promises";
import path from "node:path";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";
import { repoRoot } from "./config.mjs";

export const BRANDING_ICON_PNG = path.join(repoRoot, "branding", "openbot-icon.png");
export const BRANDING_ICON_ICO = path.join(repoRoot, "branding", "openbot-icon.ico");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Stamp the branding ICO into a Windows PE (Electron.exe / openbot.exe). No wine. */
export async function embedWindowsExeIcon(exePath, icoPath = BRANDING_ICON_ICO) {
  if (typeof exePath !== "string" || exePath.length === 0) throw new TypeError("exePath is required");
  const exeData = await readFile(exePath);
  const icoData = await readFile(icoPath);
  let exe;
  try {
    exe = NtExecutable.from(exeData);
  } catch {
    exe = NtExecutable.from(exeData, { ignoreCert: true });
  }
  const res = NtExecutableResource.from(exe);
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length < 1) throw new Error(`No icon group in ${exePath}`);
  const iconFile = Data.IconFile.from(icoData);
  const images = iconFile.icons.map((item) => item.data);
  if (images.length < 1) throw new Error(`No icons in ${icoPath}`);
  for (const group of groups) {
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, images);
  }
  res.outputResource(exe);
  await writeFile(exePath, Buffer.from(exe.generate()));
}

/**
 * Put the branding mark where the shell actually shows an icon:
 * next to the binary (Linux file/taskbar fallback), resources/icon.png
 * (BrowserWindow), and inside the Windows exe (Explorer/taskbar).
 */
export async function installShellAppIcon({ shellRoot, binaryName }) {
  if (!(await exists(BRANDING_ICON_PNG))) throw new Error("branding/openbot-icon.png is missing");
  const resources = path.join(shellRoot, "resources");
  await cp(BRANDING_ICON_PNG, path.join(resources, "icon.png"));
  await cp(BRANDING_ICON_PNG, path.join(shellRoot, "icon.png"));
  if (await exists(BRANDING_ICON_ICO)) {
    await cp(BRANDING_ICON_ICO, path.join(resources, "icon.ico"));
    const exe = path.join(shellRoot, binaryName);
    if (binaryName.endsWith(".exe") && await exists(exe)) {
      await embedWindowsExeIcon(exe, BRANDING_ICON_ICO);
    }
  }
}

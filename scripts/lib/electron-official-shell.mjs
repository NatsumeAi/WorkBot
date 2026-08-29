import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { access, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { downloadArtifact } from "@electron/get";
import { packedLinuxBinary, packedWindowsBinary, repoRoot } from "./config.mjs";
import { run } from "./process.mjs";

export const ELECTRON_SHELL_VERSION = "42.1.0";
export const ELECTRON_LINUX_X64_ZIP_SHA256 = "882047343a9e203c6cfc5d39b166ea9e025dd256943e0d3711f86725ad0e3bd9";
export const ELECTRON_WIN32_X64_ZIP_SHA256 = "0b03582d0a68dce8473fcc090114dabef7eaafd52b6d8cd2c85b000358c6af31";

const LINUX_BINARY = "electron";
const WINDOWS_BINARY = "electron.exe";
const DEFAULT_APP = path.join("resources", "default_app.asar");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

function checksumsFromElectronPackage() {
  return JSON.parse(readFileSync(path.join(repoRoot, "node_modules", "electron", "checksums.json"), "utf8"));
}

function expectedZipSha256(platform) {
  if (platform === "linux") return ELECTRON_LINUX_X64_ZIP_SHA256;
  if (platform === "win32") return ELECTRON_WIN32_X64_ZIP_SHA256;
  throw new Error(`No pinned Electron ${ELECTRON_SHELL_VERSION} zip checksum for ${platform}.`);
}

function expectedBinaryName(platform) {
  if (platform === "linux") return LINUX_BINARY;
  if (platform === "win32") return WINDOWS_BINARY;
  throw new Error(`No Electron binary name for ${platform}.`);
}

export async function downloadOfficialElectronZip(platform, arch = "x64") {
  const expected = expectedZipSha256(platform);
  const zipPath = await downloadArtifact({
    version: ELECTRON_SHELL_VERSION,
    artifactName: "electron",
    platform,
    arch,
    checksums: checksumsFromElectronPackage(),
  });
  const digest = await sha256File(zipPath);
  if (digest !== expected) {
    throw new Error(`Electron ${ELECTRON_SHELL_VERSION} ${platform}-${arch} zip checksum mismatch: expected ${expected}, got ${digest}`);
  }
  return zipPath;
}

async function assertExtractedElectronShell(extractedRoot, platform) {
  const listing = await readdir(extractedRoot);
  const binaryName = expectedBinaryName(platform);
  if (!listing.includes(binaryName)) {
    throw new Error(`Extracted Electron zip is missing ${binaryName}. Found: ${listing.join(", ")}`);
  }
  if (!(await stat(path.join(extractedRoot, binaryName))).isFile()) {
    throw new Error(`Extracted Electron zip ${binaryName} is not a file.`);
  }
  const defaultApp = path.join(extractedRoot, DEFAULT_APP);
  if (!(await exists(defaultApp)) || !(await stat(defaultApp)).isFile()) {
    throw new Error(`Extracted Electron zip is missing ${DEFAULT_APP}.`);
  }
  return { binaryName, listing };
}

async function extractOfficialZip(zipPath, destination) {
  // extract-zip/yauzl aborts on Node 26 (process exit 13). 7z extracted the
  // pinned Electron 42.1.0 zips on this machine.
  await run("7z", ["x", "-y", `-o${destination}`, zipPath]);
}

export async function stageOfficialElectronShell({ platform, arch = "x64", destination }) {
  const zipPath = await downloadOfficialElectronZip(platform, arch);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await extractOfficialZip(zipPath, destination);
  const inspected = await assertExtractedElectronShell(destination, platform);
  return { zipPath, ...inspected };
}

export async function installReconstructedAsar({ shellRoot, builtAsar, builtAsarUnpacked, docsPath, binaryName }) {
  const resources = path.join(shellRoot, "resources");
  const packagedAsar = path.join(resources, "app.asar");
  const packagedUnpacked = `${packagedAsar}.unpacked`;
  await rm(path.join(resources, "default_app.asar"), { force: true });
  await rm(packagedAsar, { force: true });
  await rm(packagedUnpacked, { recursive: true, force: true });
  await cp(builtAsar, packagedAsar);
  await cp(builtAsarUnpacked, packagedUnpacked, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  if (docsPath != null) {
    const docsDir = path.join(resources, "docs");
    await mkdir(docsDir, { recursive: true });
    await cp(docsPath, path.join(docsDir, path.basename(docsPath)));
  }
  const renamed = platformBinaryName(binaryName);
  if (renamed !== binaryName) {
    await rm(path.join(shellRoot, renamed), { force: true });
    await cp(path.join(shellRoot, binaryName), path.join(shellRoot, renamed));
    await rm(path.join(shellRoot, binaryName));
  }
  const { installShellAppIcon } = await import("./embed-app-icon.mjs");
  await installShellAppIcon({ shellRoot, binaryName: renamed });
  return { packagedAsar, packagedUnpacked, binaryName: renamed };
}

function platformBinaryName(extractedBinary) {
  if (extractedBinary === LINUX_BINARY) return packedLinuxBinary;
  if (extractedBinary === WINDOWS_BINARY) return packedWindowsBinary;
  return extractedBinary;
}

import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFidelityReconstructedAsar } from "../clean-build.mjs";
import { signAppBundleAdHoc } from "./codesign.mjs";
import {
  outputApp,
  outputDir,
  packedLinuxFolder,
  packedWindowsFolder,
  reconstructedBundleId,
  reconstructedName,
  repoRoot,
} from "./config.mjs";
import { installReconstructedAsar, stageOfficialElectronShell } from "./electron-official-shell.mjs";
import { verifyOfficialMacReference, verifyReconstructedMacPackage } from "./macos-package-verification.mjs";
import { run } from "./process.mjs";
import { SYSTEM_TOOLS } from "./system-tools.mjs";

/**
 * One desktop packer. Linux / Windows / macOS all call buildFidelityReconstructedAsar
 * (same asar payload: pinned 0.18 renderer + Windows overlay). Only the shell wrap differs.
 */
const ELECTRON_DESKTOP = {
  "linux-x64": { kind: "zip-shell", platform: "linux", arch: "x64", folder: packedLinuxFolder },
  "windows-x64": { kind: "zip-shell", platform: "win32", arch: "x64", folder: packedWindowsFolder },
  "macos-arm64": { kind: "macos-app" },
};

function nativeModulesNote() {
  if (process.env.ELECTRON_HEADERS_DIR) {
    console.log(`ELECTRON_HEADERS_DIR is set; rebuild native modules with scripts/build-tree-sitter-electron.mjs before relying on tree-sitter.`);
  } else {
    console.log("Native modules were not rebuilt for this desktop shell. Set ELECTRON_HEADERS_DIR and rebuild tree-sitter for this binary.");
  }
}

async function installZipShell(spec, { builtAsar, builtAsarUnpacked }) {
  const destination = path.join(outputDir, spec.folder);
  await mkdir(outputDir, { recursive: true });
  await rm(destination, { recursive: true, force: true });
  const staged = await stageOfficialElectronShell({ platform: spec.platform, arch: spec.arch, destination });
  const installed = await installReconstructedAsar({
    shellRoot: destination,
    builtAsar,
    builtAsarUnpacked,
    docsPath: path.join(repoRoot, "docs", "self-host.md"),
    binaryName: staged.binaryName,
  });
  nativeModulesNote();
  const archive = await archiveDesktopFolder(spec.folder);
  console.log(`Packaged application: ${destination} (${installed.binaryName})`);
  console.log(`Packaged archive: ${archive}`);
  return { destination, binaryName: installed.binaryName, archive };
}

async function archiveDesktopFolder(folder) {
  const archive = path.join(outputDir, `${folder}.zip`);
  await rm(archive, { force: true });
  await run("7z", ["a", "-tzip", "-mx=1", "-bso0", "-bsp0", path.basename(archive), folder], { cwd: outputDir });
  return archive;
}

async function packageMacosDesktop() {
  if (process.platform !== "darwin") {
    throw new Error("The reconstructed macOS application can only be packaged on macOS.");
  }
  // Same asar as Linux/Windows: buildFidelity installs the Windows overlay and
  // writes dist/renderer-router-extension.json so checksum-pinned verification still passes.
  const { builtAsar, builtAsarUnpacked, runtimeApp } = await buildFidelityReconstructedAsar();
  // Keep the signed release audit separate from the reconstructed package audit:
  // the official app is reference-only and is never used as the runtime payload.
  await verifyOfficialMacReference({ runtimeApp });
  await mkdir(outputDir, { recursive: true });
  await rm(outputApp, { recursive: true, force: true });
  await run(SYSTEM_TOOLS.ditto, [runtimeApp, outputApp]);
  // The source DMG's quarantine/provenance applies to Anysphere's signed artifact,
  // not to this differently identified local reconstruction. Leaving it attached
  // makes Gatekeeper reject the otherwise valid ad-hoc signature before launch.
  await run(SYSTEM_TOOLS.xattr, ["-cr", outputApp]);

  const resources = path.join(outputApp, "Contents", "Resources");
  const packagedAsar = path.join(resources, "app.asar");
  const packagedUnpacked = `${packagedAsar}.unpacked`;
  await rm(packagedAsar, { force: true });
  await rm(packagedUnpacked, { recursive: true, force: true });
  await cp(builtAsar, packagedAsar);
  await cp(builtAsarUnpacked, packagedUnpacked, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  await mkdir(path.join(resources, "docs"), { recursive: true });
  await cp(path.join(repoRoot, "docs", "self-host.md"), path.join(resources, "docs", "self-host.md"));

  const infoPlist = path.join(outputApp, "Contents", "Info.plist");
  await run(SYSTEM_TOOLS.plutil, ["-remove", "ElectronAsarIntegrity", infoPlist]);
  await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleIdentifier", "-string", reconstructedBundleId, infoPlist]);
  await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleDisplayName", "-string", reconstructedName, infoPlist]);
  // The backend currently emits only the `sand` auth/deep-link target. Make the
  // reconstructed bundle's claim explicit and remove inherited aliases such as
  // `grokbot`; the original bundle remains untouched and remains reference-only.
  await run(SYSTEM_TOOLS.plutil, ["-remove", "CFBundleURLTypes", infoPlist]);
  await run(SYSTEM_TOOLS.plutil, ["-insert", "CFBundleURLTypes", "-xml", "<array><dict><key>CFBundleTypeRole</key><string>Viewer</string><key>CFBundleURLName</key><string>Grok Bot reconstructed auth callback</string><key>CFBundleURLSchemes</key><array><string>sand</string></array></dict></array>", infoPlist]);
  // Keep CFBundleName/CFBundleExecutable as "Grok Bot": Electron derives the
  // expected nested helper names from it, and this build intentionally reuses the
  // exact ABI-matched 0.18 runtime. CFBundleDisplayName provides the fork's name.

  await rm(path.join(outputApp, "Contents", "_CodeSignature"), { recursive: true, force: true });
  try {
    await signAppBundleAdHoc(outputApp);
  } catch (error) {
    // macOS can transiently deny replacement of a nested framework signature
    // immediately after the copied runtime was in use. A second idempotent pass
    // succeeds once the kernel releases that code object.
    console.warn(`Initial ad-hoc signing pass failed; retrying once: ${String(error)}`);
    await signAppBundleAdHoc(outputApp);
  }
  await run(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", outputApp]);
  const verification = await verifyReconstructedMacPackage({
    officialApp: runtimeApp,
    reconstructedApp: outputApp,
    sourceUnpackedRoot: builtAsarUnpacked,
    packagedUnpackedRoot: packagedUnpacked,
  });

  console.log(`Packaged application: ${outputApp} (${verification.runtime.nodeFileCount} native manifest entries, ${verification.runtime.runtimeFileCount} unpacked runtime files)`);
  return { destination: outputApp, verification };
}

export async function packageElectronDesktops(targetIds) {
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    throw new Error("packageElectronDesktops requires at least one target id");
  }
  const zipSpecs = [];
  let includeMacos = false;
  for (const targetId of targetIds) {
    const spec = ELECTRON_DESKTOP[targetId];
    if (spec == null) throw new Error(`Not an Electron desktop pack target: ${targetId}`);
    if (spec.kind === "macos-app") includeMacos = true;
    else zipSpecs.push(spec);
  }
  const results = [];
  if (zipSpecs.length > 0) {
    const asar = await buildFidelityReconstructedAsar({ copyRuntimeNatives: false });
    for (const spec of zipSpecs) results.push(await installZipShell(spec, asar));
    for (const leftover of ["openbot-linux-x64", "openbot-win32-x64"]) {
      await rm(path.join(outputDir, leftover), { recursive: true, force: true });
      await rm(path.join(outputDir, `${leftover}.zip`), { force: true });
    }
  }
  if (includeMacos) results.push(await packageMacosDesktop());
  return results;
}

export async function packageElectronDesktop(targetId) {
  const packed = await packageElectronDesktops([targetId]);
  return packed[0];
}

const invokedDirectly = process.argv[1] != null
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    throw new Error("Usage: node scripts/lib/package-electron.mjs <linux-x64|windows-x64|macos-arm64>...");
  }
  await packageElectronDesktops(ids);
}

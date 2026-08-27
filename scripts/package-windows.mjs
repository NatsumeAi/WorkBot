import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { outputDir, repoRoot } from "./lib/config.mjs";
import { installReconstructedAsar, stageOfficialElectronShell } from "./lib/electron-official-shell.mjs";

const destination = path.join(outputDir, "openbot-win32-x64");
const { builtAsar, builtAsarUnpacked } = await buildFidelityReconstructedAsar({ copyRuntimeNatives: false });
await mkdir(outputDir, { recursive: true });
await rm(destination, { recursive: true, force: true });
const staged = await stageOfficialElectronShell({ platform: "win32", arch: "x64", destination });
const installed = await installReconstructedAsar({
  shellRoot: destination,
  builtAsar,
  builtAsarUnpacked,
  docsPath: path.join(repoRoot, "docs", "self-host.md"),
  binaryName: staged.binaryName,
});
console.log("Native modules were not rebuilt for Windows. Set ELECTRON_HEADERS_DIR on Windows and rebuild tree-sitter for this binary.");
console.log(`Packaged application: ${destination} (${installed.binaryName})`);

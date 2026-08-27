import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { outputDir, repoRoot } from "./lib/config.mjs";
import { installReconstructedAsar, stageOfficialElectronShell } from "./lib/electron-official-shell.mjs";

const destination = path.join(outputDir, "openbot-linux-x64");
const { builtAsar, builtAsarUnpacked } = await buildFidelityReconstructedAsar({ copyRuntimeNatives: false });
await mkdir(outputDir, { recursive: true });
await rm(destination, { recursive: true, force: true });
const staged = await stageOfficialElectronShell({ platform: "linux", arch: "x64", destination });
const installed = await installReconstructedAsar({
  shellRoot: destination,
  builtAsar,
  builtAsarUnpacked,
  docsPath: path.join(repoRoot, "docs", "self-host.md"),
  binaryName: staged.binaryName,
});
if (process.env.ELECTRON_HEADERS_DIR) {
  console.log(`ELECTRON_HEADERS_DIR is set; rebuild native modules with scripts/build-tree-sitter-electron.mjs before relying on tree-sitter.`);
} else {
  console.log("Native Darwin modules were not copied. Set ELECTRON_HEADERS_DIR and rebuild tree-sitter for this Linux binary.");
}
console.log(`Packaged application: ${destination} (${installed.binaryName})`);

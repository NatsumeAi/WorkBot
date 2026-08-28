import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { outputDir, repoRoot } from "./lib/config.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultTargets = process.platform === "darwin"
  ? ["linux-x64", "windows-x64", "macos-arm64", "android"]
  : ["linux-x64", "windows-x64", "android"];

function parseTargets() {
  const configured = process.env.GROK_BOT_PACK_TARGETS?.trim();
  if (configured == null || configured.length === 0) return defaultTargets;
  const targets = configured.split(",").map(entry => entry.trim()).filter(Boolean);
  const known = new Set(defaultTargets);
  for (const target of targets) {
    if (!known.has(target)) throw new Error(`Unknown GROK_BOT_PACK_TARGETS entry: ${target} (known: ${[...known].join(", ")})`);
  }
  return targets;
}

async function runStep(command, args, { env } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: env ?? process.env,
    });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`)));
    child.on("error", reject);
  });
}

const targets = parseTargets();
console.log(`== four-pack: targets ${targets.join(", ")} ==`);

if (process.env.GROK_BOT_PACK_SKIP_CHECK !== "1") {
  await runStep("npm", ["run", "check"]);
}

await runStep(process.execPath, [path.join(scriptDir, "build-client-ui.mjs")]);

const desktopTargets = targets.filter(target => target === "linux-x64" || target === "windows-x64" || target === "macos-arm64");
const includeAndroid = targets.includes("android");

if (desktopTargets.length > 0) {
  console.log(`== four-pack: packaging desktop ${desktopTargets.join(", ")} (one asar) ==`);
  await runStep(process.execPath, [path.join(scriptDir, "lib", "package-electron.mjs"), ...desktopTargets]);
}
if (includeAndroid) {
  console.log("== four-pack: packaging android ==");
  await runStep(process.execPath, [path.join(scriptDir, "package.mjs")], {
    env: { ...process.env, GROK_BOT_TARGET: "android" },
  });
}

console.log("== four-pack: verification ==");
const skipProbe = process.env.GROK_BOT_PACK_SKIP_PROBE === "1" ? ["--skip-probe"] : [];
await runStep(process.execPath, [
  path.join(scriptDir, "verify-four-pack.mjs"),
  "--targets", targets.join(","),
  "--require", targets.join(","),
  ...skipProbe,
]);
console.log(`Four-pack complete. Artifacts are under ${outputDir} (and targets/android for the APK).`);

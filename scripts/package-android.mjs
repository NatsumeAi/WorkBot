import path from "node:path";
import { access, chmod, cp, mkdir, rm } from "node:fs/promises";
import { repoRoot, outputDir } from "./lib/config.mjs";
import { buildClientUi, installClientUiIntoWebRoot, stagedWebRootFindings } from "./lib/four-pack.mjs";
import { run } from "./lib/process.mjs";

const androidRoot = path.join(repoRoot, "targets", "android");
const www = path.join(androidRoot, "www");
const assetsWww = path.join(androidRoot, "app", "src", "main", "assets", "www");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage the ONE shared client-UI directory (pinned renderer + client-overrides)
 * into the Android web roots. The Android package never builds its own
 * frontend: byte parity with the Electron packages is the contract, enforced
 * against the client-UI manifest below.
 */
export async function stageAndroidWebShell() {
  const built = await buildClientUi();
  const staged = await installClientUiIntoWebRoot(www, { manifest: built.manifest });
  await mkdir(assetsWww, { recursive: true });
  await rm(assetsWww, { recursive: true, force: true });
  await cp(www, assetsWww, { recursive: true, dereference: false, preserveTimestamps: true });
  const webRootRelative = staged.manifest.files.map(file => file.path.startsWith("renderer/") ? file.path.slice("renderer/".length) : file.path);
  const findings = stagedWebRootFindings(webRootRelative);
  const failures = findings.filter(finding => finding.severity === "fail");
  if (failures.length > 0) {
    throw new Error(`Android web root failed the four-pack UI rules:\n${failures.map(failure => `- ${failure.message}`).join("\n")}`);
  }
  return { www, assetsWww, manifest: staged.manifest };
}

export async function packageAndroid() {
  const staged = await stageAndroidWebShell();
  const gradlew = process.platform === "win32"
    ? path.join(androidRoot, "gradlew.bat")
    : path.join(androidRoot, "gradlew");
  const gradle = await exists(gradlew) ? gradlew : "gradle";
  if (await exists(gradlew) && process.platform !== "win32") {
    await chmod(gradlew, 0o755).catch(() => undefined);
  }
  try {
    await run(gradle, ["assembleRelease", "--no-daemon"], { cwd: androidRoot });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Android web shell staged at ${staged.www}, but assembleRelease failed (${detail}). Install the Android SDK / Gradle wrapper and retry.`);
  }
  const apk = path.join(androidRoot, "app", "build", "outputs", "apk", "release", "app-release.apk");
  if (!await exists(apk)) {
    throw new Error(`assembleRelease finished but ${apk} is missing.`);
  }
  await mkdir(outputDir, { recursive: true });
  const distApk = path.join(outputDir, "openbot-android.apk");
  await rm(distApk, { force: true });
  await cp(apk, distApk);
  await rm(path.join(outputDir, "openbot-android-debug.apk"), { force: true });
  console.log(`Packaged application: ${distApk}`);
  return { ...staged, apk, distApk };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("package-android.mjs")) {
  await packageAndroid();
}

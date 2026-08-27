import { build } from "esbuild";
import { access, chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./lib/config.mjs";
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

export async function stageAndroidWebShell() {
  await mkdir(www, { recursive: true });
  await run(process.execPath, [
    path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
    "build",
    "--config",
    path.join(repoRoot, "frontend", "vite.config.ts"),
  ], { cwd: repoRoot });
  const frontendOut = path.join(repoRoot, ".build", "frontend-shell");
  if (await exists(frontendOut)) {
    await cp(frontendOut, www, { recursive: true });
  }
  await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: [path.join(androidRoot, "src", "desktop-shell.ts")],
    format: "esm",
    outfile: path.join(www, "desktop-shell.js"),
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    resolveExtensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
  });
  const indexPath = path.join(www, "index.html");
  let html = await exists(indexPath)
    ? await readFile(indexPath, "utf8")
    : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grok Bot</title></head><body><div id="root"></div></body></html>`;
  if (!html.includes("desktop-shell.js")) {
    if (html.includes("<head>")) {
      html = html.replace("<head>", `<head>\n    <script type="module" src="./desktop-shell.js"></script>`);
    } else {
      html = `<script type="module" src="./desktop-shell.js"></script>${html}`;
    }
  }
  await writeFile(indexPath, html);
  await mkdir(assetsWww, { recursive: true });
  await cp(www, assetsWww, { recursive: true });
  return { www, assetsWww };
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
    await run(gradle, ["assembleDebug", "--no-daemon"], { cwd: androidRoot });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Android web shell staged at ${staged.www}, but assembleDebug failed (${detail}). Install the Android SDK / Gradle wrapper and retry.`);
  }
  return staged;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("package-android.mjs")) {
  await packageAndroid();
}

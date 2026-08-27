import { detectHostPlatformTarget, unimplementedTargetError } from "./lib/platforms.mjs";

const target = detectHostPlatformTarget();
if (target.status !== "implemented") {
  console.error(unimplementedTargetError(target).message);
  console.error(`Set GROK_BOT_TARGET to an implemented target (macos-arm64, linux-x64, windows-x64, android) when the packager is ready.`);
  process.exit(2);
}

if (target.id === "macos-arm64") {
  await import("./package-macos.mjs");
} else if (target.id === "linux-x64") {
  await import("./package-linux.mjs");
} else if (target.id === "windows-x64") {
  await import("./package-windows.mjs");
} else if (target.id === "android") {
  const { packageAndroid } = await import("./package-android.mjs");
  await packageAndroid();
} else {
  console.error(unimplementedTargetError(target).message);
  process.exit(2);
}

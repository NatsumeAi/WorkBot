import path from "node:path";

export function resolvePackagedAppArtifacts(appPath) {
  if (typeof appPath !== "string" || appPath.trim() === "") {
    throw new TypeError("A packaged application path is required");
  }
  const resolvedApp = path.resolve(appPath);
  if (path.extname(resolvedApp) !== ".app") {
    throw new TypeError(`Expected a .app bundle path, received ${appPath}`);
  }
  const asarPath = path.join(resolvedApp, "Contents", "Resources", "app.asar");
  return Object.freeze({
    appPath: resolvedApp,
    asarPath,
    unpackedPath: `${asarPath}.unpacked`,
  });
}

export function resolvePackagedArtifacts(targetPath, targetId = "macos-arm64") {
  if (targetId === "android") {
    const apkPath = path.resolve(targetPath);
    return Object.freeze({
      appPath: apkPath,
      asarPath: null,
      unpackedPath: null,
      artifactKind: "apk",
    });
  }
  if (targetId === "linux-x64" || targetId === "windows-x64") {
    const appPath = path.resolve(targetPath);
    const asarPath = path.join(appPath, "resources", "app.asar");
    return Object.freeze({
      appPath,
      asarPath,
      unpackedPath: `${asarPath}.unpacked`,
      artifactKind: "electron-dir",
    });
  }
  return resolvePackagedAppArtifacts(targetPath);
}

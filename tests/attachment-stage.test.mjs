import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadTs(entry) {
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    platform: "node",
    write: false,
    packages: "external",
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error(`esbuild produced no output for ${entry}`);
  const outfile = path.join(repoRoot, `.tmp-test-${randomUUID()}.mjs`);
  await writeFile(outfile, file.text);
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    await unlink(outfile).catch(() => {});
  }
}

function stubPort(stagingDir) {
  const uploads = [];
  return {
    uploads,
    legs: {
      readAttachmentImage: async () => null,
      readAttachmentText: async () => null,
      readAttachmentChunk: async () => null,
      uploadAttachment: async (request) => {
        uploads.push(request);
        return { path: `/box/${request.filename}` };
      },
    },
    getMainWindow: () => null,
    onEdgeFailure() {},
    videoMimeFromPath: () => null,
    audioMimeFromPath: () => null,
    displayableImageMimeFromPath: () => null,
    buildMediaUrl: (value) => value,
    resolveImage: async () => null,
    fetchLinkMetadata: async () => null,
    boundPreviewImage: () => null,
    nativeImage: {
      createFromDataURL: () => ({
        isEmpty: () => true,
        resize: () => ({ isEmpty: () => true, toJPEG: () => Buffer.alloc(0), toPNG: () => Buffer.alloc(0) }),
      }),
    },
    getUserDataDir: () => stagingDir,
    downloadsDir: stagingDir,
    previewKindNeedsBytes: () => false,
    getFilePreviewKind: () => "other",
    previewByteCap: 25 * 1024 * 1024,
    byteLimitForName: () => 25 * 1024 * 1024,
    getStagingDir: () => stagingDir,
    isWithinStagingDir: (filePath) => typeof filePath === "string" && filePath.startsWith(stagingDir),
    resolveSuggestedDownloadName: ({ sourcePath }) => sourcePath,
    resolveDefaultDownloadPath: ({ fileName }) => path.join(stagingDir, fileName),
    showSaveDialog: async () => ({ canceled: true }),
    createHiddenWindow: () => ({}),
    showErrorMessage: async () => {},
    now: () => 1,
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
  };
}

function arrayBufferOf(text) {
  const payload = Buffer.from(text);
  return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
}

test("stageBytes does not call webcrypto randomUUID unbound", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/attachments/attachments.ts"), "utf8");
  assert.match(source, /import \{ randomUUID \} from "node:crypto"/);
  assert.doesNotMatch(source, /crypto\.randomUUID/);
});

test("overlay UbX encodes attachment bytes as base64 before crossing contextBridge", async () => {
  const overlay = await readFile(path.join(repoRoot, "client-ui/renderer-overlay/assets/index-UbX-y3il.js"), "utf8");
  assert.doesNotMatch(
    overlay,
    /n\.stageAttachmentBytes\(e\.filename,e\.bytes\)/,
    "overlay still passes a Uint8Array through contextBridge; Windows toast Couldn't attach returns",
  );
  assert.match(overlay, /window\.sandStageAttachment&&window\.sandStageAttachment\.stage\|\|n\.stageAttachmentBytes/);
  assert.match(overlay, /return btoa\(b\)/);
});

test("encodeAttachmentBytesBase64 round-trips through coerceAttachmentBytes", async () => {
  const { coerceAttachmentBytes, encodeAttachmentBytesBase64 } = await loadTs("source/shared/media/attachment-bytes.ts");
  const payload = new Uint8Array(Buffer.from("hello-file"));
  const encoded = encodeAttachmentBytesBase64(payload);
  assert.equal(typeof encoded, "string");
  assert.equal(Buffer.from(coerceAttachmentBytes(encoded)).toString("utf8"), "hello-file");
  const { createAttachmentEdgePort } = await loadTs("source/electron-main/attachments/attachments.ts");
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "openbot-attach-b64-"));
  const port = createAttachmentEdgePort(stubPort(stagingDir));
  try {
    const staged = await port.stageBytes({ filename: "note.txt", bytesBase64: encoded });
    assert.equal(staged.ok, true, `bytesBase64 request must stage, got ${JSON.stringify(staged)}`);
    assert.equal(await readFile(staged.path, "utf8"), "hello-file");
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("coerceAttachmentBytes recovers every clone Electron/WebView actually delivers", async () => {
  const { coerceAttachmentBytes } = await loadTs("source/shared/media/attachment-bytes.ts");
  const expected = Buffer.from("hello-file");
  const clones = [
    new Uint8Array(expected),
    arrayBufferOf("hello-file"),
    { type: "Buffer", data: [...expected] },
    [...expected],
    Object.fromEntries([...expected].map((byte, index) => [String(index), byte])),
    expected.toString("base64"),
  ];
  for (const clone of clones) {
    const got = coerceAttachmentBytes(clone);
    assert.ok(got, `clone ${Object.prototype.toString.call(clone)} must coerce`);
    assert.equal(Buffer.from(got).toString("utf8"), "hello-file");
  }
  assert.equal(coerceAttachmentBytes({}), null);
});

test("stageBytes accepts Windows paths and a dummy second contextBridge argument", async () => {
  const { createAttachmentEdgePort } = await loadTs("source/electron-main/attachments/attachments.ts");
  const { resolveStageAttachmentArgs } = await loadTs("source/shared/media/attachment-bytes.ts");
  const encoded = Buffer.from("hello-file").toString("base64");
  const request = { filename: String.raw`C:\Users\nat\Desktop\photo.png`, bytesBase64: encoded };
  const unwrapped = resolveStageAttachmentArgs(request, {});
  assert.equal(unwrapped.filename, String.raw`C:\Users\nat\Desktop\photo.png`);
  assert.equal(unwrapped.bytes, encoded);
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "openbot-attach-win-"));
  const deps = stubPort(stagingDir);
  const port = createAttachmentEdgePort(deps);
  try {
    const staged = await port.stageBytes(request, {});
    assert.equal(staged.ok, true, `Windows path + empty second arg must stage, got ${JSON.stringify(staged)}`);
    const live = createAttachmentEdgePort({ ...deps, randomUUID: undefined, now: undefined });
    const liveStaged = await live.stageBytes({ filename: "live.txt", bytesBase64: encoded });
    assert.equal(liveStaged.ok, true, `unbound crypto.randomUUID must not throw, got ${JSON.stringify(liveStaged)}`);
    assert.equal(await readFile(staged.path, "utf8"), "hello-file");
    assert.match(staged.path, /\.png$/);
    const committed = await port.commitStaged([staged.path], [String.raw`C:\Users\nat\Desktop\photo.png`]);
    assert.deepEqual(committed, ["/box/photo.png"]);
    assert.equal(deps.uploads[0].filename, "photo.png");
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("desktop stageBytes + commitStaged accept IPC clones and upload bytesBase64", async () => {
  const { createAttachmentEdgePort } = await loadTs("source/electron-main/attachments/attachments.ts");
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "openbot-attach-"));
  const deps = stubPort(stagingDir);
  const port = createAttachmentEdgePort(deps);
  try {
    const staged = await port.stageBytes("note.txt", arrayBufferOf("hello-file"));
    assert.equal(staged.ok, true, `ArrayBuffer clone must stage, got ${JSON.stringify(staged)}`);
    assert.equal(await readFile(staged.path, "utf8"), "hello-file");

    assert.equal((await port.stageBytes("note2.txt", { type: "Buffer", data: [...Buffer.from("hello-file")] })).ok, true);
    assert.equal((await port.stageBytes("note3.txt", [...Buffer.from("hello-file")])).ok, true);
    assert.equal((await port.stageBytes({ filename: "nested.txt", bytes: Buffer.from("hello-file") })).ok, true);

    const empty = await port.stageBytes("empty.txt", new ArrayBuffer(0));
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, "empty");
    assert.equal((await port.stageBytes("gone.txt", {})).reason, "failed");

    const committed = await port.commitStaged([staged.path], ["note.txt"]);
    assert.deepEqual(committed, ["/box/note.txt"]);
    assert.equal(deps.uploads.length, 1);
    assert.equal(deps.uploads[0].filename, "note.txt");
    assert.equal(Buffer.from(deps.uploads[0].bytesBase64, "base64").toString("utf8"), "hello-file");
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Android/web stageBytes + commitStaged accept the same clones and POST bytesBase64", async () => {
  const { createWebMainEdgeDeps } = await loadTs("source/client-runtime/web/web-main-edge.ts");
  const uploads = [];
  const deps = createWebMainEdgeDeps({
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    gateway: {
      async dispatchCommand(method, args) {
        uploads.push({ method, args });
        if (method === "uploadAttachment") return { path: `/box/${args.filename}` };
        throw new Error(`unexpected ${method}`);
      },
    },
    events: { postEvent() {} },
  });
  const staged = await deps.attachments.stageBytes("note.txt", arrayBufferOf("hello-file"));
  assert.equal(staged.ok, true, `web ArrayBuffer clone must stage, got ${JSON.stringify(staged)}`);
    assert.equal((await deps.attachments.stageBytes({ filename: "nested.txt", bytes: [...Buffer.from("hello-file")] })).ok, true);
    const win = await deps.attachments.stageBytes({ filename: String.raw`C:\Users\nat\pic.png`, bytes: [...Buffer.from("hello-file")] }, {});
    assert.equal(win.ok, true, `web Windows path must stage, got ${JSON.stringify(win)}`);
  const committed = await deps.attachments.commitStaged([staged.path], ["note.txt"]);
  assert.deepEqual(committed, ["/box/note.txt"]);
  assert.equal(uploads[0].method, "uploadAttachment");
  assert.equal(Buffer.from(uploads[0].args.bytesBase64, "base64").toString("utf8"), "hello-file");
});

test("packed linux, windows, and android encode attachments as bytesBase64; linux asar equals windows asar", async () => {
  const { extractFile } = await import("@electron/asar");
  const linuxAsar = path.join(repoRoot, "dist/workbot-linux-x64/resources/app.asar");
  const windowsAsar = path.join(repoRoot, "dist/workbot-win32-x64/resources/app.asar");
  const apk = path.join(repoRoot, "dist/workbot-android.apk");
  let linux;
  let windows;
  try {
    linux = await readFile(linuxAsar);
    windows = await readFile(windowsAsar);
  } catch {
    assert.fail("packed linux/windows asar missing; pack after the attach fix");
  }
  assert.equal(linux.length, windows.length, "linux and windows asar must be the same payload (macos uses this asar)");
  assert.deepEqual(linux, windows, "linux and windows asar bytes must match; macos is treated like linux");
  const ubx = extractFile(linuxAsar, "dist/renderer/assets/index-UbX-y3il.js").toString("utf8");
  assert.doesNotMatch(ubx, /n\.stageAttachmentBytes\(e\.filename,e\.bytes\)/);
  assert.match(ubx, /window\.sandStageAttachment&&window\.sandStageAttachment\.stage\|\|n\.stageAttachmentBytes/);
  const main = extractFile(linuxAsar, "dist/electron-main/main.cjs").toString("utf8");
  assert.match(main, /normalizeAttachmentFilename/);
  assert.match(main, /require\("crypto"\)|from "node:crypto"|import_crypto|randomUUID/);
  const preload = extractFile(linuxAsar, "dist/electron-preload/preload.cjs").toString("utf8");
  assert.match(preload, /sandStageAttachment/);
  let boot;
  try {
    boot = execFileSync("unzip", ["-p", apk, "assets/www/client-overrides/boot.js"], { maxBuffer: 32 * 1024 * 1024 }).toString("utf8");
  } catch {
    assert.fail("packed Android APK missing boot.js; pack after the attach fix");
  }
  assert.match(boot, /sandStageAttachment/);
  let apkUbx;
  try {
    apkUbx = execFileSync("unzip", ["-p", apk, "assets/www/assets/index-UbX-y3il.js"], { maxBuffer: 32 * 1024 * 1024 }).toString("utf8");
  } catch {
    assert.fail("packed Android APK missing overlay UbX; pack after the attach fix");
  }
  assert.match(apkUbx, /window\.sandStageAttachment&&window\.sandStageAttachment\.stage\|\|n\.stageAttachmentBytes/);
});

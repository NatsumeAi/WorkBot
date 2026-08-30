import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  packedLinuxAsar,
  packedWindowsAsar,
  skipUnlessExists,
} from "./harness/optional-pack.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const liveHost = "/home/natsume/openbot-box/host-main.cjs";

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

function hostStub() {
  const freed = [];
  return {
    getConversationId: () => "parent-1",
    resolveBoxId: () => "box",
    emitAsyncTasksChanged() {},
    computerUse: {
      freeWindow(id) {
        freed.push(id);
      },
    },
    freed,
  };
}

function hangingSession(releaseInto) {
  let release;
  const hang = new Promise((resolve, reject) => {
    release = { resolve, reject };
  });
  releaseInto.release = release;
  return {
    hang,
    session: {
      interrupt() {
        release.resolve({ text: "", aborted: true });
      },
      async run() {
        return hang;
      },
      getResolvedOutline: async () => [],
      getObservedToolCallCount: () => 0,
      getActivitySnapshot: () => [],
      getTranscriptPath: () => null,
    },
  };
}

test("StopSubagent abort kills a hanging child, frees the desktop, and does not revive the parent", async () => {
  const { createSubagentRuntime } = await loadTs("source/host/runner/subagent-runtime.ts");
  const host = hostStub();
  const runtime = createSubagentRuntime(host);
  let revived = 0;
  runtime.setBackgroundSubagentHandler(() => {
    revived += 1;
  });
  const slot = {};
  const { hang, session } = hangingSession(slot);
  runtime.sessions.set("child-1", session);
  runtime.dispatchBackgroundSubagent({
    subagentAgentId: "child-1",
    subagentType: "computerUse",
    toolCallId: "tc-1",
    prompt: "keep searching",
    run: () => hang,
  });
  assert.equal(runtime.isRunning("child-1"), true);
  assert.equal(runtime.abortSubagent("child-1"), "aborted");
  assert.ok(host.freed.includes("child-1"), "abort must free the box desktop immediately");
  await runtime.drainBackgroundSubagents();
  assert.equal(runtime.isRunning("child-1"), false);
  assert.equal(revived, 0, "aborted subagent must not revive the parent bot");
});

test("parent abortAll kills every hanging child and does not revive", async () => {
  const { createSubagentRuntime } = await loadTs("source/host/runner/subagent-runtime.ts");
  const host = hostStub();
  const runtime = createSubagentRuntime(host);
  let revived = 0;
  runtime.setBackgroundSubagentHandler(() => {
    revived += 1;
  });
  for (const id of ["child-a", "child-b"]) {
    const slot = {};
    const { hang, session } = hangingSession(slot);
    runtime.sessions.set(id, session);
    runtime.dispatchBackgroundSubagent({
      subagentAgentId: id,
      subagentType: "computerUse",
      toolCallId: `tc-${id}`,
      prompt: "keep going",
      run: () => hang,
    });
  }
  assert.equal(runtime.abortAllBackgroundSubagents("user stop"), true);
  await runtime.drainBackgroundSubagents();
  assert.equal(runtime.isRunning("child-a"), false);
  assert.equal(runtime.isRunning("child-b"), false);
  assert.equal(revived, 0);
});

test("completed child still revives the parent once", async () => {
  const { createSubagentRuntime } = await loadTs("source/host/runner/subagent-runtime.ts");
  const runtime = createSubagentRuntime(hostStub());
  let revived = 0;
  let status;
  runtime.setBackgroundSubagentHandler((completion) => {
    revived += 1;
    status = completion.status;
  });
  let release;
  const hang = new Promise((resolve) => {
    release = resolve;
  });
  runtime.sessions.set("child-ok", {
    interrupt() {},
    async run() {
      return hang;
    },
    getResolvedOutline: async () => [],
    getObservedToolCallCount: () => 0,
    getActivitySnapshot: () => [],
    getTranscriptPath: () => null,
  });
  runtime.dispatchBackgroundSubagent({
    subagentAgentId: "child-ok",
    subagentType: "generalPurpose",
    toolCallId: "tc-ok",
    prompt: "finish",
    run: () => hang,
  });
  release({ text: "found nothing", aborted: false });
  await runtime.drainBackgroundSubagents();
  assert.equal(revived, 1);
  assert.equal(status, "completed");
});

test("errored child still revives the parent once", async () => {
  const { createSubagentRuntime } = await loadTs("source/host/runner/subagent-runtime.ts");
  const runtime = createSubagentRuntime(hostStub());
  let revived = 0;
  let status;
  runtime.setBackgroundSubagentHandler((completion) => {
    revived += 1;
    status = completion.status;
  });
  let fail;
  const hang = new Promise((_, reject) => {
    fail = reject;
  });
  runtime.sessions.set("child-err", {
    interrupt() {},
    async run() {
      return hang;
    },
    getResolvedOutline: async () => [],
    getObservedToolCallCount: () => 0,
    getActivitySnapshot: () => [],
    getTranscriptPath: () => null,
  });
  runtime.dispatchBackgroundSubagent({
    subagentAgentId: "child-err",
    subagentType: "browserUse",
    toolCallId: "tc-err",
    prompt: "search",
    run: () => hang,
  });
  fail(new Error("tool exploded"));
  await runtime.drainBackgroundSubagents();
  assert.equal(revived, 1);
  assert.equal(status, "error");
});

test("child interrupt without StopSubagent still must not revive the parent", async () => {
  const { createSubagentRuntime } = await loadTs("source/host/runner/subagent-runtime.ts");
  const runtime = createSubagentRuntime(hostStub());
  let revived = 0;
  runtime.setBackgroundSubagentHandler(() => {
    revived += 1;
  });
  const slot = {};
  const { hang, session } = hangingSession(slot);
  runtime.sessions.set("child-2", session);
  runtime.dispatchBackgroundSubagent({
    subagentAgentId: "child-2",
    subagentType: "generalPurpose",
    toolCallId: "tc-2",
    prompt: "keep going",
    run: () => hang,
  });
  runtime.sessions.get("child-2").interrupt("parent new message");
  await runtime.drainBackgroundSubagents();
  assert.equal(revived, 0);
});

test("parent interrupt source aborts every background subagent", async () => {
  const [shell, runner, runtime, revivals] = await Promise.all([
    readFile(path.join(repoRoot, "source/host/runner/turn-run-shell.ts"), "utf8"),
    readFile(path.join(repoRoot, "source/host/runner/sand-agent-runner.ts"), "utf8"),
    readFile(path.join(repoRoot, "source/host/runner/subagent-runtime.ts"), "utf8"),
    readFile(
      path.join(repoRoot, "source/host/extensions/transcript/completion-revivals.ts"),
      "utf8",
    ),
  ]);
  assert.match(shell, /abortAllBackgroundSubagents/);
  assert.match(runner, /abortAllBackgroundSubagents/);
  assert.match(runtime, /return "aborted"/);
  assert.match(runtime, /requestedAbort \|\| outcome\.status === "aborted"/);
  assert.match(runtime, /computerUse\.freeWindow\(subagentAgentId\)/);
  assert.match(revivals, /completion.status === "aborted"/);
  assert.doesNotMatch(revivals, /completion.status !== "completed"/);
});

function assertHostStopNeedles(host, label) {
  assert.match(host, /abortAllBackgroundSubagents/, `${label} missing abortAllBackgroundSubagents`);
  assert.match(host, /Stopped by the parent agent/, `${label} missing StopSubagent interrupt`);
  assert.match(host, /status\s*===\s*"aborted"/, `${label} missing aborted revival drop`);
  assert.doesNotMatch(
    host,
    /The background task was interrupted before it finished/,
    `${label} still maps abort to a parent revival result`,
  );
}

test("packed host abort kills children and does not revive", async (t) => {
  if (skipUnlessExists(t, packedLinuxAsar, "packed linux asar missing; run pack:all")) return;
  const { extractFile } = await import("@electron/asar");
  const host = extractFile(packedLinuxAsar, "dist/host/host-main.cjs").toString("utf8");
  assertHostStopNeedles(host, "packed linux host-main");
  if (skipUnlessExists(t, packedWindowsAsar, "packed windows asar missing; run pack:all")) return;
  const winHost = extractFile(packedWindowsAsar, "dist/host/host-main.cjs").toString("utf8");
  assertHostStopNeedles(winHost, "packed windows host-main");
});

test("live box host-main abort kills children and does not revive", async (t) => {
  if (skipUnlessExists(t, liveHost, "live box host-main missing; not present on CI")) return;
  const host = await readFile(liveHost, "utf8");
  assertHostStopNeedles(host, "live box host-main");
});

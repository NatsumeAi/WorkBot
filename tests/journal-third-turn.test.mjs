import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function envelope(text) {
  return JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } });
}

function ck(...labels) {
  return { turns: labels.map((label) => Buffer.from(label)) };
}

async function loadRouter() {
  const source = await (await import("node:fs/promises")).readFile(
    path.join(repoRoot, "source/host/transcript-mirror/transcript-mirror-router.ts"),
    "utf8",
  );
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

async function loadMirror(transcriptsDir) {
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ["source/host/transcript-mirror/transcript-mirror.ts"],
    format: "esm",
    platform: "node",
    write: false,
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error("esbuild produced no transcript-mirror bundle");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(file.text).toString("base64")}`);
  const deriver = {
    async initial(_ctx, _store, checkpoint) {
      if (checkpoint.turns.length === 0) return [];
      return [{ id: "init", line: envelope("init") }];
    },
    async derive(_ctx, _store, previous, checkpoint) {
      if (checkpoint.turns.length <= previous.turns.length) return { occurrences: [] };
      const n = checkpoint.turns.length;
      return { occurrences: [{ id: `t${n}`, line: envelope(String(n)) }] };
    },
  };
  return new mod.FileTranscriptMirror(transcriptsDir, () => {}, deriver);
}

test("journal experiment off ignores leftover markers and never recovers journal", async () => {
  const { RoutedTranscriptMirror } = await loadRouter();
  let recovered = 0;
  let preparedJournal = 0;
  let claimed = 0;
  const journal = {
    ownsConversation: async () => true,
    claimConversation: async () => { claimed += 1; },
    recover: async () => { recovered += 1; },
    prepareCheckpoint: async () => { preparedJournal += 1; },
    commitCheckpoint: async () => {},
    abortCheckpoint: async () => {},
    skipCheckpoint: async () => {},
  };
  const wrote = [];
  const legacy = { write: async (_ctx, id) => { wrote.push(id); } };
  const mirror = new RoutedTranscriptMirror(journal, legacy, async () => false);
  const checkpoint = { turns: [] };
  await mirror.recover({}, "bot", checkpoint, {});
  await mirror.prepareCheckpoint({}, "bot", checkpoint, {}, true, true);
  await mirror.commitCheckpoint({}, "bot", new Uint8Array([1]));
  assert.equal(recovered, 0);
  assert.equal(preparedJournal, 0);
  assert.equal(claimed, 0);
  assert.deepEqual(wrote, ["bot"]);
});

test("five persist rounds after recover do not rewind or throw", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "journal-five-"));
  try {
    const mirror = await loadMirror(dir);
    const id = "bot";
    const store = {};
    await mirror.claimConversation(id);
    let previous = ck("t0");
    await mirror.recover({}, id, previous, store);
    for (let round = 1; round <= 5; round += 1) {
      const next = ck(...Array.from({ length: round + 1 }, (_, i) => `t${i}`));
      await mirror.recover({}, id, previous, store);
      await mirror.prepareCheckpoint({}, id, next, store, true);
      await mirror.commitCheckpoint({}, id);
      previous = next;
    }
    assert.equal(mirror.durableCheckpoints.get(id).turns.length, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mismatched leftover WAL is dropped instead of killing the next turn", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "journal-wal-"));
  try {
    const mirror = await loadMirror(dir);
    const id = "bot";
    const store = {};
    await mirror.claimConversation(id);
    const first = ck("a");
    const second = ck("a", "b");
    await mirror.recover({}, id, first, store);
    await mirror.prepareCheckpoint({}, id, second, store, true);
    await mirror.recover({}, id, ck("unrelated"), store);
    await mirror.prepareCheckpoint({}, id, ck("a", "b", "c"), store, true);
    await mirror.commitCheckpoint({}, id);
    assert.equal(mirror.durableCheckpoints.get(id).turns.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

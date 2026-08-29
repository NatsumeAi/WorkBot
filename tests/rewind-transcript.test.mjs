import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transform } from "esbuild";
import { randomUUID } from "node:crypto";

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
    await unlinkQuiet(outfile);
  }
}

async function unlinkQuiet(file) {
  await rm(file, { force: true }).catch(() => {});
}

async function loadRewind() {
  return loadTs("source/host/transcript-rewind.ts");
}

function user(id, extra = {}) {
  return { id, kind: "message", role: "user", content: id, ...extra };
}
function bot(id) {
  return { id, kind: "send-message", message: { type: "text", content: id } };
}

test("rewind keeps earlier turns and drops the anchor user message plus everything after", async () => {
  const { planTranscriptRewind } = await loadRewind();
  const entries = [
    bot("greet"),
    user("t1u"),
    bot("t1s0"),
    user("t2u"),
    bot("t2s0"),
    user("t3u"),
    bot("t3s0"),
  ];
  const decision = planTranscriptRewind(entries, "t2u");
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.plan.kept.map((entry) => entry.id), ["greet", "t1u", "t1s0"]);
  assert.deepEqual(decision.plan.droppedIds, ["t2u", "t2s0", "t3u", "t3s0"]);
});

test("v1 rewind refuses assistant, threads, groups, subagents, and pending tools", async () => {
  const { planTranscriptRewind } = await loadRewind();
  const entries = [user("t1u"), bot("t1s0"), user("t2u")];
  assert.equal(planTranscriptRewind(entries, "t1s0").reason, "not-user-message");
  assert.equal(planTranscriptRewind(entries, "missing").reason, "missing-entry");
  assert.equal(planTranscriptRewind([user("t1u", { replyTo: "x" })], "t1u").reason, "threaded");
  assert.equal(planTranscriptRewind(entries, "t2u", { threadDescendantCount: 1 }).reason, "threaded");
  assert.equal(planTranscriptRewind(entries, "t2u", { isGroup: true }).reason, "group");
  assert.equal(planTranscriptRewind(entries, "t2u", { isRemoteRoom: true }).reason, "group");
  assert.equal(planTranscriptRewind(entries, "t2u", { hasSubagents: true }).reason, "subagents");
  assert.equal(planTranscriptRewind(entries, "t2u", { hasPendingTools: true }).reason, "pending-tools");
});

test("summary archives that cover truncated turns are dropped; later-only archives stay", async () => {
  const { keepSummaryArchivesByWindowTail, archiveCoversDroppedMessage } = await loadRewind();
  assert.deepEqual(
    keepSummaryArchivesByWindowTail([{ windowTail: 4 }, { windowTail: 1 }, { windowTail: 2 }], 2).map((a) => a.windowTail),
    [1, 2],
  );
  const dropped = [Buffer.from("u2")];
  assert.equal(archiveCoversDroppedMessage([Buffer.from("u1"), Buffer.from("u2")], dropped), true);
  assert.equal(archiveCoversDroppedMessage([Buffer.from("u1")], dropped), false);
});

test("conversation turns cut at the matching user message id, not by sqlite index", async () => {
  const {
    ConversationTurnStructure,
    UserMessage,
  } = await loadTs("source/packages/proto/generated/agent/v1/agent_pb.ts");
  const { selectKeptTurnBlobs } = await loadRewind();
  const blobs = new Map();
  const turnFor = (messageId) => {
    const userId = Buffer.from(`user-${messageId}`);
    blobs.set(Buffer.from(userId).toString("hex"), new UserMessage({ messageId, text: messageId }).toBinary());
    return new ConversationTurnStructure({
      turn: {
        case: "agentConversationTurn",
        value: { userMessage: userId, steps: [], sendMessageStepIndices: [] },
      },
    }).toBinary();
  };
  const store = {
    async getBlob(_ctx, id) {
      return blobs.get(Buffer.from(id).toString("hex"));
    },
  };
  const turns = [turnFor("t1u"), turnFor("t2u"), turnFor("t3u")];
  const kept = await selectKeptTurnBlobs(turns, "t2u", new Set(["t2u", "t2s0", "t3u"]), 1, store, {});
  assert.equal(kept.length, 1);
});

test("journal rebuild from a shorter checkpoint then recover does not restore dropped turns", async () => {
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "rewind-journal-"));
  try {
    const deriver = {
      async initial(_ctx, _store, checkpoint) {
        return checkpoint.turns.map((turn, index) => ({
          id: `t${index}`,
          line: JSON.stringify({ role: "user", message: { content: [{ type: "text", text: Buffer.from(turn).toString() }] } }),
        }));
      },
      async derive() {
        return { occurrences: [] };
      },
    };
    const mirror = new mod.FileTranscriptMirror(dir, () => {}, deriver);
    const id = "bot";
    await mirror.claimConversation(id);
    const three = { turns: [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")] };
    await mirror.recover({}, id, three, {});
    await mirror.rebuildFromCheckpoint({}, id, { turns: [Buffer.from("a")] }, {});
    const jsonl = await readFile(mirror.jsonlPathFor(id), "utf8");
    assert.match(jsonl, /"a"/);
    assert.doesNotMatch(jsonl, /"b"/);
    assert.doesNotMatch(jsonl, /"c"/);
    await mirror.recover({}, id, { turns: [Buffer.from("a")] }, {});
    const after = await readFile(mirror.jsonlPathFor(id), "utf8");
    assert.equal(after.split("\n").filter((line) => line.trim().length > 0).length, 1);
    assert.equal(mirror.durableCheckpoints.get(id).turns.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite truncate from a user message leaves only earlier rows", async () => {
  const { SandAgentDb } = await loadTs("source/host/extensions/session/agent-db.ts");
  const dir = await mkdtemp(path.join(os.tmpdir(), "rewind-db-"));
  const db = new SandAgentDb(path.join(dir, "store.db"), { recoverOnCorruption: false });
  try {
    db.appendTranscriptEntry({ id: "greet", kind: "send-message", message: { type: "text", content: "hi" } });
    db.appendTranscriptEntry({ id: "t1u", kind: "message", role: "user", content: "one" });
    db.appendTranscriptEntry({ id: "t1s0", kind: "send-message", message: { type: "text", content: "ok" } });
    db.appendTranscriptEntry({ id: "t2u", kind: "message", role: "user", content: "two" });
    db.appendTranscriptEntry({ id: "t2s0", kind: "send-message", message: { type: "text", content: "later" } });
    assert.equal(db.truncateTranscriptFrom("t2u"), true);
    assert.deepEqual(db.getTranscriptEntries().map((entry) => entry.id), ["greet", "t1u", "t1s0"]);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rewind interrupts the in-flight run before any transcript row is deleted", async () => {
  const { rewindTranscriptWithHooks } = await loadTs("source/host/transcript-rewind.ts");
  const order = [];
  const entries = [user("t1u"), bot("t1s0"), user("t2u"), bot("t2s0")];
  const result = await rewindTranscriptWithHooks({
    agentId: "bot",
    entryId: "t2u",
    readEntries: () => entries,
    flags: {},
    interrupt: async () => { order.push("interrupt"); },
    truncateSqlite: async () => { order.push("sqlite"); return ["t2u", "t2s0"]; },
    truncateConversation: async () => { order.push("conversation"); },
    rebuildJournal: async () => { order.push("journal"); },
    emitSnapshot: async () => { order.push("sse"); },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ["interrupt", "conversation", "sqlite", "journal", "sse"]);
});

test("rewind does not re-arm kickstart or count whole-transcript send-message deltas", async () => {
  const lifecycle = await readFile(path.join(repoRoot, "source/host/extensions/transcript/agent-lifecycle.ts"), "utf8");
  const rewind = await readFile(path.join(repoRoot, "source/host/transcript-rewind.ts"), "utf8");
  const gateway = await readFile(path.join(repoRoot, "source/host/host-gateway-api.ts"), "utf8");
  const protocol = await readFile(path.join(repoRoot, "source/host/gateway-protocol.ts"), "utf8");
  const coordinator = await readFile(path.join(repoRoot, "source/shared/rpc/coordinator.ts"), "utf8");
  const method = lifecycle.slice(lifecycle.indexOf("async rewindTranscript"));
  assert.match(lifecycle, /rewindTranscript/);
  assert.match(method, /setIntroductionPending\(false\)/);
  assert.doesNotMatch(method, /setIntroductionPending\(true\)/);
  assert.doesNotMatch(rewind, /ensureUserReply|enqueueExclusiveRun/);
  assert.match(gateway, /rewindTranscript:/);
  assert.match(protocol, /rewindTranscript:/);
  assert.match(coordinator, /rewindTranscript:/);
});

test("packed host asar still exposes rewindTranscript on the gateway table", async () => {
  const { extractFile } = await import("@electron/asar");
  const asar = path.join(repoRoot, "dist/openbot-linux-x64/resources/app.asar");
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(asar), true, "packed linux asar missing; run pack:all");
  const host = extractFile(asar, "dist/host/host-main.cjs").toString("utf8");
  assert.match(host, /rewindTranscript/);
  assert.match(host, /transcript rewind/);
});

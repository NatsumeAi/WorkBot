import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  asarSyncLinuxHost,
  asarSyncLinuxMain,
  asarSyncLinuxUbx,
  skipUnlessAllExist,
} from "./harness/optional-pack.mjs";

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

function emptyTurn(extra = {}) {
  return {
    sentMessageCount: 0,
    reacted: false,
    aborted: false,
    endedOnSilentToolCalls: false,
    awaitingUserSelection: false,
    streamOutputProduced: false,
    quiescedForUpgrade: false,
    ...extra,
  };
}

test("this-turn send-message delta stops hidden nudges; earlier greeting does not", async () => {
  const { countSendMessageEntries, isDeliveryOwed, TurnRuntime } = await loadTs(
    "source/host/extensions/transcript/turn-runtime.ts",
  );
  assert.equal(countSendMessageEntries([{ kind: "send-message" }, { kind: "user" }]), 1);
  assert.equal(isDeliveryOwed(emptyTurn(), 0), true);
  assert.equal(isDeliveryOwed(emptyTurn(), 1), false);
  assert.equal(isDeliveryOwed({ sentMessageCount: 1, reacted: false }, 0), false);

  const runtime = new TurnRuntime({
    sendPipeline: { currentTurnEpoch: () => 1 },
    telemetry: { reportClosingSendNudge() {} },
  });
  let runs = 0;
  const runner = {
    async run() {
      runs += 1;
      return emptyTurn({ endedOnSilentToolCalls: true });
    },
  };
  const greetingPlusThisTurn = {
    db: {
      getTranscriptEntries: () => [{ kind: "send-message" }, { kind: "send-message" }],
    },
  };
  const delivered = await runtime.ensureUserReply(
    runner,
    emptyTurn({ endedOnSilentToolCalls: true }),
    greetingPlusThisTurn,
    1,
    undefined,
    undefined,
    undefined,
    undefined,
    1,
  );
  assert.equal(runs, 0);
  assert.equal(delivered.deliveryOwed, false);
  assert.equal(delivered.replyNudgeAttempts, 0);

  const greetingOnly = {
    db: { getTranscriptEntries: () => [{ kind: "send-message" }] },
  };
  const stillOwed = await runtime.ensureUserReply(
    runner,
    emptyTurn({ endedOnSilentToolCalls: true }),
    greetingOnly,
    1,
    undefined,
    undefined,
    undefined,
    undefined,
    1,
  );
  assert.equal(runs, 4);
  assert.equal(stillOwed.replyNudgeAttempts, 3);
  assert.equal(stillOwed.deliveryOwed, true);
});

test("kickstart does not enqueue when transcript already has send-message", async () => {
  const { AgentLifecycle } = await loadTs(
    "source/host/extensions/transcript/agent-lifecycle.ts",
  );
  const enqueued = [];
  let pending = true;
  const session = {
    id: "bot-1",
    db: {
      getIntroductionPending: () => pending,
      setIntroductionPending(value) {
        pending = value;
      },
      getTranscriptEntries: () => [{ kind: "send-message", id: "greet" }],
      getAgentPurpose: () => "chat",
    },
  };
  const life = new AgentLifecycle({
    groupChat: {
      isGroupSession: () => false,
      isRemoteRoomSession: () => false,
    },
    sessions: {
      activeSession: session,
      resolveBackgroundSession: async () => session,
    },
    execution: { canExecute: true },
    runLifecycle: {
      inFlightRunCounts: new Map(),
      beginSessionRun() {},
      enqueueExclusiveRun(...args) {
        enqueued.push(args);
      },
    },
    runnerRegistry: { getRunner: () => ({}) },
  });
  const started = await life.kickstartAgent("bot-1", true);
  assert.equal(started, false);
  assert.equal(enqueued.length, 0);
  assert.equal(pending, false);
});

test("unsigned roster slot local fetches listAgents; null slot does not", async () => {
  const { createRosterSnapshotStore, rendererRosterAccountSlot } = await loadTs(
    "frontend/src/recovered/features/access/cover/roster-snapshot-store.ts",
  );
  assert.equal(rendererRosterAccountSlot({ kind: "logged-out" }), "local");
  assert.equal(rendererRosterAccountSlot(null), "local");
  let lists = 0;
  const source = {
    listAgents: async () => {
      lists += 1;
      return [{ id: "bot-1", name: "Bot" }];
    },
    readPersisted: async () => null,
    subscribeAgents: () => () => {},
    subscribeAgentUpserted: () => () => {},
    subscribeTransport: () => () => {},
  };
  const unsigned = createRosterSnapshotStore({ source });
  await unsigned.connect(rendererRosterAccountSlot({ kind: "anonymous" }));
  assert.equal(lists, 1);
  assert.equal(unsigned.get().agents[0]?.id, "bot-1");
  unsigned.dispose();

  const gated = createRosterSnapshotStore({ source });
  await gated.connect(null);
  assert.equal(lists, 1);
  assert.equal(gated.get().agents.length, 0);
  gated.dispose();
});

test("source host keep this-turn delta; router save requires box ack", async () => {
  const turn = await readFile(
    path.join(repoRoot, "source/host/extensions/transcript/turn-runtime.ts"),
    "utf8",
  );
  const edge = await readFile(
    path.join(repoRoot, "source/electron-main/main-edge.ts"),
    "utf8",
  );
  assert.match(turn, /sendMessageBefore = countSendMessageEntries/);
  assert.match(turn, /isDeliveryOwed\(next, sendMessageDelta\(\)\)/);
  assert.match(turn, /!delivered &&\s*\n\s*latest\.endedOnSilentToolCalls === true/);
  assert.match(edge, /Box did not accept Router settings/);
  assert.doesNotMatch(
    edge,
    /inferenceEndpoints: publicInferenceEndpointsDocument\(merged\) \}\)\.catch\(\(\) => null\)/,
  );
});

test("packed host keep this-turn delta; router save requires box ack", async (t) => {
  if (
    skipUnlessAllExist(
      t,
      [asarSyncLinuxHost, asarSyncLinuxMain, asarSyncLinuxUbx],
      "unpacked asar sync missing; run pack:all",
    )
  ) {
    return;
  }
  const host = await readFile(asarSyncLinuxHost, "utf8");
  const main = await readFile(asarSyncLinuxMain, "utf8");
  const boot = await readFile(asarSyncLinuxUbx, "utf8");
  assert.match(host, /const sendMessageBefore = session\.db\.getTranscriptEntries\(\)\.filter\(\(entry\) => entry\.kind === "send-message"\)\.length/);
  assert.match(host, /if \(!delivered && latest\.endedOnSilentToolCalls === true/);
  assert.match(host, /entry\.kind === "send-message" \|\| isUserMessageEntry\(entry\)/);
  assert.match(main, /Box did not accept Router settings/);
  assert.match(boot, /if\(n\.kind!=="logged-in"\)return"local"/);
});

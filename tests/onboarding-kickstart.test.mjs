import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadSummarization() {
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ["source/packages/agent-summarization/background-summarization.ts"],
    format: "esm",
    platform: "node",
    write: false,
    packages: "external",
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error("esbuild produced no output");
  return import(`data:text/javascript;base64,${Buffer.from(file.text).toString("base64")}`);
}

test("SendMessage delivery is counted on the turn emit path, not only transport", async () => {
  const composition = await readFile(path.join(repoRoot, "source/host/host-runner-composition.ts"), "utf8");
  const adapter = await readFile(path.join(repoRoot, "source/host/runner/production-turn-run-shell-adapter.ts"), "utf8");
  assert.match(composition, /activeTurnEmit = emitUpdate/);
  assert.match(composition, /activeTurnEmit \?\? \(\(next\) => hooks\.transport\.onUpdate\(next\)\)/);
  assert.match(adapter, /const callbacks = updateRelay\.callbacks;/);
  assert.doesNotMatch(adapter, /activePrepared === updateRelay\.prepared/);
  const lifecycle = await readFile(path.join(repoRoot, "source/host/extensions/transcript/agent-lifecycle.ts"), "utf8");
  const gateway = await readFile(path.join(repoRoot, "source/host/host-gateway-api.ts"), "utf8");
  assert.match(lifecycle, /entry\.kind === "send-message" \|\| isUserMessageEntry\(entry\)/);
  assert.match(lifecycle, /sentMessageCount > 0\s*\|\|\s*session\.db\.getTranscriptEntries\(\)\.some\(\(entry: TranscriptEntry\) => entry\.kind === "send-message"\)/);
  assert.match(gateway, /void deps\.kickstartIfPending\(args\.id\)/);
  const turn = await readFile(path.join(repoRoot, "source/host/extensions/transcript/turn-runtime.ts"), "utf8");
  assert.match(turn, /sendMessageBefore = countSendMessageEntries/);
  assert.match(turn, /!delivered &&\s*\n\s*latest\.endedOnSilentToolCalls === true/);
});

test("compress-at percent is the start threshold when unused-token default is cleared", async () => {
  const { getBackgroundSummarizationTriggerThreshold } = await loadSummarization();
  const window = 32_000;
  const unused = 0.1;
  const withDefaultTokens = getBackgroundSummarizationTriggerThreshold(window, {
    unusedTokensThresholdToStartBackgroundSummarization: 10_000,
    unusedPercentTokensThresholdToStartBackgroundSummarization: unused,
  });
  const percentOnly = getBackgroundSummarizationTriggerThreshold(window, {
    unusedTokensThresholdToStartBackgroundSummarization: undefined,
    unusedPercentTokensThresholdToStartBackgroundSummarization: unused,
  });
  assert.equal(withDefaultTokens, 22_000);
  assert.equal(percentOnly, 28_800);
  const half = getBackgroundSummarizationTriggerThreshold(200_000, {
    unusedTokensThresholdToStartBackgroundSummarization: undefined,
    unusedPercentTokensThresholdToStartBackgroundSummarization: 0.5,
  });
  assert.equal(half, 100_000);
});

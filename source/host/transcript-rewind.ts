import {
  ConversationSummaryArchive,
  ConversationTurnStructure,
  UserMessage,
} from "../packages/proto/generated/agent/v1/agent_pb.js";
import { bytesEqual } from "./transcript-mirror/transcript-journal-codec.js";

export const REWIND_COPY = "对话从这里重来";
export const REWIND_SIDE_EFFECT_NOTICE =
  "对话从这里重来。不会撤销已经做过的 Shell / 文件 / 浏览器操作。";

export type RewindRefusal =
  | "missing-args"
  | "missing-entry"
  | "not-user-message"
  | "threaded"
  | "group"
  | "subagents"
  | "pending-tools";

export interface RewindTranscriptEntry {
  readonly id: string;
  readonly kind: string;
  readonly role?: string;
  readonly replyTo?: string;
  readonly branched?: boolean;
  readonly fromAgent?: unknown;
  readonly [key: string]: unknown;
}

export interface RewindPlan {
  readonly anchor: RewindTranscriptEntry;
  readonly kept: readonly RewindTranscriptEntry[];
  readonly dropped: readonly RewindTranscriptEntry[];
  readonly droppedIds: readonly string[];
}

export interface RewindFlags {
  readonly isGroup?: boolean;
  readonly isRemoteRoom?: boolean;
  readonly hasSubagents?: boolean;
  readonly hasPendingTools?: boolean;
  readonly threadDescendantCount?: number;
}

export type RewindDecision =
  | { readonly ok: true; readonly plan: RewindPlan }
  | { readonly ok: false; readonly reason: RewindRefusal };

export function isRewindableUserMessage(entry: RewindTranscriptEntry | null | undefined): boolean {
  return entry != null
    && entry.kind === "message"
    && entry.role === "user"
    && entry.fromAgent == null;
}

export function planTranscriptRewind(
  entries: readonly RewindTranscriptEntry[],
  entryId: string,
  flags: RewindFlags = {},
): RewindDecision {
  if (typeof entryId !== "string" || entryId.length === 0) {
    return { ok: false, reason: "missing-args" };
  }
  if (flags.isGroup === true || flags.isRemoteRoom === true) {
    return { ok: false, reason: "group" };
  }
  if (flags.hasSubagents === true) return { ok: false, reason: "subagents" };
  if (flags.hasPendingTools === true) return { ok: false, reason: "pending-tools" };

  const index = entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) return { ok: false, reason: "missing-entry" };
  const anchor = entries[index];
  if (anchor == null || !isRewindableUserMessage(anchor)) {
    return { ok: false, reason: "not-user-message" };
  }
  if (
    anchor.branched === true
    || (typeof anchor.replyTo === "string" && anchor.replyTo.length > 0)
    || (flags.threadDescendantCount ?? 0) > 0
  ) {
    return { ok: false, reason: "threaded" };
  }

  const kept = entries.slice(0, index);
  const dropped = entries.slice(index);
  return {
    ok: true,
    plan: {
      anchor,
      kept,
      dropped,
      droppedIds: dropped.map((entry) => entry.id),
    },
  };
}

export function keepSummaryArchivesByWindowTail(
  archives: readonly { readonly windowTail: number }[],
  keptTurnCount: number,
): readonly { readonly windowTail: number }[] {
  return archives.filter((archive) => archive.windowTail <= keptTurnCount);
}

export function archiveCoversDroppedMessage(
  summarizedMessageIds: readonly Uint8Array[],
  droppedUserMessageBlobIds: readonly Uint8Array[],
): boolean {
  for (const summarized of summarizedMessageIds) {
    for (const dropped of droppedUserMessageBlobIds) {
      if (bytesEqual(summarized, dropped)) return true;
    }
  }
  return false;
}

export interface ConversationRewindBlobStore {
  getBlob(ctx: unknown, id: Uint8Array): Promise<Uint8Array | undefined | null>;
}

export async function userMessageIdFromTurnBlob(
  turnBlob: Uint8Array,
  blobStore: ConversationRewindBlobStore,
  ctx: unknown,
): Promise<string | undefined> {
  const turn = ConversationTurnStructure.fromBinary(turnBlob);
  if (turn.turn.case !== "agentConversationTurn") return undefined;
  const userMessageId = turn.turn.value.userMessage;
  if (userMessageId.length === 0) return undefined;
  const userBlob = await blobStore.getBlob(ctx, userMessageId);
  if (userBlob == null || userBlob.length === 0) return undefined;
  const message = UserMessage.fromBinary(userBlob);
  return message.messageId.length > 0 ? message.messageId : undefined;
}

export async function turnIndexForUserMessage(
  turnBlobs: readonly Uint8Array[],
  entryId: string,
  blobStore: ConversationRewindBlobStore,
  ctx: unknown,
): Promise<number> {
  for (let index = 0; index < turnBlobs.length; index += 1) {
    const blob = turnBlobs[index];
    if (blob == null) continue;
    const messageId = await userMessageIdFromTurnBlob(blob, blobStore, ctx);
    if (messageId === entryId) return index;
  }
  return -1;
}

export interface ConversationRewindStructure {
  turns: Uint8Array[];
  summaryArchives: Uint8Array[];
  summary?: Uint8Array;
  summaryArchive?: Uint8Array;
  pendingToolCalls: string[];
  turnTimings: unknown[];
  subagentStates?: Record<string, unknown>;
  subagentStateRefs?: Record<string, Uint8Array>;
}

export async function selectKeptTurnBlobs(
  turnBlobs: readonly Uint8Array[],
  entryId: string,
  droppedIds: ReadonlySet<string>,
  keptUserCount: number,
  blobStore: ConversationRewindBlobStore,
  ctx: unknown,
): Promise<Uint8Array[]> {
  const kept: Uint8Array[] = [];
  let userTurnsKept = 0;
  for (const blob of turnBlobs) {
    const messageId = await userMessageIdFromTurnBlob(blob, blobStore, ctx);
    if (messageId != null && (messageId === entryId || droppedIds.has(messageId))) break;
    if (messageId != null && userTurnsKept >= keptUserCount) break;
    kept.push(blob);
    if (messageId != null) userTurnsKept += 1;
  }
  return kept;
}

export async function truncateConversationStructure<T extends ConversationRewindStructure>(
  structure: T,
  entryId: string,
  droppedIds: readonly string[],
  keptUserCount: number,
  blobStore: ConversationRewindBlobStore,
  ctx: unknown,
): Promise<T> {
  const dropped = new Set(droppedIds);
  const keptTurns = await selectKeptTurnBlobs(
    structure.turns,
    entryId,
    dropped,
    keptUserCount,
    blobStore,
    ctx,
  );
  const droppedTurns = structure.turns.slice(keptTurns.length);
  const droppedUserMessageBlobIds: Uint8Array[] = [];
  for (const turnBlob of droppedTurns) {
    const turn = ConversationTurnStructure.fromBinary(turnBlob);
    if (turn.turn.case === "agentConversationTurn" && turn.turn.value.userMessage.length > 0) {
      droppedUserMessageBlobIds.push(turn.turn.value.userMessage);
    }
  }
  const keptArchives: Uint8Array[] = [];
  for (const archiveId of structure.summaryArchives) {
    const archiveBlob = await blobStore.getBlob(ctx, archiveId);
    if (archiveBlob == null || archiveBlob.length === 0) continue;
    const archive = ConversationSummaryArchive.fromBinary(archiveBlob);
    if (archive.windowTail > keptTurns.length) continue;
    if (archiveCoversDroppedMessage(archive.summarizedMessages, droppedUserMessageBlobIds)) continue;
    keptArchives.push(archiveId);
  }
  structure.turns = keptTurns;
  structure.summaryArchives = keptArchives;
  delete structure.summary;
  delete structure.summaryArchive;
  structure.pendingToolCalls = [];
  if (Array.isArray(structure.turnTimings) && structure.turnTimings.length > keptTurns.length) {
    structure.turnTimings = structure.turnTimings.slice(0, keptTurns.length);
  }
  return structure;
}

export interface RewindHooks {
  readonly agentId: string;
  readonly entryId: string;
  readEntries(): readonly RewindTranscriptEntry[];
  readonly flags?: RewindFlags;
  getFlags?(): RewindFlags;
  interrupt(): Promise<void>;
  truncateConversation(plan: RewindPlan): Promise<void>;
  truncateSqlite(plan: RewindPlan): Promise<unknown>;
  rebuildJournal(plan: RewindPlan): Promise<void>;
  emitSnapshot(plan: RewindPlan): Promise<void>;
}

export async function rewindTranscriptWithHooks(
  hooks: RewindHooks,
): Promise<{ ok: true; droppedIds: readonly string[]; kept: readonly RewindTranscriptEntry[] } | { ok: false; reason: RewindRefusal }> {
  if (typeof hooks.agentId !== "string" || hooks.agentId.length === 0 || typeof hooks.entryId !== "string" || hooks.entryId.length === 0) {
    return { ok: false, reason: "missing-args" };
  }
  const flags = (): RewindFlags => hooks.getFlags?.() ?? hooks.flags ?? {};
  const first = planTranscriptRewind(hooks.readEntries(), hooks.entryId, {
    ...flags(),
    hasPendingTools: false,
  });
  if (!first.ok) return first;
  await hooks.interrupt();
  const planned = planTranscriptRewind(hooks.readEntries(), hooks.entryId, flags());
  if (!planned.ok) return planned;
  await hooks.truncateConversation(planned.plan);
  await hooks.truncateSqlite(planned.plan);
  await hooks.rebuildJournal(planned.plan);
  await hooks.emitSnapshot(planned.plan);
  return { ok: true, droppedIds: planned.plan.droppedIds, kept: planned.plan.kept };
}

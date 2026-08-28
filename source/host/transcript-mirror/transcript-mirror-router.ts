export type TranscriptMirrorRoute = "journal" | "legacy";

export interface TranscriptJournalPort<Checkpoint, Store> {
  ownsConversation(conversationId: string): Promise<boolean>;
  claimConversation(conversationId: string): Promise<void>;
  recover(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store
  ): Promise<unknown>;
  prepareCheckpoint(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store,
    finalizeCheckpoint?: boolean
  ): Promise<unknown>;
  commitCheckpoint(ctx: unknown, conversationId: string): Promise<unknown>;
  abortCheckpoint(ctx: unknown, conversationId: string): Promise<unknown>;
  skipCheckpoint(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store
  ): Promise<unknown>;
}

export interface LegacyTranscriptMirrorPort<Checkpoint, Store> {
  write(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store,
    stateBlobId: Uint8Array
  ): Promise<unknown>;
}

interface LegacyPending<Checkpoint, Store> {
  readonly checkpoint: Checkpoint;
  readonly blobStore: Store;
}

/**
 * Pins a conversation to one persistence regime while the journal experiment is
 * on. Leftover `*.journal-mode` markers must not keep routing after the
 * experiment is forced off — that path throws on the third persist.
 */
export class RoutedTranscriptMirror<Checkpoint, Store> {
  readonly legacyPending = new Map<
    string,
    LegacyPending<Checkpoint, Store>
  >();

  constructor(
    readonly journal: TranscriptJournalPort<Checkpoint, Store>,
    readonly legacy: LegacyTranscriptMirrorPort<Checkpoint, Store>,
    readonly isJournalEnabled: () => Promise<boolean>,
    readonly routes = new Map<string, Promise<TranscriptMirrorRoute>>()
  ) {}

  route(conversationId: string): Promise<TranscriptMirrorRoute> {
    const selected = this.routes.get(conversationId);
    if (selected != null) return selected;

    const route = this.selectRoute(conversationId);
    this.routes.set(conversationId, route);
    return route;
  }

  private async selectRoute(
    conversationId: string
  ): Promise<TranscriptMirrorRoute> {
    if (!await this.isJournalEnabled()) return "legacy";
    if (await this.journal.ownsConversation(conversationId)) return "journal";

    await this.journal.claimConversation(conversationId);
    return "journal";
  }

  async recover(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store
  ): Promise<void> {
    if (await this.route(conversationId) !== "journal") return;
    await this.journal.recover(ctx, conversationId, checkpoint, blobStore);
  }

  async prepareCheckpoint(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store,
    finalizeCheckpoint = false,
    writeLegacyCheckpoint = finalizeCheckpoint
  ): Promise<void> {
    if (await this.route(conversationId) === "journal") {
      await this.journal.prepareCheckpoint(
        ctx,
        conversationId,
        checkpoint,
        blobStore,
        finalizeCheckpoint
      );
      return;
    }

    if (writeLegacyCheckpoint) {
      this.legacyPending.set(conversationId, { checkpoint, blobStore });
    }
  }

  async commitCheckpoint(
    ctx: unknown,
    conversationId: string,
    stateBlobId: Uint8Array
  ): Promise<void> {
    if (await this.route(conversationId) === "journal") {
      await this.journal.commitCheckpoint(ctx, conversationId);
      return;
    }

    const pending = this.legacyPending.get(conversationId);
    if (pending == null) return;
    this.legacyPending.delete(conversationId);

    // The legacy mirror is observational. Failure must not roll back a durable
    // agent-store checkpoint or fail the turn.
    await this.legacy.write(
      ctx,
      conversationId,
      pending.checkpoint,
      pending.blobStore,
      stateBlobId
    ).then(
      () => undefined,
      () => undefined
    );
  }

  async abortCheckpoint(
    ctx: unknown,
    conversationId: string
  ): Promise<void> {
    if (await this.route(conversationId) === "journal") {
      await this.journal.abortCheckpoint(ctx, conversationId);
      return;
    }
    this.legacyPending.delete(conversationId);
  }

  async skipCheckpoint(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store
  ): Promise<void> {
    let selected = this.routes.get(conversationId);
    let recoverOwnedJournal = false;

    if (selected == null) {
      if (!await this.isJournalEnabled() || !await this.journal.ownsConversation(conversationId)) {
        this.legacyPending.delete(conversationId);
        return;
      }

      recoverOwnedJournal = true;
      selected = Promise.resolve("journal");
      this.routes.set(conversationId, selected);
    }

    if (await selected === "journal") {
      if (recoverOwnedJournal) {
        await this.journal.recover(
          ctx,
          conversationId,
          checkpoint,
          blobStore
        );
      }
      await this.journal.skipCheckpoint(
        ctx,
        conversationId,
        checkpoint,
        blobStore
      );
      return;
    }

    this.legacyPending.delete(conversationId);
  }

}

// Compatibility names used by earlier recovered modules.
export type TranscriptMirrorPort<Checkpoint, Store> =
  TranscriptJournalPort<Checkpoint, Store>;
export type LegacyMirrorPort<Checkpoint, Store> =
  LegacyTranscriptMirrorPort<Checkpoint, Store>;

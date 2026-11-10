import type { ManagedMessage, ManagedMessageDraft } from "../../types";

export interface ManagedMessageMissingResult {
  message: ManagedMessage;
  changed: boolean;
}

export interface ManagedMessageCanonicalDeleteAudit {
  eventKey: string;
  guildId: string;
  channelId: string;
  messageId: string;
  internalName: string;
}

export type ManagedMessageAuditClaimResult =
  | { status: "claimed"; event: ManagedMessageCanonicalDeleteAudit; claimedAtMs: number }
  | { status: "busy" }
  | { status: "delivered" }
  | { status: "missing" };

export interface ManagedMessageDraftClaim {
  draft: ManagedMessageDraft;
  claimedAtMs: number;
}

export interface ManagedMessageStore {
  registerMediaAsset(guildId: string, filename: string, createdAtMs?: number): Promise<void>;
  listPendingMediaAssets(guildId: string): Promise<string[]>;
  deleteMediaAsset(guildId: string, filename: string): Promise<void>;
  /** Atomically claims an unreferenced asset for remote deletion. */
  claimMediaAssetDeletion(guildId: string, filename: string): Promise<boolean>;
  syncMediaReferences(
    guildId: string,
    ownerType: "draft" | "message",
    ownerId: string,
    filenames: string[],
  ): Promise<string[]>;
  deleteMediaReferences(
    guildId: string,
    ownerType: "draft" | "message",
    ownerId: string,
  ): Promise<string[]>;
  listByGuild(guildId: string): Promise<ManagedMessage[]>;
  listDraftsByGuild(guildId: string): Promise<ManagedMessageDraft[]>;
  readById(guildId: string, id: string): Promise<ManagedMessage | null>;
  readDraftById(guildId: string, id: string): Promise<ManagedMessageDraft | null>;
  readByCanonicalMessage(
    guildId: string,
    channelId: string,
    messageId: string,
  ): Promise<ManagedMessage | null>;
  countByGuild(guildId: string): Promise<number>;
  countDraftsByGuild(guildId: string): Promise<number>;
  upsert(message: ManagedMessage, mediaFilenames?: string[]): Promise<string[]>;
  upsertDraft(draft: ManagedMessageDraft, mediaFilenames?: string[]): Promise<string[]>;
  claimDueDrafts(nowMs: number, limit: number): Promise<ManagedMessageDraftClaim[]>;
  recordDraftPublicationFailure(
    guildId: string,
    draftId: string,
    claimedAtMs: number,
    attemptCount: number,
    failureReason: string,
    retryAtMs: number | null,
    updatedAtMs: number,
  ): Promise<ManagedMessageDraft | null>;
  publishDraft(
    guildId: string,
    draftId: string,
    message: ManagedMessage,
    mediaFilenames?: string[],
  ): Promise<void>;
  markMissingByCanonicalMessage(
    guildId: string,
    channelId: string,
    messageId: string,
    updatedAtMs?: number,
  ): Promise<ManagedMessageMissingResult | null>;
  claimCanonicalMessageDeleteAudit(
    guildId: string,
    channelId: string,
    messageId: string,
    claimedAtMs?: number,
  ): Promise<ManagedMessageAuditClaimResult>;
  markCanonicalMessageDeleteAuditDelivered(
    eventKey: string,
    claimedAtMs: number,
    deliveredAtMs?: number,
  ): Promise<void>;
  releaseCanonicalMessageDeleteAuditClaim(eventKey: string, claimedAtMs: number): Promise<void>;
  /** Removes the entity and its media refs, returning refs made orphaned by the deletion. */
  delete(guildId: string, id: string): Promise<string[]>;
  /** Removes the draft and its media refs, returning refs made orphaned by the deletion. */
  deleteDraft(guildId: string, id: string): Promise<string[]>;
}

import {
  createChannelMessage,
  deleteChannelMessage,
  editChannelMessage,
  type CreateChannelMessageInput,
  type DiscordEmbed,
} from "../discord/messages";
import { DiscordApiError } from "../discord/client";
import { parseButtonEmoji } from "../discord/emoji";
import {
  getGuildEntitlementLimits,
  type ManagedMessage,
  type ManagedMessageAnnouncement,
  type ManagedMessageDraft,
  type ManagedMessageEmbed,
  type ManagedMessageLinkButton,
} from "../types";
import type {
  GuildAuditLogStore,
  GuildEntitlementStore,
  ManagedMessageStore,
} from "../runtime/contracts";
import type { OperationalIncidentReporter } from "../operations/incidents";
import { isAtLimit, QuantityLimitError } from "../runtime/entitlement-checks";
import {
  postManagedMessageAuditEvent,
  postManagedMessageAuditEventOrThrow,
} from "./guild-audit-log-service";
import { parseManagedMediaPath, type PublicManagedMediaStore } from "../managed-media";

export interface ManagedMessageSaveInput {
  guildId: string;
  id?: string | null;
  internalName: string;
  channelId: string;
  embeds: ManagedMessageEmbed[];
  buttons?: ManagedMessageLinkButton[];
  announcement: ManagedMessageAnnouncement;
}

export interface ManagedMessageDiscordAdapter {
  create(channelId: string, body: CreateChannelMessageInput): Promise<{ id: string }>;
  edit(channelId: string, messageId: string, body: CreateChannelMessageInput): Promise<unknown>;
  delete(channelId: string, messageId: string): Promise<void>;
}

export interface ManagedMessageGuildResourcesAdapter {
  read(guildId: string): Promise<{
    textChannelIds: string[];
    roleIds: string[];
  }>;
}

export interface ManagedMessageServiceOptions {
  store: ManagedMessageStore;
  guildEntitlements: GuildEntitlementStore;
  guildAuditLog: GuildAuditLogStore;
  discordBotToken: string;
  discord?: ManagedMessageDiscordAdapter;
  guildResources: ManagedMessageGuildResourcesAdapter;
  operationalIncidents?: OperationalIncidentReporter;
  managedMedia?: PublicManagedMediaStore;
}

export class ManagedMessageError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ManagedMessageError";
  }
}

export class ManagedMessageService {
  private readonly discord: ManagedMessageDiscordAdapter;

  constructor(private readonly options: ManagedMessageServiceOptions) {
    this.discord = options.discord ?? {
      create: (channelId, body) => createChannelMessage(channelId, body, options.discordBotToken),
      edit: (channelId, messageId, body) =>
        editChannelMessage(channelId, messageId, body, options.discordBotToken),
      delete: (channelId, messageId) =>
        deleteChannelMessage(channelId, messageId, options.discordBotToken),
    };
  }

  list(guildId: string): Promise<ManagedMessage[]> {
    return this.options.store.listByGuild(guildId);
  }

  listDrafts(guildId: string): Promise<ManagedMessageDraft[]> {
    return this.options.store.listDraftsByGuild(guildId);
  }

  async registerMediaAsset(guildId: string, filename: string): Promise<void> {
    await this.options.store.registerMediaAsset(guildId, filename);
  }

  async get(guildId: string, id: string): Promise<ManagedMessage | null> {
    return this.options.store.readById(guildId, id);
  }

  async saveDraft(input: ManagedMessageSaveInput): Promise<ManagedMessageDraft> {
    const draft = await this.persistDraft(input);
    await this.observeManagedMessageHealthy(draft.guildId, draft.id);
    return draft;
  }

  async scheduleDraft(
    input: ManagedMessageSaveInput,
    scheduledAtMs: number,
    actorUserId?: string,
  ): Promise<ManagedMessageDraft> {
    if (scheduledAtMs <= Date.now()) {
      throw new ManagedMessageError("Scheduled Publish must be in the future.");
    }
    const existing = input.id
      ? await this.options.store.readDraftById(input.guildId, input.id)
      : null;
    const draft = await this.persistDraft(input, scheduledAtMs);
    await this.postDraftLifecycleAudit(
      existing?.status === "scheduled" ? "managed-message.reschedule" : "managed-message.schedule",
      draft,
      actorUserId,
    );
    await this.observeManagedMessageHealthy(draft.guildId, draft.id);
    return draft;
  }

  private async persistDraft(
    input: ManagedMessageSaveInput,
    scheduledAtMs?: number,
  ): Promise<ManagedMessageDraft> {
    const normalized = normalizeSaveInput(input);
    validateManagedMessage(normalized);

    const existing = normalized.id
      ? await this.options.store.readDraftById(normalized.guildId, normalized.id)
      : null;
    if (normalized.id && !existing) {
      throw new ManagedMessageError("Managed Message Draft was not found.", 404);
    }

    const guildResources = await this.options.guildResources.read(normalized.guildId);
    if (!guildResources.textChannelIds.includes(normalized.channelId)) {
      throw new ManagedMessageError("The destination channel is not a text channel in this Guild.");
    }
    const invalidRoleId = normalized.announcement.roleIds.find(
      (roleId) => !guildResources.roleIds.includes(roleId),
    );
    if (invalidRoleId) {
      throw new ManagedMessageError(
        `The announcement role is not in this Guild: ${invalidRoleId}.`,
      );
    }

    const [messages, drafts] = await Promise.all([
      this.options.store.listByGuild(normalized.guildId),
      this.options.store.listDraftsByGuild(normalized.guildId),
    ]);
    const normalizedName = normalized.internalName.toLocaleLowerCase();
    const duplicateMessage = messages.some(
      (message) => message.internalName.toLocaleLowerCase() === normalizedName,
    );
    const duplicateDraft = drafts.some(
      (draft) =>
        draft.id !== existing?.id && draft.internalName.toLocaleLowerCase() === normalizedName,
    );
    if (duplicateMessage || duplicateDraft) {
      throw new ManagedMessageError("Internal name must be unique within this Guild.");
    }

    if (!existing) {
      const entitlement = await this.options.guildEntitlements.readGuildEntitlement(
        normalized.guildId,
      );
      const max = getGuildEntitlementLimits(entitlement.tier).managedMessagesMax;
      if (isAtLimit(messages.length + drafts.length, max)) {
        throw new QuantityLimitError(
          "Free-tier Guilds can create up to 3 combined Managed Message Drafts and Managed Messages. Upgrade to premium for unlimited Managed Messages.",
        );
      }
    }

    const now = Date.now();
    const draft: ManagedMessageDraft = {
      id: existing?.id ?? createManagedMessageId(),
      guildId: normalized.guildId,
      internalName: normalized.internalName,
      channelId: normalized.channelId,
      embeds: normalized.embeds,
      buttons: normalized.buttons,
      announcement: normalized.announcement,
      status:
        scheduledAtMs !== undefined || existing?.status === "scheduled" ? "scheduled" : "draft",
      scheduledAtMs:
        scheduledAtMs ?? (existing?.status === "scheduled" ? existing.scheduledAtMs : null),
      failureReason: null,
      attemptCount:
        scheduledAtMs === undefined && existing?.status === "scheduled" ? existing.attemptCount : 0,
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    };
    await this.retireMedia(
      draft.guildId,
      await this.options.store.upsertDraft(
        draft,
        extractManagedMediaFilenames(draft.guildId, draft.embeds),
      ),
    );
    return draft;
  }

  async publishDraftNow(
    guildId: string,
    draftId: string,
    actorUserId?: string,
  ): Promise<ManagedMessage> {
    const draft = await this.options.store.readDraftById(guildId, draftId);
    if (!draft) throw new ManagedMessageError("Managed Message Draft was not found.", 404);

    const guildResources = await this.options.guildResources.read(guildId);
    if (!guildResources.textChannelIds.includes(draft.channelId)) {
      throw new ManagedMessageError("The destination channel is not a text channel in this Guild.");
    }

    const now = Date.now();
    const message: ManagedMessage = {
      id: draft.id,
      guildId: draft.guildId,
      internalName: draft.internalName,
      channelId: draft.channelId,
      messageId: "",
      embeds: draft.embeds,
      buttons: draft.buttons,
      announcement: draft.announcement,
      status: "published",
      createdAtMs: draft.createdAtMs,
      updatedAtMs: now,
    };
    const discordMessage = await this.discord.create(
      message.channelId,
      buildDiscordBody(message, true),
    );
    const published = { ...message, messageId: discordMessage.id };
    try {
      await this.options.store.publishDraft(
        guildId,
        draftId,
        published,
        extractManagedMediaFilenames(guildId, published.embeds),
      );
    } catch (error) {
      await compensateDelete(
        () => this.discord.delete(published.channelId, published.messageId),
        error,
        "draft publication",
      );
    }
    await this.postLifecycleAudit("managed-message.publish", published, actorUserId);
    await this.observeManagedMessageHealthy(published.guildId, published.id);
    return published;
  }

  async cancelScheduledDraft(
    guildId: string,
    draftId: string,
    actorUserId?: string,
  ): Promise<ManagedMessageDraft> {
    const existing = await this.options.store.readDraftById(guildId, draftId);
    if (!existing) throw new ManagedMessageError("Managed Message Draft was not found.", 404);
    const draft: ManagedMessageDraft = {
      ...existing,
      status: "draft",
      scheduledAtMs: null,
      failureReason: null,
      attemptCount: 0,
      updatedAtMs: Date.now(),
    };
    await this.options.store.upsertDraft(
      draft,
      extractManagedMediaFilenames(draft.guildId, draft.embeds),
    );
    await this.postDraftLifecycleAudit("managed-message.cancel", draft, actorUserId);
    await this.observeManagedMessageHealthy(guildId, draftId);
    return draft;
  }

  async deleteDraft(guildId: string, draftId: string, actorUserId?: string): Promise<boolean> {
    const existing = await this.options.store.readDraftById(guildId, draftId);
    if (!existing) {
      await this.retireMedia(guildId, []);
      return false;
    }
    const retiredMedia = await this.options.store.deleteDraft(guildId, draftId);
    await this.retireMedia(guildId, retiredMedia);
    await this.postDraftLifecycleAudit("managed-message.draft-delete", existing, actorUserId);
    await this.observeManagedMessageHealthy(guildId, draftId);
    return true;
  }

  async processScheduledDrafts(
    nowMs = Date.now(),
    limit = 25,
  ): Promise<{ published: number; failed: number; retrying: number }> {
    const claims = await this.options.store.claimDueDrafts(nowMs, limit);
    const result = { published: 0, failed: 0, retrying: 0 };
    for (const claim of claims) {
      try {
        await this.publishDraftNow(claim.draft.guildId, claim.draft.id);
        result.published += 1;
      } catch (error) {
        const attemptCount = claim.draft.attemptCount + 1;
        const retrying = isTransientScheduledPublishError(error) && attemptCount < 3;
        const retryAtMs = retrying
          ? nowMs + scheduledPublishRetryDelayMs(attemptCount, error)
          : null;
        await this.options.store.recordDraftPublicationFailure(
          claim.draft.guildId,
          claim.draft.id,
          claim.claimedAtMs,
          attemptCount,
          describeError(error),
          retryAtMs,
          nowMs,
        );
        if (retrying) result.retrying += 1;
        else {
          result.failed += 1;
          await this.postDraftLifecycleAudit(
            "managed-message.publish-failed",
            {
              ...claim.draft,
              status: "failed",
              failureReason: describeError(error),
            },
            undefined,
          );
          await this.options.operationalIncidents?.observeFailure({
            guildId: claim.draft.guildId,
            key: {
              feature: "managed-messages",
              resourceKind: "draft",
              resourceId: claim.draft.id,
              condition: "scheduled-publish-failed",
            },
            observationId: `scheduled-publish:${claim.draft.id}:${attemptCount}`,
            summaryCode: "managed_message_scheduled_publish_failed",
            safeArgs: {
              draftId: claim.draft.id,
              attemptCount,
              failureCategory: safeScheduledPublishFailureCategory(error),
              scheduledAtMs: claim.draft.scheduledAtMs,
            },
            remediationCode: "retry_managed_message_draft",
          });
        }
      }
    }
    return result;
  }

  async save(
    input: ManagedMessageSaveInput,
    actorUserId?: string,
    republish = false,
  ): Promise<ManagedMessage> {
    const normalized = normalizeSaveInput(input);
    validateManagedMessage(normalized);

    let existing = normalized.id
      ? await this.options.store.readById(normalized.guildId, normalized.id)
      : null;
    if (normalized.id && !existing) {
      throw new ManagedMessageError("Managed Message was not found.", 404);
    }
    if (existing && existing.channelId !== normalized.channelId) {
      throw new ManagedMessageError(
        "A Managed Message's destination channel cannot change after its first Save.",
      );
    }
    if (existing?.status === "unpublishing") {
      existing = await this.unpublish(existing.guildId, existing.id, actorUserId);
    }

    const guildResources = await this.options.guildResources.read(normalized.guildId);
    if (!guildResources.textChannelIds.includes(normalized.channelId)) {
      throw new ManagedMessageError("The destination channel is not a text channel in this Guild.");
    }
    const invalidRoleId = normalized.announcement.roleIds.find(
      (roleId) => !guildResources.roleIds.includes(roleId),
    );
    if (invalidRoleId) {
      throw new ManagedMessageError(
        `The announcement role is not in this Guild: ${invalidRoleId}.`,
      );
    }

    const [allMessages, allDrafts] = await Promise.all([
      this.options.store.listByGuild(normalized.guildId),
      this.options.store.listDraftsByGuild(normalized.guildId),
    ]);
    const duplicate = allMessages.find(
      (message) =>
        message.id !== existing?.id &&
        message.internalName.toLocaleLowerCase() === normalized.internalName.toLocaleLowerCase(),
    );
    const duplicateDraft = allDrafts.find(
      (draft) =>
        draft.internalName.toLocaleLowerCase() === normalized.internalName.toLocaleLowerCase(),
    );
    if (duplicate || duplicateDraft) {
      throw new ManagedMessageError("Internal name must be unique within this Guild.");
    }

    if (!existing) {
      const entitlement = await this.options.guildEntitlements.readGuildEntitlement(
        normalized.guildId,
      );
      const max = getGuildEntitlementLimits(entitlement.tier).managedMessagesMax;
      if (isAtLimit(allMessages.length + allDrafts.length, max)) {
        throw new QuantityLimitError(
          "Free-tier Guilds can create up to 3 combined Managed Message Drafts and Managed Messages. Upgrade to premium for unlimited Managed Messages.",
        );
      }
    }

    const now = Date.now();
    const nextBase: ManagedMessage = {
      id: existing?.id ?? createManagedMessageId(),
      guildId: normalized.guildId,
      internalName: normalized.internalName,
      channelId: existing?.channelId ?? normalized.channelId,
      messageId: existing?.messageId ?? "",
      embeds: normalized.embeds,
      buttons: normalized.buttons,
      announcement: normalized.announcement,
      status: "published",
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    };

    if (!existing) {
      const discordMessage = await this.discord.create(
        nextBase.channelId,
        buildDiscordBody(nextBase, true),
      );
      const created = { ...nextBase, messageId: discordMessage.id };
      let retiredMedia: string[] = [];
      try {
        retiredMedia = await this.options.store.upsert(
          created,
          extractManagedMediaFilenames(created.guildId, created.embeds),
        );
      } catch (error) {
        await compensateDelete(
          () => this.discord.delete(created.channelId, created.messageId),
          error,
          "creation",
        );
      }
      await this.retireMedia(created.guildId, retiredMedia);
      await this.postLifecycleAudit("managed-message.create", created, actorUserId);
      return created;
    }

    if (existing.status === "unpublished" && !republish) {
      const saved = { ...nextBase, status: "unpublished" as const, messageId: "" };
      const retiredMedia = await this.options.store.upsert(
        saved,
        extractManagedMediaFilenames(saved.guildId, saved.embeds),
      );
      await this.retireMedia(saved.guildId, retiredMedia);
      return saved;
    }

    if (existing.status === "missing" || existing.status === "unpublished") {
      const discordMessage = await this.discord.create(
        existing.channelId,
        buildDiscordBody(nextBase, false),
      );
      const repaired = { ...nextBase, messageId: discordMessage.id };
      let retiredMedia: string[] = [];
      try {
        retiredMedia = await this.options.store.upsert(
          repaired,
          extractManagedMediaFilenames(repaired.guildId, repaired.embeds),
        );
      } catch (error) {
        await compensateDelete(
          () => this.discord.delete(repaired.channelId, repaired.messageId),
          error,
          "repair",
        );
      }
      await this.retireMedia(repaired.guildId, retiredMedia);
      await this.postLifecycleAudit(
        existing.status === "unpublished" ? "managed-message.publish" : "managed-message.repair",
        repaired,
        actorUserId,
        existing,
      );
      await this.observeManagedMessageHealthy(repaired.guildId, repaired.id);
      return repaired;
    }

    let publication: { kind: "editing" | "edited" | "recreated"; messageId: string } = {
      kind: "editing",
      messageId: existing.messageId,
    };
    try {
      await this.discord.edit(
        existing.channelId,
        existing.messageId,
        buildDiscordBody(nextBase, false),
      );
      publication = { kind: "edited", messageId: existing.messageId };
    } catch (error) {
      if (!(error instanceof DiscordApiError) || error.status !== 404) throw error;
      await this.options.store.markMissingByCanonicalMessage(
        existing.guildId,
        existing.channelId,
        existing.messageId,
      );
      await this.options.operationalIncidents?.observeFailure({
        guildId: existing.guildId,
        key: {
          feature: "managed-messages",
          resourceKind: "message",
          resourceId: existing.id,
          condition: "canonical-message-missing",
        },
        observationId: `canonical-missing:${existing.messageId}`,
        summaryCode: "managed_message_canonical_missing",
        safeArgs: { managedMessageId: existing.id },
        remediationCode: "republish_managed_message",
      });
      const discordMessage = await this.discord.create(
        existing.channelId,
        buildDiscordBody(nextBase, false),
      );
      publication = { kind: "recreated", messageId: discordMessage.id };
    }

    const updated = { ...nextBase, messageId: publication.messageId };
    let retiredMedia: string[] = [];
    try {
      retiredMedia = await this.options.store.upsert(
        updated,
        extractManagedMediaFilenames(updated.guildId, updated.embeds),
      );
    } catch (error) {
      if (publication.kind === "recreated") {
        await compensateDelete(
          () => this.discord.delete(updated.channelId, updated.messageId),
          error,
          "update repair",
        );
      } else {
        await compensateEdit(
          () =>
            this.discord.edit(
              existing.channelId,
              existing.messageId,
              buildDiscordBody(existing, false),
            ),
          error,
          "update",
        );
      }
    }
    await this.retireMedia(updated.guildId, retiredMedia);

    await this.postLifecycleAudit(
      publication.kind === "recreated" ? "managed-message.repair" : "managed-message.update",
      updated,
      actorUserId,
      publication.kind === "recreated" ? existing : undefined,
    );
    await this.observeManagedMessageHealthy(updated.guildId, updated.id);
    return updated;
  }

  async repairMissing(guildId: string, id: string, actorUserId?: string): Promise<ManagedMessage> {
    const existing = await this.options.store.readById(guildId, id);
    if (!existing) throw new ManagedMessageError("Managed Message was not found.", 404);
    return this.save(
      {
        guildId,
        id,
        internalName: existing.internalName,
        channelId: existing.channelId,
        embeds: existing.embeds,
        buttons: existing.buttons,
        announcement: existing.announcement,
      },
      actorUserId,
    );
  }

  async unpublish(guildId: string, id: string, actorUserId?: string): Promise<ManagedMessage> {
    const existing = await this.options.store.readById(guildId, id);
    if (!existing) throw new ManagedMessageError("Managed Message was not found.", 404);
    if (existing.status === "unpublished") return existing;
    const pending = { ...existing, status: "unpublishing" as const, updatedAtMs: Date.now() };
    const media = extractManagedMediaFilenames(guildId, existing.embeds);
    // Keep the old Discord ID until removal is confirmed. A retry after a crash
    // or lost response resumes this phase, including when Publish or Delete is used.
    if (existing.status !== "unpublishing") await this.options.store.upsert(pending, media);
    try {
      await this.discord.delete(existing.channelId, existing.messageId);
    } catch (error) {
      if (!(error instanceof DiscordApiError && error.status === 404)) throw error;
    }
    const unpublished = { ...pending, status: "unpublished" as const, updatedAtMs: Date.now() };
    await this.options.store.upsert(unpublished, media);
    await this.postLifecycleAudit("managed-message.unpublish", unpublished, actorUserId);
    await this.observeManagedMessageHealthy(guildId, id);
    return unpublished;
  }

  async delete(guildId: string, id: string, actorUserId?: string): Promise<boolean> {
    const existing = await this.options.store.readById(guildId, id);
    if (!existing) {
      await this.retireMedia(guildId, []);
      return false;
    }
    if (existing.status === "unpublishing") await this.unpublish(guildId, id, actorUserId);

    const retiredMedia = await this.options.store.delete(guildId, id);
    try {
      if (existing.status === "published") {
        await this.discord.delete(existing.channelId, existing.messageId);
      }
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) {
        await this.retireMedia(guildId, retiredMedia);
        await this.postLifecycleAudit("managed-message.delete", existing, actorUserId);
        await this.observeManagedMessageHealthy(guildId, id);
        return true;
      }
      try {
        await this.options.store.upsert(
          existing,
          extractManagedMediaFilenames(guildId, existing.embeds),
        );
      } catch (compensationError) {
        throw new Error(
          `Managed Message deletion failed and restoring its record also failed: ${describeError(error)}; ${describeError(compensationError)}`,
        );
      }
      throw error;
    }

    await this.postLifecycleAudit("managed-message.delete", existing, actorUserId);
    await this.retireMedia(guildId, retiredMedia);
    await this.observeManagedMessageHealthy(guildId, id);
    return true;
  }

  private async retireMedia(guildId: string, filenames: string[]): Promise<void> {
    if (!this.options.managedMedia) return;
    const pending = await this.options.store.listPendingMediaAssets(guildId);
    for (const filename of new Set([...pending, ...filenames])) {
      if (!(await this.options.store.claimMediaAssetDeletion(guildId, filename))) continue;
      await this.options.managedMedia.deleteImage({
        guildId,
        filename,
      });
      // Keep the asset row until both the R2 object and quota tombstone have
      // been written successfully. A failed delete remains pending for retry.
      await this.options.store.deleteMediaAsset(guildId, filename);
    }
  }

  private async postLifecycleAudit(
    eventId:
      | "managed-message.create"
      | "managed-message.update"
      | "managed-message.unpublish"
      | "managed-message.delete"
      | "managed-message.deleted-out-of-band"
      | "managed-message.repair"
      | "managed-message.publish",
    message: ManagedMessage,
    actorUserId?: string,
    previous?: ManagedMessage,
  ): Promise<void> {
    await postManagedMessageAuditEvent(
      eventId,
      {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.messageId,
        internalName: message.internalName,
        actorUserId,
        previousMessageId: previous?.messageId,
      },
      this.options.guildAuditLog,
      this.options.discordBotToken,
    );
  }

  private async postDraftLifecycleAudit(
    eventId:
      | "managed-message.schedule"
      | "managed-message.reschedule"
      | "managed-message.cancel"
      | "managed-message.publish-failed"
      | "managed-message.draft-delete",
    draft: ManagedMessageDraft,
    actorUserId?: string,
  ): Promise<void> {
    await postManagedMessageAuditEvent(
      eventId,
      {
        guildId: draft.guildId,
        channelId: draft.channelId,
        internalName: draft.internalName,
        actorUserId,
        ...(draft.scheduledAtMs === null ? {} : { scheduledAtMs: draft.scheduledAtMs }),
        ...(draft.failureReason ? { failureReason: draft.failureReason } : {}),
      },
      this.options.guildAuditLog,
      this.options.discordBotToken,
    );
  }

  private async observeManagedMessageHealthy(guildId: string, id: string): Promise<void> {
    await this.options.operationalIncidents?.observeHealthy({
      guildId,
      key: {
        feature: "managed-messages",
        resourceKind: "message",
        resourceId: id,
        condition: "canonical-message-missing",
      },
    });
    await this.options.operationalIncidents?.observeHealthy({
      guildId,
      key: {
        feature: "managed-messages",
        resourceKind: "draft",
        resourceId: id,
        condition: "scheduled-publish-failed",
      },
    });
  }
}

export async function handleManagedMessageCanonicalDelete(
  input: { guildId: string; channelId: string; messageId: string },
  options: {
    store: ManagedMessageStore;
    guildAuditLog: GuildAuditLogStore;
    discordBotToken: string;
    operationalIncidents?: OperationalIncidentReporter;
  },
): Promise<boolean> {
  const result = await options.store.markMissingByCanonicalMessage(
    input.guildId,
    input.channelId,
    input.messageId,
  );
  if (result) {
    await options.operationalIncidents?.observeFailure({
      guildId: input.guildId,
      key: {
        feature: "managed-messages",
        resourceKind: "message",
        resourceId: result.message.id,
        condition: "canonical-message-missing",
      },
      observationId: `canonical-missing:${input.messageId}`,
      summaryCode: "managed_message_canonical_missing",
      safeArgs: { managedMessageId: result.message.id },
      remediationCode: "republish_managed_message",
    });
  }
  const claim = await options.store.claimCanonicalMessageDeleteAudit(
    input.guildId,
    input.channelId,
    input.messageId,
  );
  if (claim.status === "missing") return result !== null;
  if (claim.status === "busy") {
    throw new Error("Managed Message deletion audit delivery is already in progress.");
  }
  if (claim.status === "delivered") return true;

  try {
    await postManagedMessageAuditEventOrThrow(
      "managed-message.deleted-out-of-band",
      {
        guildId: claim.event.guildId,
        channelId: claim.event.channelId,
        messageId: claim.event.messageId,
        internalName: claim.event.internalName,
      },
      options.guildAuditLog,
      options.discordBotToken,
      claim.event.messageId,
    );
    await options.store.markCanonicalMessageDeleteAuditDelivered(
      claim.event.eventKey,
      claim.claimedAtMs,
    );
  } catch (error) {
    await options.store.releaseCanonicalMessageDeleteAuditClaim(
      claim.event.eventKey,
      claim.claimedAtMs,
    );
    throw error;
  }
  return true;
}

function normalizeSaveInput(input: ManagedMessageSaveInput): ManagedMessageSaveInput {
  return {
    ...input,
    guildId: input.guildId.trim(),
    id: input.id?.trim() || null,
    internalName: input.internalName.trim(),
    channelId: input.channelId.trim(),
    embeds: normalizeManagedMessageEmbeds(input.embeds),
    buttons: (input.buttons ?? []).map((button) => ({
      label: button.label.trim(),
      url: button.url.trim(),
      ...(button.emoji?.trim() ? { emoji: button.emoji.trim() } : {}),
    })),
    announcement: {
      roleIds: [...new Set(input.announcement.roleIds.map((roleId) => roleId.trim()))].filter(
        Boolean,
      ),
      everyone: input.announcement.everyone === true,
      here: input.announcement.here === true,
      notifyOnCreate: input.announcement.notifyOnCreate === true,
    },
  };
}

function extractManagedMediaFilenames(guildId: string, embeds: ManagedMessageEmbed[]): string[] {
  const filenames: string[] = [];
  for (const embed of embeds) {
    for (const value of [embed.imageUrl, embed.thumbnailUrl]) {
      if (!value) continue;
      try {
        const parsed = parseManagedMediaPath(new URL(value).pathname);
        if (parsed?.guildId === guildId) filenames.push(parsed.filename);
      } catch {
        // Validation reports malformed URLs; non-managed URLs are not owned by HAF.
      }
    }
  }
  return [...new Set(filenames)];
}

export function normalizeManagedMessageEmbeds(
  embeds: ManagedMessageEmbed[],
): ManagedMessageEmbed[] {
  return embeds.map((embed) => ({
    ...embed,
    title: embed.title?.trim() || undefined,
    color: typeof embed.color === "number" ? embed.color : undefined,
    description: embed.description.trim(),
    imageUrl: embed.imageUrl?.trim() || undefined,
    thumbnailUrl: embed.thumbnailUrl?.trim() || undefined,
    footer: embed.footer?.trim() || undefined,
    fields: embed.fields.map((field) => ({
      name: field.name.trim(),
      value: field.value.trim(),
      inline: field.inline === true,
    })),
  }));
}

export function validateManagedMessage(input: ManagedMessageSaveInput): void {
  if (!input.guildId) throw new ManagedMessageError("Missing guildId.");
  if (!input.internalName || input.internalName.length > 100) {
    throw new ManagedMessageError("Internal name is required and must be 100 characters or fewer.");
  }
  if (!input.channelId) throw new ManagedMessageError("Choose a destination channel.");
  validateManagedMessageEmbeds(input.embeds);
  validateManagedMessageButtons(input.buttons ?? []);
  const announcementContent = buildAnnouncementContent(input.announcement);
  if (announcementContent && announcementContent.length > 2000) {
    throw new ManagedMessageError("The announcement line cannot exceed 2,000 characters.");
  }
}

export function validateManagedMessageButtons(buttons: ManagedMessageLinkButton[]): void {
  if (buttons.length > 5) {
    throw new ManagedMessageError("A Managed Message cannot contain more than 5 link buttons.");
  }
  for (const [index, button] of buttons.entries()) {
    if (!button.label || button.label.length > 80) {
      throw new ManagedMessageError(
        `Link button ${index + 1} needs a label of 80 characters or fewer.`,
      );
    }
    if (!button.url || button.url.length > 512) {
      throw new ManagedMessageError(
        `Link button ${index + 1} needs a URL of 512 characters or fewer.`,
      );
    }
    validateUrl(button.url, `Link button ${index + 1} URL`);
    assertLength(button.emoji, 100, `Link button ${index + 1} emoji`);
  }
}

export function validateManagedMessageEmbeds(embeds: ManagedMessageEmbed[]): void {
  if (embeds.length < 1 || embeds.length > 10) {
    throw new ManagedMessageError("A Managed Message must contain between 1 and 10 embeds.");
  }

  let combinedCharacters = 0;
  for (const [embedIndex, embed] of embeds.entries()) {
    if (!embed.description) {
      throw new ManagedMessageError(`Embed ${embedIndex + 1} needs a description.`);
    }
    assertLength(embed.title, 256, `Embed ${embedIndex + 1} title`);
    assertLength(embed.description, 4096, `Embed ${embedIndex + 1} description`);
    assertLength(embed.footer, 2048, `Embed ${embedIndex + 1} footer`);
    validateUrl(embed.imageUrl, `Embed ${embedIndex + 1} image URL`);
    validateUrl(embed.thumbnailUrl, `Embed ${embedIndex + 1} thumbnail URL`);
    if (
      embed.color !== undefined &&
      (!Number.isInteger(embed.color) || embed.color < 0 || embed.color > 0xffffff)
    ) {
      throw new ManagedMessageError(
        `Embed ${embedIndex + 1} colour must be a Discord colour value.`,
      );
    }
    if (embed.fields.length > 25) {
      throw new ManagedMessageError(`Embed ${embedIndex + 1} cannot contain more than 25 fields.`);
    }
    combinedCharacters += embed.title?.length ?? 0;
    combinedCharacters += embed.description.length;
    combinedCharacters += embed.footer?.length ?? 0;
    for (const field of embed.fields) {
      assertLength(field.name, 256, `Embed ${embedIndex + 1} field name`);
      assertLength(field.value, 1024, `Embed ${embedIndex + 1} field value`);
      if (!field.name || !field.value) {
        throw new ManagedMessageError(`Embed ${embedIndex + 1} fields need names and values.`);
      }
      combinedCharacters += field.name.length + field.value.length;
    }
  }
  if (combinedCharacters > 6000) {
    throw new ManagedMessageError(
      "The combined text across all embeds cannot exceed 6,000 characters.",
    );
  }
}

function assertLength(value: string | undefined, max: number, label: string): void {
  if (value !== undefined && value.length > max) {
    throw new ManagedMessageError(`${label} cannot exceed ${max} characters.`);
  }
}

function validateUrl(value: string | undefined, label: string): void {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new ManagedMessageError(`${label} must be a valid HTTP or HTTPS URL.`);
  }
}

function buildDiscordBody(
  message: ManagedMessage,
  initialCreate: boolean,
): CreateChannelMessageInput {
  const buttons = message.buttons ?? [];
  const body: CreateChannelMessageInput = {
    embeds: message.embeds.map(toDiscordManagedMessageEmbed),
    ...(buttons.length > 0
      ? {
          components: [
            {
              type: 1,
              components: buttons.map((button) => ({
                type: 2,
                style: 5,
                label: button.label,
                url: button.url,
                ...(button.emoji ? { emoji: parseButtonEmoji(button.emoji) } : {}),
              })),
            },
          ],
        }
      : initialCreate
        ? {}
        : { components: [] }),
    allowed_mentions:
      initialCreate && message.announcement.notifyOnCreate
        ? allowConfiguredMentions(message.announcement)
        : { parse: [] },
  };
  const content = buildAnnouncementContent(message.announcement);
  if (content) body.content = content;
  return body;
}

export function toDiscordManagedMessageEmbed(embed: ManagedMessageEmbed): DiscordEmbed {
  return {
    ...(embed.title ? { title: embed.title } : {}),
    description: embed.description,
    ...(embed.color !== undefined ? { color: embed.color } : {}),
    ...(embed.imageUrl ? { image: { url: embed.imageUrl } } : {}),
    ...(embed.thumbnailUrl ? { thumbnail: { url: embed.thumbnailUrl } } : {}),
    ...(embed.footer ? { footer: { text: embed.footer } } : {}),
    fields: embed.fields.map((field) => ({
      name: field.name,
      value: field.value,
      inline: field.inline,
    })),
  };
}

export function buildAnnouncementContent(announcement: ManagedMessageAnnouncement): string | null {
  const targets = announcement.roleIds.map((roleId) => `<@&${roleId}>`);
  if (announcement.everyone) targets.push("@everyone");
  if (announcement.here) targets.push("@here");
  return targets.length > 0 ? `📣 ${targets.join(" ")}` : null;
}

function allowConfiguredMentions(announcement: ManagedMessageAnnouncement) {
  return {
    parse: announcement.everyone || announcement.here ? ["everyone" as const] : [],
    roles: announcement.roleIds,
  };
}

async function compensateDelete(
  action: () => Promise<void>,
  originalError: unknown,
  operation: string,
): Promise<never> {
  try {
    await action();
  } catch (compensationError) {
    throw new Error(
      `Managed Message ${operation} failed and Discord compensation also failed: ${describeError(originalError)}; ${describeError(compensationError)}`,
    );
  }
  throw originalError;
}

async function compensateEdit(
  action: () => Promise<unknown>,
  originalError: unknown,
  operation: string,
): Promise<never> {
  try {
    await action();
  } catch (compensationError) {
    throw new Error(
      `Managed Message ${operation} failed and restoring the previous Discord content also failed: ${describeError(originalError)}; ${describeError(compensationError)}`,
    );
  }
  throw originalError;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeScheduledPublishFailureCategory(
  error: unknown,
):
  | "discord_rate_limited"
  | "discord_permission_denied"
  | "destination_missing"
  | "database_failure"
  | "unknown" {
  if (error instanceof DiscordApiError) {
    if (error.status === 429) return "discord_rate_limited";
    if (error.status === 403) return "discord_permission_denied";
    if (error.status === 404) return "destination_missing";
  }
  if (error instanceof Error && /database|d1|sqlite/i.test(error.name)) return "database_failure";
  return "unknown";
}

function isTransientScheduledPublishError(error: unknown): boolean {
  if (error instanceof DiscordApiError) return error.status === 429 || error.status >= 500;
  if (error instanceof ManagedMessageError) return false;
  return true;
}

function scheduledPublishRetryDelayMs(attemptCount: number, error: unknown): number {
  const policyDelayMs = Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
  return error instanceof DiscordApiError
    ? Math.max(policyDelayMs, error.retryAfterMs ?? 0)
    : policyDelayMs;
}

function createManagedMessageId(): string {
  return `managed-${crypto.randomUUID()}`;
}

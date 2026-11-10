import { isRecord } from "../unknown-parse";
import {
  buildLfgApplicationModal,
  buildLfgApplicationAuditMessage,
  buildLfgApplicationOutcomeMessage,
  buildLfgApplicationReviewMessage,
  buildLfgDmMessage,
  buildLfgNoticeMessage,
  buildLfgPostMessage,
  buildLfgRenewalReminderMessage,
} from "../lfg";
import { DISCORD_CHANNEL_MESSAGE_RESPONSE, DISCORD_EPHEMERAL_FLAG } from "../discord/constants";
import type { CreateChannelMessageInput, DiscordMessageResource } from "../discord";
import type {
  GuildResourceScope,
  GuildResourceValidator,
} from "../discord/guild-resource-validator";
import { buildAuditEmbed, suppressMentions } from "../discord/messages";
import {
  AUDIT_EVENT_LABELS,
  type AuditEventId,
  type LfgApplication,
  type LfgConfig,
  type LfgPost,
} from "../types";
import type { GuildAuditLogStore, LfgStore } from "../runtime/contracts";
import { resolveAuditChannelId } from "./guild-audit-log-service";
import { createInsertionId, type ProductAnalyticsReporter } from "../product-analytics";

export interface CreateLfgPrivateVoiceChannelInput {
  guildId: string;
  name: string;
  parentId: string;
  ownerUserId: string;
  acceptedUserIds: string[];
}

export interface UpdateLfgPrivateVoiceChannelAccessInput {
  guildId: string;
  channelId: string;
  ownerUserId: string;
  acceptedUserIds: string[];
}

export interface LfgDiscordApi {
  createChannelMessage(
    channelId: string,
    body: CreateChannelMessageInput,
  ): Promise<DiscordMessageResource>;
  editChannelMessage(
    channelId: string,
    messageId: string,
    body: CreateChannelMessageInput,
  ): Promise<DiscordMessageResource>;
  deleteChannelMessage(channelId: string, messageId: string): Promise<void>;
  createUserDmMessage(
    userId: string,
    body: CreateChannelMessageInput,
  ): Promise<DiscordMessageResource>;
  addGuildMemberRole(guildId: string, userId: string, roleId: string): Promise<void>;
  removeGuildMemberRole(guildId: string, userId: string, roleId: string): Promise<void>;
  modifyChannel(channelId: string, body: { name: string }): Promise<void>;
  deleteChannel?(channelId: string): Promise<void>;
  createPrivateVoiceChannel?(input: CreateLfgPrivateVoiceChannelInput): Promise<{ id: string }>;
  updatePrivateVoiceChannelAccess?(input: UpdateLfgPrivateVoiceChannelAccessInput): Promise<void>;
  waitUntil?(promise: Promise<unknown>): void;
}

export interface LfgClanLookup {
  readMembership(
    guildId: string,
    userId: string,
  ): Promise<{ clanId: string; rank: "owner" | "officer" | "member" } | null>;
  readClan(
    guildId: string,
    clanId: string,
  ): Promise<{
    id: string;
    tag: string;
    lifecycleState: string;
    textChannelId: string | null;
    voiceChannelId: string | null;
    clanLfgLeadershipOnly: boolean;
  } | null>;
  isPublicAttributionEnabled(guildId: string): Promise<boolean>;
}

type PendingLfgCounterRename = {
  guildId: string;
  displayFormat: string;
  count: number;
  timer: Promise<void> | null;
};

const COUNTER_RENAME_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_LFG_COUNTER_DISPLAY_FORMAT = "LFG ({count})";
const pendingCounterRenames = new Map<string, PendingLfgCounterRename>();
const lastCounterRenameAt = new Map<string, number>();

export function resetLfgCounterRenameStateForTests(): void {
  pendingCounterRenames.clear();
  lastCounterRenameAt.clear();
}

export function applyLfgCounterTemplate(template: string, count: number): string {
  return template.replace(/{count}/g, String(count));
}

export class LfgService {
  constructor(
    private readonly store: LfgStore,
    private readonly discord: LfgDiscordApi,
    private readonly auditLogStore?: GuildAuditLogStore,
    private readonly clanLookup?: LfgClanLookup,
    private readonly guildResources?: GuildResourceValidator,
    private readonly productAnalytics?: ProductAnalyticsReporter,
  ) {}

  async getConfig(guildId: string): Promise<LfgConfig> {
    return (await this.store.readLfgConfig(guildId)) ?? defaultLfgConfig(guildId);
  }

  async updateConfig(config: LfgConfig): Promise<LfgConfig> {
    const resources = await this.readGuildResources(config.guildId);
    this.requireConfigResources(config, resources);
    const previous = await this.getConfig(config.guildId);
    const nextConfig = {
      ...config,
      ...(previous.enabled === false ? { enabled: false } : {}),
      updatedAtMs: Date.now(),
    };
    await this.store.upsertLfgConfig(nextConfig);
    await this.updateCounterChannel(nextConfig.guildId);
    return nextConfig;
  }

  async setupNotice(
    guildId: string,
    channelId: string,
    expectedConfig?: LfgConfig,
  ): Promise<LfgConfig> {
    const resources = await this.readGuildResources(guildId);
    resources?.requireTextChannel(channelId);
    const config = { ...(expectedConfig ?? (await this.getConfig(guildId))) };
    const previousMessageId = config.noticeMessageId;
    const expectedUpdatedAtMs = config.updatedAtMs;
    const removePreviousNotice = async () => {
      if (config.noticeChannelId && previousMessageId) {
        try {
          resources?.requireTextChannel(config.noticeChannelId);
          await this.discord.deleteChannelMessage(config.noticeChannelId, previousMessageId);
        } catch {
          // Replacing the notice is the primary operation; stale cleanup is best effort.
        }
      }
    };
    if (expectedConfig?.enabled === false) return this.getConfig(guildId);
    if (!expectedConfig) await removePreviousNotice();

    const message = await this.discord.createChannelMessage(
      channelId,
      buildLfgNoticeMessage(config),
    );
    const nextConfig = {
      ...config,
      enabled: true,
      noticeChannelId: channelId,
      noticeMessageId: message.id,
      updatedAtMs: Date.now(),
    };
    // Automatic refreshes must not overwrite a disable or newer configuration.
    if (expectedConfig) {
      let refreshed = false;
      try {
        refreshed = await this.store.refreshLfgNotice({
          guildId,
          channelId,
          previousMessageId,
          expectedUpdatedAtMs,
          messageId: message.id,
          updatedAtMs: nextConfig.updatedAtMs,
        });
      } finally {
        if (!refreshed) {
          await this.discord.deleteChannelMessage(channelId, message.id).catch(() => undefined);
        }
      }
      if (!refreshed) return this.getConfig(guildId);
      await removePreviousNotice();
    } else {
      await this.store.upsertLfgConfig(nextConfig);
    }
    return nextConfig;
  }

  async disable(guildId: string): Promise<{ config: LfgConfig; noticeRemoved: boolean }> {
    const previous = await this.getConfig(guildId);
    const { noticeChannelId, noticeMessageId } = previous;
    const config = {
      ...previous,
      enabled: false,
      noticeMessageId: null,
      updatedAtMs: Date.now(),
    };
    await this.store.upsertLfgConfig(config);
    if (noticeChannelId && noticeMessageId) {
      try {
        (await this.readGuildResources(guildId))?.requireTextChannel(noticeChannelId);
        await this.discord.deleteChannelMessage(noticeChannelId, noticeMessageId);
      } catch {
        return { config, noticeRemoved: false };
      }
    }
    return { config, noticeRemoved: true };
  }

  async listPosts(guildId: string): Promise<LfgPost[]> {
    return this.store.listLfgPosts(guildId, { limit: 50 });
  }

  async createPost(input: {
    guildId: string;
    channelId: string;
    ownerId: string;
    ownerDisplayName: string;
    serverId: string;
    whenPlay: string;
    lookingFor: string;
    extraInfo: string;
    scope?: "public" | "clan";
  }): Promise<LfgPost> {
    const resources = await this.readGuildResources(input.guildId);
    const activePost = await this.store.readActiveLfgPostByOwner(input.guildId, input.ownerId);
    if (activePost) {
      throw new LfgActivePostError();
    }

    const config = await this.getConfig(input.guildId);
    if (!config.noticeChannelId || config.enabled === false) {
      throw new LfgConfigError("LFG is disabled in this server.");
    }
    this.requireConfigResources(config, resources);
    const server = config.serverOptions.find((option) => option.id === input.serverId);
    if (!server) {
      throw new LfgConfigError("That server option is no longer available.");
    }

    let clan: Awaited<ReturnType<NonNullable<LfgClanLookup>["readClan"]>> = null;
    if (input.scope === "clan") {
      if (!this.clanLookup) throw new LfgConfigError("Clan-only LFG is unavailable.");
      const membership = await this.clanLookup.readMembership(input.guildId, input.ownerId);
      if (!membership)
        throw new LfgConfigError("You must belong to a Clan to create a Clan-only LFG post.");
      clan = await this.clanLookup.readClan(input.guildId, membership.clanId);
      if (!clan || clan.lifecycleState !== "active" || !clan.textChannelId || !clan.voiceChannelId)
        throw new LfgConfigError("Your Clan is not currently available for LFG.");
      if (clan.clanLfgLeadershipOnly && membership.rank === "member")
        throw new LfgConfigError("Only the Clan Owner or Officers can create Clan-only LFG posts.");
    } else if (
      this.clanLookup &&
      (await this.clanLookup.isPublicAttributionEnabled(input.guildId))
    ) {
      const membership = await this.clanLookup.readMembership(input.guildId, input.ownerId);
      if (membership) clan = await this.clanLookup.readClan(input.guildId, membership.clanId);
    }
    const post: LfgPost = {
      guildId: input.guildId,
      id: `${Date.now()}-${input.ownerId}`,
      ownerId: input.ownerId,
      ownerDisplayName: input.ownerDisplayName,
      serverId: server.id,
      serverLabel: server.label,
      whenPlay: input.whenPlay,
      lookingFor: input.lookingFor,
      extraInfo: input.extraInfo,
      channelId: input.scope === "clan" ? clan!.textChannelId! : input.channelId,
      messageId: null,
      active: true,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + config.expiryDurationHours * 60 * 60 * 1000,
      reminderSentAtMs: null,
      renewedAtMs: null,
      renewalsCount: 0,
      closedAtMs: null,
      closedByUserId: null,
      scope: input.scope ?? "public",
      clanId: clan?.id ?? null,
      clanTag: clan?.tag ?? null,
      persistentVoiceChannelId: input.scope === "clan" ? clan!.voiceChannelId : null,
    };
    resources?.requireTextChannel(post.channelId);
    if (post.persistentVoiceChannelId)
      resources?.requireVoiceChannel(post.persistentVoiceChannelId);

    await this.store.createLfgPost(post);
    let message: DiscordMessageResource;
    try {
      message = await this.discord.createChannelMessage(
        post.channelId,
        buildLfgPostMessage(post, { notificationRoleId: config.notificationRoleId }),
      );
    } catch (error) {
      try {
        await this.store.closeLfgPost({
          guildId: post.guildId,
          postId: post.id,
          closedByUserId: post.ownerId,
          closedAtMs: Date.now(),
        });
      } catch {
        throw new Error("Failed to publish LFG post and roll back the pending post.");
      }
      throw error;
    }
    const postWithMessage = { ...post, messageId: message.id };
    await this.store.updateLfgPostMessage({
      guildId: post.guildId,
      postId: post.id,
      messageId: message.id,
    });
    const noticeConfig = await this.store.readLfgConfig(input.guildId).catch(() => null);
    if (post.scope !== "clan" && noticeConfig?.noticeChannelId === input.channelId)
      await this.setupNotice(input.guildId, input.channelId, noticeConfig).catch(() => undefined);
    await this.postAuditFallback("lfg.post-create", postWithMessage);
    await this.updateCounterChannel(input.guildId);
    void this.productAnalytics?.report({
      name: "feature_outcome",
      insertionId: createInsertionId(),
      guildId: input.guildId,
      feature: "lfg",
      action: "lfg_published",
      status: "success",
    });
    return postWithMessage;
  }

  async closePost(input: {
    guildId: string;
    postId: string;
    closedByUserId: string;
  }): Promise<LfgPost> {
    const existing = await this.store.readLfgPost(input.guildId, input.postId);
    if (existing?.messageId) {
      (await this.readGuildResources(existing.guildId))?.requireTextChannel(existing.channelId);
    }
    const closedPost = await this.store.closeLfgPost({
      guildId: input.guildId,
      postId: input.postId,
      closedByUserId: input.closedByUserId,
      closedAtMs: Date.now(),
    });
    if (closedPost.messageId) {
      (await this.readGuildResources(closedPost.guildId))?.requireTextChannel(closedPost.channelId);
      await this.discord.editChannelMessage(
        closedPost.channelId,
        closedPost.messageId,
        buildLfgPostMessage(closedPost),
      );
    }
    await this.deletePrivateVoiceChannel(input.guildId, input.postId);
    await this.postAuditFallback("lfg.post-close", closedPost);
    await this.updateCounterChannel(input.guildId);
    void this.productAnalytics?.report({
      name: "feature_outcome",
      insertionId: createInsertionId(),
      guildId: input.guildId,
      feature: "lfg",
      action: "lfg_group_completed",
      status: "success",
    });
    return closedPost;
  }

  async editPost(input: {
    guildId: string;
    postId: string;
    ownerId: string;
    serverId: string;
    whenPlay: string;
    lookingFor: string;
    extraInfo: string;
  }): Promise<LfgPost> {
    const post = await this.store.readLfgPost(input.guildId, input.postId);
    if (!post || !post.active) {
      throw new LfgConfigError("This LFG post is no longer active.");
    }
    if (post.ownerId !== input.ownerId) {
      throw new LfgConfigError("Only the original poster can edit this post.");
    }

    const config = await this.getConfig(input.guildId);
    const server = config.serverOptions.find((option) => option.id === input.serverId);
    const serverId = input.serverId.trim();
    if (!serverId) {
      throw new LfgConfigError("Choose a server before saving your LFG post.");
    }

    const updatedPost: LfgPost = {
      ...post,
      serverId,
      serverLabel: server?.label ?? (serverId === post.serverId ? post.serverLabel : serverId),
      whenPlay: input.whenPlay,
      lookingFor: input.lookingFor,
      extraInfo: input.extraInfo,
    };
    if (updatedPost.messageId) {
      (await this.readGuildResources(updatedPost.guildId))?.requireTextChannel(
        updatedPost.channelId,
      );
    }
    await this.store.updateLfgPost(updatedPost);
    if (updatedPost.messageId) {
      (await this.readGuildResources(updatedPost.guildId))?.requireTextChannel(
        updatedPost.channelId,
      );
      await this.discord.editChannelMessage(
        updatedPost.channelId,
        updatedPost.messageId,
        buildLfgPostMessage(updatedPost),
      );
    }
    return updatedPost;
  }

  async toggleNotificationRole(input: {
    guildId: string;
    userId: string;
    memberRoleIds: string[];
  }): Promise<{ joined: boolean; roleId: string }> {
    const config = await this.getConfig(input.guildId);
    if (!config.notificationRoleId) {
      throw new LfgConfigError("LFG alerts are not configured for this guild.");
    }
    (await this.readGuildResources(input.guildId))?.requireRole(config.notificationRoleId);

    const joined = !input.memberRoleIds.includes(config.notificationRoleId);
    if (joined) {
      await this.discord.addGuildMemberRole(input.guildId, input.userId, config.notificationRoleId);
    } else {
      await this.discord.removeGuildMemberRole(
        input.guildId,
        input.userId,
        config.notificationRoleId,
      );
    }

    return { joined, roleId: config.notificationRoleId };
  }

  async renewPost(input: { guildId: string; postId: string; userId: string }): Promise<LfgPost> {
    const post = await this.store.readLfgPost(input.guildId, input.postId);
    if (!post || !post.active) {
      throw new LfgConfigError("This LFG post is no longer active.");
    }
    if (post.ownerId !== input.userId) {
      throw new LfgConfigError("Only the original poster can renew this post.");
    }

    const config = await this.getConfig(input.guildId);
    const durationMs = config.expiryDurationHours * 60 * 60 * 1000;
    const baseExpiresAt = post.expiresAtMs ?? Date.now();
    const renewedPost: LfgPost = {
      ...post,
      expiresAtMs: baseExpiresAt + durationMs,
      reminderSentAtMs: null,
      renewedAtMs: Date.now(),
      renewalsCount: post.renewalsCount + 1,
    };
    if (renewedPost.messageId) {
      (await this.readGuildResources(renewedPost.guildId))?.requireTextChannel(
        renewedPost.channelId,
      );
    }
    await this.store.updateLfgPost(renewedPost);
    if (renewedPost.messageId) {
      (await this.readGuildResources(renewedPost.guildId))?.requireTextChannel(
        renewedPost.channelId,
      );
      await this.discord.editChannelMessage(
        renewedPost.channelId,
        renewedPost.messageId,
        buildLfgPostMessage(renewedPost),
      );
    }
    return renewedPost;
  }

  async processDueExpiries(nowMs = Date.now()): Promise<void> {
    const duePosts = await this.store.listDueLfgPostExpiries(nowMs, 50);
    for (const post of duePosts) {
      try {
        const config = await this.getConfig(post.guildId);
        if (config.expiryAction === "nothing") {
          continue;
        }

        if (post.messageId) {
          (await this.readGuildResources(post.guildId))?.requireTextChannel(post.channelId);
        }

        const closedPost = await this.store.closeLfgPost({
          guildId: post.guildId,
          postId: post.id,
          closedByUserId: "lfg-expiry",
          closedAtMs: nowMs,
        });

        if (!closedPost.messageId) {
          await this.updateCounterChannel(post.guildId);
          continue;
        }
        if (config.expiryAction === "delete") {
          await this.discord
            .deleteChannelMessage(closedPost.channelId, closedPost.messageId)
            .catch(() => undefined);
        } else {
          await this.discord.editChannelMessage(
            closedPost.channelId,
            closedPost.messageId,
            buildLfgPostMessage(closedPost),
          );
        }

        await this.postAuditFallback("lfg.post-close", closedPost);
        await this.updateCounterChannel(post.guildId);
      } catch (error) {
        console.error("Failed to process LFG expiry", error);
      }
    }
  }

  async sendDueRenewalReminders(nowMs = Date.now()): Promise<void> {
    const duePosts = await this.store.listDueLfgRenewalReminders(nowMs, 50);
    for (const post of duePosts) {
      try {
        await this.discord.createUserDmMessage(post.ownerId, buildLfgRenewalReminderMessage(post));
        await this.store.updateLfgPost({ ...post, reminderSentAtMs: nowMs });
      } catch (error) {
        console.warn("Failed to send LFG renewal reminder", error);
      }
    }
  }

  async notifyOwner(input: {
    guildId: string;
    postId: string;
    interestedUserId: string;
    interestedUserDisplayName: string;
  }): Promise<{ dmSent: boolean }> {
    const post = await this.store.readLfgPost(input.guildId, input.postId);
    if (!post || !post.active) {
      throw new LfgConfigError("This LFG post is no longer active.");
    }
    if (post.ownerId === input.interestedUserId) {
      throw new LfgConfigError("You cannot mark yourself as interested in your own post.");
    }

    let dmSent = false;
    try {
      await this.discord.createUserDmMessage(
        post.ownerId,
        buildLfgDmMessage(input.interestedUserId, input.interestedUserDisplayName, post),
      );
      dmSent = true;
    } catch (error) {
      console.warn("Could not DM LFG owner", error);
      try {
        await this.discord.createUserDmMessage(
          post.ownerId,
          buildLfgDmMessage(input.interestedUserId, input.interestedUserDisplayName, post, {
            allowInterestedUserMention: false,
          }),
        );
        dmSent = true;
      } catch (retryError) {
        console.warn("Could not DM LFG owner after fallback", retryError);
      }
    }

    void this.productAnalytics?.report({
      name: "feature_outcome",
      insertionId: createInsertionId(),
      guildId: input.guildId,
      feature: "lfg",
      action: "lfg_participation_changed",
      status: dmSent ? "success" : "failure",
      reasonCode: dmSent ? undefined : "discord_rejected",
    });
    return { dmSent };
  }

  async startApplication(input: { guildId: string; postId: string; applicantId: string }): Promise<
    | ReturnType<typeof buildLfgApplicationModal>
    | {
        type: typeof DISCORD_CHANNEL_MESSAGE_RESPONSE;
        data: { content: string; flags: typeof DISCORD_EPHEMERAL_FLAG };
      }
  > {
    const post = await this.store.readLfgPost(input.guildId, input.postId);
    if (!post || !post.active) {
      throw new LfgConfigError("This LFG post is no longer active.");
    }
    if (post.ownerId === input.applicantId) {
      throw new LfgConfigError("You cannot mark yourself as interested in your own post.");
    }

    const existing = await this.store.readLfgApplication(
      input.guildId,
      input.postId,
      input.applicantId,
    );
    if (existing?.status === "pending") {
      throw new LfgConfigError("You already have a pending application for this post.");
    }
    if (existing?.status === "rejected") {
      throw new LfgConfigError("You cannot reapply to this LFG post after being rejected.");
    }
    if (existing?.status === "accepted") {
      throw new LfgConfigError("You have already been accepted to this LFG post.");
    }

    return buildLfgApplicationModal(input.postId);
  }

  async submitApplication(input: {
    guildId: string;
    postId: string;
    applicantId: string;
    applicantDisplayName: string;
    message: string;
  }): Promise<void> {
    const post = await this.store.readLfgPost(input.guildId, input.postId);
    if (!post || !post.active) {
      throw new LfgConfigError("This LFG post is no longer active.");
    }
    if (post.ownerId === input.applicantId) {
      throw new LfgConfigError("You cannot mark yourself as interested in your own post.");
    }

    const message = input.message.trim();
    if (!message) {
      throw new LfgConfigError("Add an application message before submitting.");
    }

    const existing = await this.store.readLfgApplication(
      input.guildId,
      input.postId,
      input.applicantId,
    );
    if (existing?.status === "pending") {
      throw new LfgConfigError("You already have a pending application for this post.");
    }
    if (existing?.status === "rejected") {
      throw new LfgConfigError("You cannot reapply to this LFG post after being rejected.");
    }
    if (existing?.status === "accepted") {
      throw new LfgConfigError("You have already been accepted to this LFG post.");
    }

    const nowMs = Date.now();
    const application: LfgApplication = {
      guildId: input.guildId,
      postId: input.postId,
      applicantId: input.applicantId,
      applicantDisplayName: input.applicantDisplayName,
      message,
      status: "pending",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      reviewedByUserId: null,
      reviewedAtMs: null,
    };
    await this.store.createLfgApplication(application);
    await this.discord.createUserDmMessage(
      post.ownerId,
      buildLfgApplicationReviewMessage(application, post),
    );

    const config = await this.getConfig(input.guildId);
    const auditChannelId =
      config.approvalAuditChannelId ??
      (this.auditLogStore
        ? await resolveAuditChannelId(
            input.guildId,
            null,
            this.auditLogStore,
            "lfg.application-decision",
          )
        : null);
    if (auditChannelId) {
      try {
        (await this.readGuildResources(input.guildId))?.requireTextChannel(auditChannelId);
        await this.discord.createChannelMessage(
          auditChannelId,
          buildLfgApplicationAuditMessage(application, post, "applied"),
        );
      } catch (error) {
        console.error("Failed to post LFG application audit event", error);
      }
    }
  }

  async reviewApplication(input: {
    guildId: string;
    postId: string;
    applicantId: string;
    actorId: string;
    outcome: "accepted" | "rejected";
  }): Promise<void> {
    const post = await this.store.readLfgPost(input.guildId, input.postId);
    if (!post || !post.active) {
      throw new LfgConfigError("This LFG post is no longer active.");
    }
    if (post.ownerId !== input.actorId) {
      throw new LfgConfigError("Only the original poster can review this application.");
    }

    const application = await this.store.readLfgApplication(
      input.guildId,
      input.postId,
      input.applicantId,
    );
    if (!application || application.status !== "pending") {
      throw new LfgConfigError("This application is no longer pending.");
    }

    const nowMs = Date.now();
    const reviewed = {
      ...application,
      status: input.outcome,
      updatedAtMs: nowMs,
      reviewedByUserId: input.actorId,
      reviewedAtMs: nowMs,
    };
    await this.store.updateLfgApplication(reviewed);
    if (reviewed.status === "accepted") {
      await this.ensurePrivateVoiceChannel(post, reviewed);
    }
    await this.discord.createUserDmMessage(
      reviewed.applicantId,
      buildLfgApplicationOutcomeMessage(reviewed, post),
    );

    const config = await this.getConfig(input.guildId);
    const auditChannelId =
      config.approvalAuditChannelId ??
      (this.auditLogStore
        ? await resolveAuditChannelId(
            input.guildId,
            null,
            this.auditLogStore,
            "lfg.application-decision",
          )
        : null);
    if (auditChannelId) {
      try {
        (await this.readGuildResources(input.guildId))?.requireTextChannel(auditChannelId);
        await this.discord.createChannelMessage(
          auditChannelId,
          buildLfgApplicationAuditMessage(reviewed, post, input.outcome),
        );
      } catch (error) {
        console.error("Failed to post LFG application audit event", error);
      }
    }
  }

  private async ensurePrivateVoiceChannel(
    post: LfgPost,
    application: LfgApplication,
  ): Promise<void> {
    if (post.scope === "clan") return;
    if (!this.discord.createPrivateVoiceChannel) return;
    const config = await this.getConfig(post.guildId);
    if (!config.approvalVoiceCategoryId) return;
    const resources = await this.readGuildResources(post.guildId);
    resources?.requireCategory(config.approvalVoiceCategoryId);
    const existing = await this.store.readLfgVoiceChannel(post.guildId, post.id);
    const acceptedApplications = await this.store.listLfgApplicationsForPost(
      post.guildId,
      post.id,
      {
        status: "accepted",
      },
    );
    const acceptedUserIds = unique([
      application.applicantId,
      ...acceptedApplications.map((entry) => entry.applicantId),
    ]);
    if (existing) {
      try {
        resources?.requireVoiceChannel(existing.channelId);
        await this.discord.updatePrivateVoiceChannelAccess?.({
          guildId: post.guildId,
          channelId: existing.channelId,
          ownerUserId: post.ownerId,
          acceptedUserIds,
        });
        await this.store.upsertLfgVoiceChannel({ ...existing, updatedAtMs: Date.now() });
        return;
      } catch (error) {
        if (!isDiscordNotFound(error)) throw error;
        await this.store.deleteLfgVoiceChannel(post.guildId, post.id);
      }
    }

    const channel = await this.discord.createPrivateVoiceChannel({
      guildId: post.guildId,
      name: buildPrivateVoiceChannelName(post, acceptedApplications),
      parentId: config.approvalVoiceCategoryId,
      ownerUserId: post.ownerId,
      acceptedUserIds,
    });
    const nowMs = Date.now();
    await this.store.upsertLfgVoiceChannel({
      guildId: post.guildId,
      postId: post.id,
      channelId: channel.id,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    await this.postAuditFallback("lfg.voice-channel-create", post);
  }

  private async deletePrivateVoiceChannel(guildId: string, postId: string): Promise<void> {
    if (!this.discord.deleteChannel) return;
    const existing = await this.store.readLfgVoiceChannel(guildId, postId);
    if (!existing) return;
    (await this.readGuildResources(guildId))?.requireVoiceChannel(existing.channelId);
    await this.discord.deleteChannel(existing.channelId).catch(() => undefined);
    await this.store.deleteLfgVoiceChannel(guildId, postId);
    const post = await this.store.readLfgPost(guildId, postId);
    if (post) {
      await this.postAuditFallback("lfg.voice-channel-cleanup", post);
    }
  }

  async updateCounterChannel(guildId: string): Promise<void> {
    const config = await this.getConfig(guildId);
    if (!config.counterVoiceChannelId) {
      return;
    }
    (await this.readGuildResources(guildId))?.requireVoiceChannel(config.counterVoiceChannelId);

    const activeCount = await this.store.countActiveLfgPosts(guildId);
    await this.enqueueCounterRename(
      guildId,
      config.counterVoiceChannelId,
      config.counterDisplayFormat,
      activeCount,
    );
  }

  async deletePrivateVoiceChannelForDiscordChannel(channelId: string): Promise<void> {
    if (!this.discord.deleteChannel) return;
    const existing = await this.store.readLfgVoiceChannelByChannelId(channelId);
    if (!existing) return;
    (await this.readGuildResources(existing.guildId))?.requireVoiceChannel(existing.channelId);
    await this.discord.deleteChannel(existing.channelId).catch(() => undefined);
    await this.store.deleteLfgVoiceChannel(existing.guildId, existing.postId);
    const post = await this.store.readLfgPost(existing.guildId, existing.postId);
    if (post) {
      await this.postAuditFallback("lfg.voice-channel-cleanup", post);
    }
  }

  private async readGuildResources(guildId: string): Promise<GuildResourceScope | null> {
    return this.guildResources ? await this.guildResources.forGuild(guildId) : null;
  }

  private requireConfigResources(config: LfgConfig, resources: GuildResourceScope | null): void {
    if (!resources) return;
    if (config.noticeChannelId) resources.requireTextChannel(config.noticeChannelId);
    if (config.notificationRoleId) resources.requireRole(config.notificationRoleId);
    if (config.counterVoiceChannelId) resources.requireVoiceChannel(config.counterVoiceChannelId);
    if (config.approvalAuditChannelId) resources.requireTextChannel(config.approvalAuditChannelId);
    if (config.approvalVoiceCategoryId) resources.requireCategory(config.approvalVoiceCategoryId);
  }

  private async postAuditFallback(eventId: AuditEventId, post: LfgPost): Promise<void> {
    if (!this.auditLogStore) return;
    const channelId = await resolveAuditChannelId(post.guildId, null, this.auditLogStore, eventId);
    if (!channelId) return;
    try {
      (await this.readGuildResources(post.guildId))?.requireTextChannel(channelId);
      await this.discord.createChannelMessage(channelId, buildLfgAuditMessage(eventId, post));
    } catch (error) {
      console.error("Failed to post LFG audit event", error);
    }
  }

  private async enqueueCounterRename(
    guildId: string,
    channelId: string,
    displayFormat: string,
    count: number,
  ): Promise<void> {
    const now = Date.now();
    const lastRenamedAtMs = lastCounterRenameAt.get(channelId) ?? 0;
    const remainingMs = COUNTER_RENAME_COOLDOWN_MS - (now - lastRenamedAtMs);

    if (remainingMs <= 0) {
      await this.renameCounterChannel(guildId, channelId, displayFormat, count, now);
      return;
    }

    const pending = pendingCounterRenames.get(channelId);
    if (pending) {
      pending.guildId = guildId;
      pending.displayFormat = displayFormat;
      pending.count = count;
      return;
    }

    const next: PendingLfgCounterRename = { guildId, displayFormat, count, timer: null };
    next.timer = new Promise<void>((resolve) => {
      const run = async () => {
        await delay(remainingMs);
        const latest = pendingCounterRenames.get(channelId);
        pendingCounterRenames.delete(channelId);
        await this.renameCounterChannel(
          latest?.guildId ?? guildId,
          channelId,
          latest?.displayFormat ?? displayFormat,
          latest?.count ?? count,
          Date.now(),
        );
        resolve();
      };

      const promise = run().catch((error) => {
        console.error("Failed to rename LFG counter channel", error);
        resolve();
      });
      this.discord.waitUntil?.(promise);
    });
    pendingCounterRenames.set(channelId, next);
  }

  private async renameCounterChannel(
    guildId: string,
    channelId: string,
    displayFormat: string,
    count: number,
    renamedAtMs: number,
  ) {
    (await this.readGuildResources(guildId))?.requireVoiceChannel(channelId);
    await this.discord.modifyChannel(channelId, {
      name: applyLfgCounterTemplate(displayFormat, count),
    });
    lastCounterRenameAt.set(channelId, renamedAtMs);
  }
}

export class LfgActivePostError extends Error {
  constructor() {
    super("You already have an active LFG post. Please close it before creating another.");
  }
}

export class LfgConfigError extends Error {}

function buildLfgAuditMessage(eventId: AuditEventId, post: LfgPost): CreateChannelMessageInput {
  return {
    embeds: [
      buildAuditEmbed({
        title: AUDIT_EVENT_LABELS[eventId] ?? eventId,
        color:
          eventId === "lfg.post-close" || eventId === "lfg.voice-channel-cleanup"
            ? 0xed4245
            : 0x5865f2,
        fields: [
          { name: "Post", value: post.id },
          { name: "Owner", value: `<@${post.ownerId}>` },
          { name: "Server", value: post.serverLabel || post.serverId || "Unknown" },
          { name: "Channel", value: `<#${post.channelId}>` },
        ],
      }),
    ],
    allowed_mentions: suppressMentions(),
  };
}

function buildPrivateVoiceChannelName(
  post: LfgPost,
  acceptedApplications: LfgApplication[],
): string {
  const owner = slugifyChannelPart(post.ownerDisplayName || post.ownerId);
  const firstApplicant = acceptedApplications[0];
  const applicant = slugifyChannelPart(
    firstApplicant?.applicantDisplayName || firstApplicant?.applicantId || "squad",
  );
  return `lfg-${owner}-${applicant}`.slice(0, 100);
}

function slugifyChannelPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "player";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isDiscordNotFound(error: unknown): boolean {
  return isRecord(error) && "status" in error && error.status === 404;
}

function defaultLfgConfig(guildId: string): LfgConfig {
  return {
    guildId,
    noticeChannelId: null,
    noticeMessageId: null,
    notificationRoleId: null,
    counterVoiceChannelId: null,
    counterDisplayFormat: DEFAULT_LFG_COUNTER_DISPLAY_FORMAT,
    approvalFlowEnabled: false,
    approvalAuditChannelId: null,
    approvalVoiceCategoryId: null,
    expiryAction: "close",
    expiryDurationHours: 24,
    serverOptions: [
      { id: "namalsk", label: "Namalsk", emoji: "🧊" },
      { id: "chernarus", label: "Chernarus", emoji: "🌲" },
      { id: "both", label: "Both", emoji: "🔁" },
    ],
    updatedAtMs: Date.now(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import {
  buildMarketplaceDmMessage,
  buildMarketplaceLogMessage,
  buildMarketplaceNoticeMessage,
  buildMarketplacePostMessage,
} from "../marketplace";
import { createDefaultMarketplaceConfig } from "../marketplace-config";
import type { CreateChannelMessageInput, DiscordMessageResource } from "../discord";
import type { GuildResourceValidator } from "../discord/guild-resource-validator";
import { resolveAuditChannelId } from "./guild-audit-log-service";
import type {
  MarketplaceBusinessLog,
  MarketplaceConfig,
  MarketplacePost,
  MarketplaceTradeType,
} from "../types";
import type { MarketplaceStore, GuildAuditLogStore } from "../runtime/contracts";

export interface MarketplaceDiscordApi {
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
}

export class MarketplaceService {
  constructor(
    private readonly store: MarketplaceStore,
    private readonly discord: MarketplaceDiscordApi,
    private readonly auditLogStore?: GuildAuditLogStore,
    private readonly guildResources?: GuildResourceValidator,
  ) {}

  async getConfig(guildId: string): Promise<MarketplaceConfig> {
    return (
      (await this.store.readMarketplaceConfig(guildId)) ?? createDefaultMarketplaceConfig(guildId)
    );
  }

  async updateConfig(config: MarketplaceConfig): Promise<MarketplaceConfig> {
    const resources = this.guildResources
      ? await this.guildResources.forGuild(config.guildId)
      : null;
    if (config.noticeChannelId) resources?.requireTextChannel(config.noticeChannelId);
    if (config.logChannelId) resources?.requireTextChannel(config.logChannelId);
    const now = Date.now();
    const previous = await this.getConfig(config.guildId);
    const nextConfig = {
      ...config,
      ...(previous.enabled === false ? { enabled: false } : {}),
      flowUpdatedAtMs: now,
      updatedAtMs: now,
    };
    await this.store.upsertMarketplaceConfig(nextConfig);
    return nextConfig;
  }

  async setupNotice(
    guildId: string,
    channelId: string,
    expectedConfig?: MarketplaceConfig,
  ): Promise<MarketplaceConfig> {
    const resources = this.guildResources ? await this.guildResources.forGuild(guildId) : null;
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
      buildMarketplaceNoticeMessage(config),
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
        refreshed = await this.store.refreshMarketplaceNotice({
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
      await this.store.upsertMarketplaceConfig(nextConfig);
    }
    return nextConfig;
  }

  async listPosts(guildId: string): Promise<MarketplacePost[]> {
    return this.store.listMarketplacePosts(guildId, { limit: 50 });
  }

  async disable(guildId: string): Promise<{ config: MarketplaceConfig; noticeRemoved: boolean }> {
    const previous = await this.getConfig(guildId);
    const { noticeChannelId, noticeMessageId } = previous;
    const now = Date.now();
    const config = {
      ...previous,
      enabled: false,
      noticeMessageId: null,
      flowUpdatedAtMs: now,
      updatedAtMs: now,
    };
    await this.store.upsertMarketplaceConfig(config);
    if (noticeChannelId && noticeMessageId) {
      try {
        (await this.guildResources?.forGuild(guildId))?.requireTextChannel(noticeChannelId);
        await this.discord.deleteChannelMessage(noticeChannelId, noticeMessageId);
      } catch {
        return { config, noticeRemoved: false };
      }
    }
    return { config, noticeRemoved: true };
  }

  async listLogs(guildId: string, limit = 10): Promise<MarketplaceBusinessLog[]> {
    return this.store.listMarketplaceLogs(guildId, limit);
  }

  async createPost(input: {
    guildId: string;
    channelId: string;
    ownerId: string;
    ownerDisplayName: string;
    tradeType: MarketplaceTradeType;
    serverId: string;
    flowUpdatedAtMs?: number;
    choiceIndexes?: number[];
    have: string;
    want: string;
    extra: string;
  }): Promise<MarketplacePost> {
    const resources = this.guildResources
      ? await this.guildResources.forGuild(input.guildId)
      : null;
    resources?.requireTextChannel(input.channelId);
    const activePost = await this.store.readActiveMarketplacePostByOwner(
      input.guildId,
      input.ownerId,
    );
    if (activePost) {
      throw new MarketplaceActivePostError();
    }

    const config = await this.getConfig(input.guildId);
    if (!config.noticeChannelId || config.enabled === false) {
      throw new MarketplaceConfigError("Marketplace is disabled in this server.");
    }
    if (
      input.flowUpdatedAtMs !== undefined &&
      input.flowUpdatedAtMs !== (config.flowUpdatedAtMs ?? config.updatedAtMs)
    ) {
      throw new MarketplaceConfigError(
        "Marketplace settings changed while you were creating this post. Please start again.",
      );
    }
    const serverChoiceEnabled = config.serverChoiceEnabled ?? true;
    const server = serverChoiceEnabled
      ? config.serverOptions.find((option) => option.id === input.serverId)
      : null;
    if (serverChoiceEnabled && !server) {
      throw new MarketplaceConfigError("That marketplace server option is no longer available.");
    }
    const additionalChoices = resolveAdditionalChoiceSelections(config, input.choiceIndexes ?? []);

    const post: MarketplacePost = {
      guildId: input.guildId,
      id: `${Date.now()}-${input.ownerId}`,
      ownerId: input.ownerId,
      ownerDisplayName: input.ownerDisplayName,
      tradeType: input.tradeType,
      serverId: server?.id ?? "",
      serverLabel: server?.label ?? "",
      additionalChoices,
      have: input.have,
      want: input.want,
      extra: input.extra,
      channelId: input.channelId,
      messageId: null,
      active: true,
      createdAtMs: Date.now(),
      closedAtMs: null,
      closedByUserId: null,
    };

    await this.store.createMarketplacePost(post);
    let message: DiscordMessageResource;
    try {
      message = await this.discord.createChannelMessage(
        input.channelId,
        buildMarketplacePostMessage(post),
      );
    } catch (error) {
      try {
        await this.store.closeMarketplacePost({
          guildId: post.guildId,
          postId: post.id,
          closedByUserId: post.ownerId,
          closedAtMs: Date.now(),
        });
      } catch {
        throw new Error("Failed to publish Marketplace post and roll back the pending post.");
      }
      throw error;
    }
    const postWithMessage = { ...post, messageId: message.id };
    await this.store.updateMarketplacePostMessage({
      guildId: post.guildId,
      postId: post.id,
      messageId: message.id,
    });
    const noticeConfig = await this.store.readMarketplaceConfig(input.guildId).catch(() => null);
    if (noticeConfig?.noticeChannelId === input.channelId)
      await this.setupNotice(input.guildId, input.channelId, noticeConfig).catch(() => undefined);
    await this.postAuditFallback(
      "marketplace.post-create",
      postWithMessage,
      buildMarketplacePostMessage(postWithMessage),
    );
    return postWithMessage;
  }

  async closePost(input: {
    guildId: string;
    postId: string;
    closedByUserId: string;
  }): Promise<MarketplacePost> {
    const existing = await this.store.readMarketplacePost(input.guildId, input.postId);
    if (existing?.messageId) {
      (await this.guildResources?.forGuild(existing.guildId))?.requireTextChannel(
        existing.channelId,
      );
    }
    const closedPost = await this.store.closeMarketplacePost({
      guildId: input.guildId,
      postId: input.postId,
      closedByUserId: input.closedByUserId,
      closedAtMs: Date.now(),
    });
    if (closedPost.messageId) {
      (await this.guildResources?.forGuild(closedPost.guildId))?.requireTextChannel(
        closedPost.channelId,
      );
      await this.discord.editChannelMessage(
        closedPost.channelId,
        closedPost.messageId,
        buildMarketplacePostMessage(closedPost),
      );
    }
    await this.postAuditFallback(
      "marketplace.post-close",
      closedPost,
      buildMarketplacePostMessage(closedPost),
    );
    return closedPost;
  }

  async confirmBusiness(input: {
    guildId: string;
    postId: string;
    buyerId: string;
    buyerDisplayName: string;
  }): Promise<{ dmSent: boolean }> {
    const post = await this.store.readMarketplacePost(input.guildId, input.postId);
    if (!post || !post.active) {
      throw new MarketplaceConfigError("This marketplace post is no longer active.");
    }
    if (post.ownerId === input.buyerId) {
      throw new MarketplaceConfigError("You cannot do business with your own post.");
    }

    let dmSent = false;
    let dmError: string | null = null;
    try {
      await this.discord.createUserDmMessage(
        post.ownerId,
        buildMarketplaceDmMessage(input.buyerId, input.buyerDisplayName, post),
      );
      dmSent = true;
    } catch (error) {
      dmError = error instanceof Error ? error.message : "Failed to send DM";
    }

    const log: MarketplaceBusinessLog = {
      guildId: input.guildId,
      id: `${Date.now()}-${input.buyerId}`,
      timestampMs: Date.now(),
      buyerId: input.buyerId,
      buyerDisplayName: input.buyerDisplayName,
      sellerId: post.ownerId,
      postId: post.id,
      channelId: post.channelId,
      messageId: post.messageId,
      tradeType: post.tradeType,
      serverLabel: post.serverLabel,
      dmSent,
      dmError,
      have: post.have,
      want: post.want,
    };
    await this.store.createMarketplaceLog(log);

    const config = await this.getConfig(input.guildId);
    const logChannelId =
      config.logChannelId ??
      (this.auditLogStore
        ? await resolveAuditChannelId(input.guildId, null, this.auditLogStore, "marketplace.trade")
        : null);
    if (logChannelId) {
      try {
        (await this.guildResources?.forGuild(input.guildId))?.requireTextChannel(logChannelId);
        await this.discord.createChannelMessage(logChannelId, buildMarketplaceLogMessage(log));
      } catch (error) {
        console.error("Failed to post marketplace log", error);
      }
    }

    return { dmSent };
  }

  private async postAuditFallback(
    eventId: "marketplace.post-create" | "marketplace.post-close",
    post: MarketplacePost,
    body: CreateChannelMessageInput,
  ): Promise<void> {
    if (!this.auditLogStore) return;
    const channelId = await resolveAuditChannelId(post.guildId, null, this.auditLogStore, eventId);
    if (!channelId) return;
    try {
      (await this.guildResources?.forGuild(post.guildId))?.requireTextChannel(channelId);
      await this.discord.createChannelMessage(channelId, body);
    } catch (error) {
      console.error("Failed to post marketplace audit event", error);
    }
  }
}

export class MarketplaceActivePostError extends Error {
  constructor() {
    super("You already have an active marketplace post. Please close it before creating another.");
  }
}

export class MarketplaceConfigError extends Error {}

function resolveAdditionalChoiceSelections(config: MarketplaceConfig, choiceIndexes: number[]) {
  if (!(config.additionalChoicesEnabled ?? false)) return [];
  const choices = config.additionalChoices ?? [];
  if (choiceIndexes.length !== choices.length) {
    throw new MarketplaceConfigError("Please complete every marketplace choice.");
  }
  return choices.map((choice, index) => {
    const option = choice.options[choiceIndexes[index] ?? -1];
    if (!option) {
      throw new MarketplaceConfigError(
        `The selected ${choice.label} option is no longer available.`,
      );
    }
    return {
      choiceId: choice.id,
      choiceLabel: choice.label,
      optionId: option.id,
      optionLabel: option.label,
    };
  });
}

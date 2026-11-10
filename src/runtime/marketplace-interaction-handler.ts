import { rethrowDiscordRateLimit } from "./interaction-rate-limit";
import { buildEphemeralMessage } from "../discord-interactions";
import {
  buildMarketplaceAdditionalChoiceResponse,
  buildMarketplacePostModal,
  buildMarketplaceServerResponse,
  buildMarketplaceTypeResponse,
  buildMarketplaceWarningResponse,
  parseMarketplaceCustomId,
} from "../marketplace";
import {
  MarketplaceActivePostError,
  MarketplaceConfigError,
  type MarketplaceService,
} from "../services/marketplace-service";
import type { DiscordInteraction, RuntimeStores } from "./app-types";
import {
  getInteractionCustomId,
  getInteractionUserDisplayName,
  getInteractionUserId,
  parseInteractionModalFieldValues,
} from "./discord-interaction-parsers";
import { hasInteractionAdminAccess } from "./interaction-admin-access";
import { createServiceFactory, type ServiceFactory } from "./service-factory";

export async function handleMarketplaceComponentInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  discordBotToken: string,
  services: Partial<ServiceFactory> = {},
): Promise<Response> {
  const customId = getInteractionCustomId(interaction);
  const parsed = customId ? parseMarketplaceCustomId(customId) : null;
  if (!parsed || typeof interaction.guild_id !== "string") {
    return Response.json(buildEphemeralMessage("Unsupported marketplace interaction."));
  }

  const userId = getInteractionUserId(interaction);
  if (!userId) {
    return Response.json(buildEphemeralMessage("Could not determine your Discord user."));
  }

  const service = resolveMarketplaceService(stores, discordBotToken, services);

  if (["create", "type", "server", "choice"].includes(parsed.action)) {
    const availability = await service.getConfig(interaction.guild_id);
    if (!availability.noticeChannelId || availability.enabled === false) {
      return Response.json(buildEphemeralMessage("Marketplace is disabled in this server."));
    }
  }

  if (parsed.action === "create") {
    try {
      if (await stores.marketplace.readActiveMarketplacePostByOwner(interaction.guild_id, userId)) {
        return Response.json(
          buildEphemeralMessage(
            "You already have an active marketplace post. Please close it before creating another.",
          ),
        );
      }
      return Response.json(buildMarketplaceTypeResponse());
    } catch (error) {
      rethrowDiscordRateLimit(error);
      console.error("Failed to start marketplace post", error);
      return Response.json(buildEphemeralMessage("Failed to start marketplace post creation."));
    }
  }

  if (parsed.action === "type") {
    const config = await service.getConfig(interaction.guild_id);
    return Response.json(
      (config.serverChoiceEnabled ?? true)
        ? buildMarketplaceServerResponse(config, parsed.tradeType)
        : buildNextMarketplaceStep(config, parsed.tradeType, "", []),
    );
  }

  if (parsed.action === "server") {
    const config = await service.getConfig(interaction.guild_id);
    if (hasMarketplaceConfigChanged(config, parsed.flowUpdatedAtMs)) {
      return Response.json(buildMarketplaceConfigChangedResponse());
    }
    return Response.json(buildNextMarketplaceStep(config, parsed.tradeType, parsed.serverId, []));
  }

  if (parsed.action === "choice") {
    const config = await service.getConfig(interaction.guild_id);
    const choices = config.additionalChoices ?? [];
    const choice = choices[parsed.choiceIndex];
    if (
      hasMarketplaceConfigChanged(config, parsed.flowUpdatedAtMs) ||
      !(config.additionalChoicesEnabled ?? false) ||
      parsed.choiceIndex !== parsed.choiceIndexes.length ||
      !choice?.options[parsed.optionIndex]
    ) {
      return Response.json(
        buildEphemeralMessage(
          "That marketplace choice is no longer available. Please start again.",
        ),
      );
    }
    return Response.json(
      buildNextMarketplaceStep(config, parsed.tradeType, parsed.serverId, [
        ...parsed.choiceIndexes,
        parsed.optionIndex,
      ]),
    );
  }

  if (parsed.action === "business") {
    const post = await stores.marketplace.readMarketplacePost(interaction.guild_id, parsed.postId);
    if (!post || !post.active) {
      return Response.json(buildEphemeralMessage("This marketplace post is no longer active."));
    }
    if (post.ownerId === userId) {
      return Response.json(buildEphemeralMessage("You cannot do business with your own post."));
    }
    return Response.json(buildMarketplaceWarningResponse(parsed.postId));
  }

  if (parsed.action === "confirm") {
    try {
      const result = await service.confirmBusiness({
        guildId: interaction.guild_id,
        postId: parsed.postId,
        buyerId: userId,
        buyerDisplayName: getInteractionUserDisplayName(interaction) ?? "Unknown user",
      });
      return Response.json(
        buildEphemeralMessage(
          result.dmSent
            ? "✅ The poster has been notified by DM. This action has been logged for admins."
            : "⚠️ I logged your interest, but I could not DM the poster. They may have DMs disabled. Please contact an admin if needed.",
        ),
      );
    } catch (error) {
      rethrowDiscordRateLimit(error);
      return Response.json(buildEphemeralMessage(describeMarketplaceError(error)));
    }
  }

  if (parsed.action === "close") {
    const post = await stores.marketplace.readMarketplacePost(interaction.guild_id, parsed.postId);
    if (!post || !post.active) {
      return Response.json(
        buildEphemeralMessage("This post is already closed or could not be found."),
      );
    }
    if (post.ownerId !== userId && !(await hasInteractionAdminAccess(interaction, stores))) {
      return Response.json(
        buildEphemeralMessage("Only the original poster or admins can close this post."),
      );
    }
    try {
      await service.closePost({
        guildId: interaction.guild_id,
        postId: parsed.postId,
        closedByUserId: userId,
      });
      return Response.json(buildEphemeralMessage("Marketplace post closed."));
    } catch (error) {
      rethrowDiscordRateLimit(error);
      console.error("Failed to close marketplace post", error);
      return Response.json(buildEphemeralMessage("Failed to close marketplace post."));
    }
  }

  return Response.json(buildEphemeralMessage("Unsupported marketplace interaction."));
}

export async function handleMarketplaceModalSubmitInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  discordBotToken: string,
  services: Partial<ServiceFactory> = {},
): Promise<Response> {
  const parsed = parseMarketplaceCustomId(getInteractionCustomId(interaction) ?? "");
  if (!parsed || parsed.action !== "modal" || typeof interaction.guild_id !== "string") {
    return Response.json(buildEphemeralMessage("Unsupported marketplace form."));
  }
  const userId = getInteractionUserId(interaction);
  const channelId = interaction.channel_id;
  if (!userId || !channelId) {
    return Response.json(buildEphemeralMessage("Could not create marketplace post here."));
  }

  const fields = parseInteractionModalFieldValues(interaction);
  try {
    const post = await resolveMarketplaceService(stores, discordBotToken, services).createPost({
      guildId: interaction.guild_id,
      channelId,
      ownerId: userId,
      ownerDisplayName: getInteractionUserDisplayName(interaction) ?? "Unknown user",
      tradeType: parsed.tradeType,
      serverId: parsed.serverId,
      flowUpdatedAtMs: parsed.flowUpdatedAtMs ?? undefined,
      choiceIndexes: parsed.choiceIndexes,
      have: fields.have ?? "",
      want: fields.want ?? "",
      extra: fields.extra ?? "",
    });
    const postLink =
      post.active && post.guildId && post.channelId && post.messageId
        ? `\n\n[View post](https://discord.com/channels/${post.guildId}/${post.channelId}/${post.messageId})`
        : "";
    return Response.json(buildEphemeralMessage("Marketplace post created." + postLink));
  } catch (error) {
    rethrowDiscordRateLimit(error);
    return Response.json(buildEphemeralMessage(describeMarketplaceError(error)));
  }
}

function buildNextMarketplaceStep(
  config: Awaited<ReturnType<MarketplaceService["getConfig"]>>,
  tradeType: Parameters<typeof buildMarketplacePostModal>[0],
  serverId: string,
  choiceIndexes: number[],
) {
  const choices = config.additionalChoicesEnabled ? (config.additionalChoices ?? []) : [];
  return choiceIndexes.length < choices.length
    ? buildMarketplaceAdditionalChoiceResponse(
        config,
        tradeType,
        serverId,
        choiceIndexes.length,
        choiceIndexes,
      )
    : buildMarketplacePostModal(
        tradeType,
        serverId,
        choiceIndexes,
        config.flowUpdatedAtMs ?? config.updatedAtMs,
      );
}

function hasMarketplaceConfigChanged(
  config: Awaited<ReturnType<MarketplaceService["getConfig"]>>,
  expectedUpdatedAtMs: number | null,
): boolean {
  return (
    expectedUpdatedAtMs !== null &&
    (config.flowUpdatedAtMs ?? config.updatedAtMs) !== expectedUpdatedAtMs
  );
}

function buildMarketplaceConfigChangedResponse() {
  return buildEphemeralMessage(
    "Marketplace settings changed while you were creating this post. Please start again.",
  );
}

function resolveMarketplaceService(
  stores: RuntimeStores,
  discordBotToken: string,
  services: Partial<ServiceFactory>,
) {
  return (
    services.marketplaceService ??
    createServiceFactory({ stores, discordBotToken }).marketplaceService
  );
}

function describeMarketplaceError(error: unknown): string {
  if (error instanceof MarketplaceActivePostError || error instanceof MarketplaceConfigError) {
    return error.message;
  }
  console.error("Marketplace interaction failed", error);
  return "Something went wrong with marketplace. Please contact an admin.";
}

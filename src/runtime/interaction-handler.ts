import { handleBanEnforcementInteraction } from "./ban-case-enforcement-interaction";
import { verifyDiscordSignature } from "../discord";
import { isRecord } from "../unknown-parse";
import { buildEphemeralMessage } from "../discord-interactions";
import type { DiscordInteraction, RuntimeAppOptions } from "./app-types";
import { ALL_FEATURES_ENABLED } from "./features";
import { handleApplicationCommand } from "./application-command-handler";
import {
  handleMessageComponentInteraction,
  handleTicketReplyAutocompleteInteraction,
  handleTicketModalSubmitInteraction,
} from "./ticket-interaction-handler";
import {
  handleMarketplaceComponentInteraction,
  handleMarketplaceModalSubmitInteraction,
} from "./marketplace-interaction-handler";
import {
  handleLfgComponentInteraction,
  handleLfgModalSubmitInteraction,
} from "./lfg-interaction-handler";
import {
  handleEventsComponentInteraction,
  handleEventsModalSubmitInteraction,
  isEventComponentInteraction,
  isEventModalSubmitInteraction,
} from "./events-interaction-handler";
import { parseMarketplaceCustomId } from "../marketplace";
import { parseLfgCustomId } from "../lfg";
import {
  DISCORD_APPLICATION_COMMAND_INTERACTION,
  DISCORD_APPLICATION_COMMAND_AUTOCOMPLETE_INTERACTION,
  DISCORD_PING_INTERACTION,
  DISCORD_PONG_RESPONSE,
} from "../discord/constants";
import { handleSteamLinkButtonInteraction } from "./steam-link-interaction-handler";
import { handleXboxLinkButtonInteraction } from "./xbox-link-interaction-handler";
import {
  handlePlayStationLinkButton,
  handlePlayStationLinkModalSubmit,
  isPlayStationLinkButtonInteraction,
  isPlayStationLinkModalSubmit,
} from "./playstation-link-interaction-handler";
import {
  handleEvidenceVaultComponentInteraction,
  handleEvidenceVaultModalSubmitInteraction,
  isEvidenceVaultComponentInteraction,
  isEvidenceVaultModalSubmitInteraction,
} from "./evidence-vault-interaction-handler";
import {
  handleImageRulesComponentInteraction,
  isImageRulesComponentInteraction,
} from "./image-rules-interaction-handler";
import {
  handleBotDefenseComponentInteraction,
  isBotDefenseComponentInteraction,
} from "./bot-defense-interaction-handler";
import {
  handleBanCaseComponentInteraction,
  isBanCaseComponentInteraction,
} from "./ban-case-interaction-handler";
import { createServiceFactory } from "./service-factory";
import {
  buildMemberVerificationCustomId,
  parseMemberVerificationCustomId,
} from "../services/member-verification-service";
import {
  handleClanComponentInteraction,
  handleClanModalSubmitInteraction,
  isClanInteraction,
} from "./clan-interaction-handler";
import {
  handleSuggestionComponentInteraction,
  handleSuggestionModalSubmitInteraction,
  isSuggestionInteraction,
} from "./suggestion-interaction-handler";
import {
  GUILD_BOUND_INTERACTION_DENIAL_MESSAGE,
  isInteractionBoundToGuild,
} from "./interaction-guild-binding";
import { getInteractionUserId } from "./discord-interaction-parsers";
import { verifySensitiveComponentId } from "../security/sensitive-component-ids";
import {
  handleCommerceSellerReviewInteraction,
  isCommerceSellerReviewInteraction,
} from "./commerce-seller-review-interaction-handler";

const DISCORD_INTERACTION_MAX_AGE_SECONDS = 5 * 60;

export async function handleInteractionRequest(
  request: Request,
  options: RuntimeAppOptions,
): Promise<Response> {
  const features = options.features ?? ALL_FEATURES_ENABLED;
  const services = {
    ...createServiceFactory({
      stores: options.stores,
      discordBotToken: options.discordBotToken,
      discordCache: options.discordCache,
      steamWebApiKey: options.steamWebApiKey,
      wardogs: options.wardogs,
      banEnforcementStore: options.banEnforcementStore,
      banIncidentStore: options.banIncidentStore,
      banCasesEnabled: features.banCases,
      wardogsPlayerCountEnabled: options.wardogsPlayerCountEnabled,
      playerCountEnabled: features.playerCount,
      webhookProxyLogPersistenceEnabled: options.webhookProxyLogPersistenceEnabled,
      ticketRecoveryQueue: options.ticketRecoveryQueue,
      evidenceVaultBlobs: options.evidenceVaultBlobs,
      origin: new URL(request.url).origin,
      publicUrl: new URL(request.url).origin,
      waitUntil: options.waitUntil,
      whiteLabelBotStore: options.stores.whiteLabelBots,
      steamLinkAvailable: features.steamLink,
      componentIdSigner: options.componentIdSigner,
    }),
    ...options.services,
  };
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = await request.text();

  if (!signature || !timestamp) {
    return new Response("Unauthorized", { status: 401 });
  }

  const verifyDiscordRequest =
    options.verifyDiscordRequest ??
    ((ts: string, rawBody: string, sig: string) =>
      verifyDiscordSignature(options.discordPublicKey, ts, rawBody, sig));

  if (!(await verifyDiscordRequest(timestamp, body, signature))) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!isFreshDiscordTimestamp(timestamp)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let interaction = JSON.parse(body) as DiscordInteraction;
  if (interaction?.type === DISCORD_PING_INTERACTION) {
    return Response.json({ type: DISCORD_PONG_RESPONSE });
  }

  if (interaction?.type === DISCORD_APPLICATION_COMMAND_AUTOCOMPLETE_INTERACTION) {
    return handleTicketReplyAutocompleteInteraction(
      interaction,
      options.stores,
      services.ticketLifecycle,
    );
  }

  if (interaction?.type === DISCORD_APPLICATION_COMMAND_INTERACTION) {
    return handleApplicationCommand(
      interaction,
      options.stores,
      options.discordBotToken,
      features,
      {
        hafAdminGuildId: options.hafAdminGuildId,
        communityTools: options.communityTools,
        reputationServiceForGuild: options.reputationServiceForGuild,
        hafAdminRoleId: options.hafAdminRoleId,
        eraseAttendanceObservationMember: options.attendanceObservations
          ? (guildId, userId) =>
              options.attendanceObservations!.service.eraseMember(guildId, userId)
          : undefined,
        services,
        waitUntil: options.waitUntil,
        requestOrigin: new URL(request.url).origin,
        selfHostedSite: options.selfHostedSite,
        ticketTranscriptBlobs: options.ticketTranscriptBlobs,
        ticketTranscriptCapabilities: options.ticketTranscriptCapabilities,
        aiTranscriptSummarizerEnv: options.aiTranscriptSummarizerEnv,
        componentIdSigner: options.componentIdSigner,
      },
    );
  }

  if ((interaction?.type === 3 || interaction?.type === 5) && options.componentIdSigner) {
    const customId = getCustomId(interaction);
    if (typeof customId === "string") {
      const verification = await verifySensitiveComponentId(customId, options.componentIdSigner, {
        interactionGuildId: interaction.guild_id,
        actorUserId: getInteractionUserId(interaction) ?? undefined,
      });
      if (verification.kind === "invalid") {
        return Response.json(buildEphemeralMessage("This action is no longer available."));
      }
      if (verification.kind === "valid") {
        interaction = replaceInteractionCustomId(interaction, verification.customId);
      }
    }
  }

  if ((interaction?.type === 3 || interaction?.type === 5) && features.banCases) {
    const id = getCustomId(interaction);
    if (typeof id === "string" && (id.startsWith("ban-case:actions:") || id.startsWith("bce:")))
      return handleBanEnforcementInteraction(
        interaction,
        services.banCaseEnforcement,
        options.wardogs,
        options.componentIdSigner,
      );
  }

  // Message component interactions (buttons, selects)
  if (interaction?.type === 3) {
    const guildId = interaction.guild_id;
    const customId = getCustomId(interaction);
    const lfgCustomIdParts = typeof customId === "string" ? parseLfgCustomId(customId) : null;
    const isDmLfgAction =
      features.lfg &&
      (lfgCustomIdParts?.action === "renew" ||
        lfgCustomIdParts?.action === "application-accept" ||
        lfgCustomIdParts?.action === "application-reject");
    const isDmMemberVerificationAction =
      features.memberVerification &&
      typeof customId === "string" &&
      customId.startsWith(buildMemberVerificationCustomId(""));
    if (
      (typeof guildId !== "string" || guildId.length === 0) &&
      !isDmLfgAction &&
      !isDmMemberVerificationAction
    ) {
      return Response.json(
        buildEphemeralMessage("This interaction can only be used inside a server."),
      );
    }

    if (features.memberVerification && isMemberVerificationButtonInteraction(interaction)) {
      const parsedGuildId =
        typeof customId === "string" ? parseMemberVerificationCustomId(customId) : null;
      const userId = interaction.user?.id ?? interaction.member?.user?.id;
      if (typeof parsedGuildId !== "string" || typeof userId !== "string") {
        return Response.json(buildEphemeralMessage("Unable to identify the Guild or user."));
      }
      if (guildId && !isInteractionBoundToGuild(interaction, parsedGuildId)) {
        return Response.json(buildEphemeralMessage(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE));
      }
      const messageId = interaction.message?.id;
      const channelId = interaction.message?.channel_id;
      const result = await services.memberVerificationService.handleVerifyButton({
        guildId: parsedGuildId,
        userId,
        messageId: typeof messageId === "string" ? messageId : undefined,
        channelId: typeof channelId === "string" ? channelId : undefined,
        user: interaction.user ?? interaction.member?.user,
      });
      return Response.json(result);
    }

    if (isCommerceSellerReviewInteraction(interaction)) {
      return handleCommerceSellerReviewInteraction(interaction, {
        hafAdminGuildId: options.hafAdminGuildId,
        hafAdminRoleId: options.hafAdminRoleId,
        sellerReviews: options.commerceAdmin?.sellerReviews,
        waitUntil: options.waitUntil,
      });
    }

    if (features.marketplace && isMarketplaceInteraction(interaction)) {
      return handleMarketplaceComponentInteraction(
        interaction,
        options.stores,
        options.discordBotToken,
        services,
      );
    }

    if (features.clans !== false && services.clanService && isClanInteraction(interaction)) {
      return handleClanComponentInteraction(
        interaction,
        options.stores,
        services.clanService,
        options.waitUntil,
        options.componentIdSigner,
      );
    }

    if (features.lfg && lfgCustomIdParts) {
      return handleLfgComponentInteraction(
        interaction,
        options.stores,
        options.discordBotToken,
        services,
        options.componentIdSigner,
      );
    }

    if (features.events && isEventComponentInteraction(interaction)) {
      return handleEventsComponentInteraction(interaction, services);
    }

    if (features.steamLink && isSteamLinkButtonInteraction(interaction)) {
      return handleSteamLinkButtonInteraction(
        interaction,
        services.platformLinkService,
        new URL(request.url).origin,
      );
    }

    if (features.xboxLink && isXboxLinkButtonInteraction(interaction)) {
      return handleXboxLinkButtonInteraction(
        interaction,
        services.platformLinkService,
        new URL(request.url).origin,
      );
    }

    if (features.playstationLink && isPlayStationLinkButtonInteraction(interaction)) {
      return handlePlayStationLinkButton(interaction, services.platformLinkService);
    }

    if (features.evidenceVault && isEvidenceVaultComponentInteraction(interaction)) {
      return handleEvidenceVaultComponentInteraction(
        interaction,
        services.evidenceVaultService,
        new URL(request.url).origin,
        options.componentIdSigner,
      );
    }

    if (features.imageRules && isImageRulesComponentInteraction(interaction)) {
      return handleImageRulesComponentInteraction(
        interaction,
        options.stores,
        options.discordBotToken,
      );
    }

    if (features.botDefense && isBotDefenseComponentInteraction(interaction)) {
      return handleBotDefenseComponentInteraction(
        interaction,
        options.stores,
        options.discordBotToken,
        options.componentIdSigner,
      );
    }

    if (features.banCases && isBanCaseComponentInteraction(interaction)) {
      return handleBanCaseComponentInteraction(
        interaction,
        options.stores,
        services.banCaseService,
      );
    }

    if (features.suggestions && isSuggestionInteraction(interaction)) {
      return handleSuggestionComponentInteraction(
        interaction,
        services.suggestionService,
        options.componentIdSigner,
      );
    }

    if (features.tickets) {
      return handleMessageComponentInteraction(
        interaction,
        options.stores,
        options.discordBotToken,
        new URL(request.url).origin,
        options.ticketTranscriptBlobs,
        options.waitUntil,
        options.aiTranscriptSummarizerEnv,
        services.ticketLifecycle,
        options.ticketTranscriptCapabilities,
        options.componentIdSigner,
      );
    }

    return Response.json(buildEphemeralMessage("This feature is currently disabled."));
  }

  // Modal submit interactions
  if (interaction?.type === 5) {
    const guildId = interaction.guild_id;
    if (typeof guildId !== "string" || guildId.length === 0) {
      return Response.json(
        buildEphemeralMessage("This interaction can only be used inside a server."),
      );
    }

    if (features.marketplace && isMarketplaceInteraction(interaction)) {
      return handleMarketplaceModalSubmitInteraction(
        interaction,
        options.stores,
        options.discordBotToken,
        services,
      );
    }

    if (features.clans !== false && services.clanService && isClanInteraction(interaction)) {
      return handleClanModalSubmitInteraction(
        interaction,
        options.stores,
        services.clanService,
        options.waitUntil,
      );
    }

    if (features.lfg && isLfgInteraction(interaction)) {
      return handleLfgModalSubmitInteraction(
        interaction,
        options.stores,
        options.discordBotToken,
        services,
        options.waitUntil,
      );
    }

    if (features.playstationLink && isPlayStationLinkModalSubmit(interaction)) {
      return handlePlayStationLinkModalSubmit(interaction, services.platformLinkService);
    }

    if (features.evidenceVault && isEvidenceVaultModalSubmitInteraction(interaction)) {
      return handleEvidenceVaultModalSubmitInteraction(interaction, services.evidenceVaultService);
    }

    if (features.suggestions && isSuggestionInteraction(interaction)) {
      return handleSuggestionModalSubmitInteraction(interaction, services.suggestionService);
    }

    if (features.events && isEventModalSubmitInteraction(interaction)) {
      return handleEventsModalSubmitInteraction(interaction, services);
    }

    if (features.tickets) {
      return handleTicketModalSubmitInteraction(
        interaction,
        options.stores,
        options.discordBotToken,
        options.waitUntil,
        services.ticketLifecycle,
        options.componentIdSigner,
      );
    }

    return Response.json(buildEphemeralMessage("This feature is currently disabled."));
  }

  return Response.json(buildEphemeralMessage("Unsupported interaction type."));
}

function isMarketplaceInteraction(interaction: DiscordInteraction): boolean {
  if (!isRecord(interaction.data)) {
    return false;
  }

  const customId = (interaction.data as { custom_id?: unknown }).custom_id;
  return typeof customId === "string" && parseMarketplaceCustomId(customId) !== null;
}

function isLfgInteraction(interaction: DiscordInteraction): boolean {
  if (!isRecord(interaction.data)) {
    return false;
  }

  const customId = (interaction.data as { custom_id?: unknown }).custom_id;
  return typeof customId === "string" && parseLfgCustomId(customId) !== null;
}

function isSteamLinkButtonInteraction(interaction: DiscordInteraction): boolean {
  if (!isRecord(interaction.data)) {
    return false;
  }

  const customId = (interaction.data as { custom_id?: unknown }).custom_id;
  return typeof customId === "string" && customId === "steam_link_button";
}

function isXboxLinkButtonInteraction(interaction: DiscordInteraction): boolean {
  if (!isRecord(interaction.data)) {
    return false;
  }

  const customId = (interaction.data as { custom_id?: unknown }).custom_id;
  return typeof customId === "string" && customId === "xbox_link_button";
}

function isMemberVerificationButtonInteraction(interaction: DiscordInteraction): boolean {
  if (!isRecord(interaction.data)) {
    return false;
  }

  const customId = (interaction.data as { custom_id?: unknown }).custom_id;
  return typeof customId === "string" && customId.startsWith(buildMemberVerificationCustomId(""));
}

function getCustomId(interaction: DiscordInteraction): unknown {
  if (!isRecord(interaction.data)) {
    return null;
  }

  return (interaction.data as { custom_id?: unknown }).custom_id;
}

function replaceInteractionCustomId(
  interaction: DiscordInteraction,
  customId: string,
): DiscordInteraction {
  return {
    ...interaction,
    data: isRecord(interaction.data)
      ? { ...interaction.data, custom_id: customId }
      : interaction.data,
  };
}

function isFreshDiscordTimestamp(timestamp: string): boolean {
  if (!/^\d+$/.test(timestamp)) {
    return false;
  }
  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.abs(nowSeconds - timestampSeconds) <= DISCORD_INTERACTION_MAX_AGE_SECONDS;
}

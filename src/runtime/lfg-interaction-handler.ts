import { rethrowDiscordRateLimit } from "./interaction-rate-limit";
import { buildEphemeralMessage } from "../discord-interactions";
import { fetchChannelMessage } from "../discord/messages";
import { editOriginalInteractionResponse } from "../discord";
import {
  DISCORD_DEFERRED_CHANNEL_MESSAGE_RESPONSE,
  DISCORD_EPHEMERAL_FLAG,
  DISCORD_UPDATE_MESSAGE_RESPONSE,
} from "../discord/constants";
import {
  buildLfgCloseConfirmation,
  buildLfgPostModal,
  buildLfgServerResponse,
  parseLfgCustomId,
} from "../lfg";
import type { ComponentIdSigner } from "../security/component-id-signer";
import { signSensitiveMessageComponentIds } from "../security/sensitive-component-ids";
import { LfgActivePostError, LfgConfigError } from "../services/lfg-service";
import type { LfgPost } from "../types";
import type { DiscordInteraction, RuntimeStores } from "./app-types";
import {
  getInteractionCustomId,
  getInteractionUserDisplayName,
  getInteractionUserId,
  parseInteractionModalFieldValues,
} from "./discord-interaction-parsers";
import { hasInteractionAdminAccess } from "./interaction-admin-access";
import { GUILD_BOUND_INTERACTION_DENIAL_MESSAGE } from "./interaction-guild-binding";
import { createServiceFactory, type ServiceFactory } from "./service-factory";

export async function handleLfgComponentInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  discordBotToken: string,
  services: Partial<ServiceFactory> = {},
  componentIdSigner?: ComponentIdSigner,
): Promise<Response> {
  const customId = getInteractionCustomId(interaction);
  const parsed = customId ? parseLfgCustomId(customId) : null;
  if (!parsed) {
    return Response.json(buildEphemeralMessage("Unsupported LFG interaction."));
  }

  const userId = getInteractionUserId(interaction);
  if (!userId) {
    return Response.json(buildEphemeralMessage("Could not determine your Discord user."));
  }

  const interactionGuildId =
    typeof interaction.guild_id === "string" && interaction.guild_id.length > 0
      ? interaction.guild_id
      : null;
  let guildId = interactionGuildId;

  if (
    parsed.action === "renew" ||
    parsed.action === "application-accept" ||
    parsed.action === "application-reject"
  ) {
    const post = await stores.lfg.readLfgPost(parsed.guildId, parsed.postId);
    if (
      !post ||
      post.guildId !== parsed.guildId ||
      post.ownerId !== userId ||
      (interactionGuildId !== null && interactionGuildId !== post.guildId)
    ) {
      return Response.json(buildEphemeralMessage(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE));
    }
    if (parsed.action === "application-accept" || parsed.action === "application-reject") {
      const application = await stores.lfg.readLfgApplication(
        post.guildId,
        post.id,
        parsed.applicantId,
      );
      if (!application || application.guildId !== post.guildId) {
        return Response.json(buildEphemeralMessage(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE));
      }
    }
    guildId = post.guildId;
  }

  if (!guildId) {
    return Response.json(buildEphemeralMessage("Unsupported LFG interaction."));
  }

  const service = resolveLfgService(stores, discordBotToken, services);

  if (["create", "create-clan", "server", "server-clan", "toggle-alerts"].includes(parsed.action)) {
    const availability = await service.getConfig(guildId);
    if (!availability.noticeChannelId || availability.enabled === false) {
      return Response.json(buildEphemeralMessage("LFG is disabled in this server."));
    }
  }

  if (parsed.action === "create" || parsed.action === "create-clan") {
    try {
      const activePost = await stores.lfg.readActiveLfgPostByOwner(guildId, userId);
      if (activePost) {
        let postLink = lfgPostLink(activePost);
        if (postLink && activePost.messageId) {
          const message = await fetchChannelMessage(
            activePost.channelId,
            activePost.messageId,
            discordBotToken,
          ).catch((error: unknown) => {
            rethrowDiscordRateLimit(error);
            return null;
          });
          if (!message) postLink = "";
        }
        return Response.json(
          buildEphemeralMessage(
            "You already have an active LFG post. Please close it before creating another." +
              postLink,
          ),
        );
      }
      return Response.json(
        buildLfgServerResponse(
          await service.getConfig(guildId),
          parsed.action === "create-clan" ? "clan" : "public",
        ),
      );
    } catch (error) {
      rethrowDiscordRateLimit(error);
      console.error("Failed to start LFG post", error);
      return Response.json(buildEphemeralMessage("Failed to start LFG post creation."));
    }
  }

  if (parsed.action === "toggle-alerts") {
    try {
      const result = await service.toggleNotificationRole({
        guildId,
        userId,
        memberRoleIds: Array.isArray(interaction.member?.roles)
          ? interaction.member.roles.filter(
              (roleId): roleId is string => typeof roleId === "string",
            )
          : [],
      });
      return Response.json(
        buildEphemeralMessage(
          result.joined ? `Joined <@&${result.roleId}>.` : `Left <@&${result.roleId}>.`,
        ),
      );
    } catch (error) {
      rethrowDiscordRateLimit(error);
      return Response.json(buildEphemeralMessage(describeLfgError(error)));
    }
  }

  if (parsed.action === "server" || parsed.action === "server-clan") {
    return Response.json(
      buildLfgPostModal(
        parsed.serverId,
        { serverId: parsed.serverId },
        { scope: parsed.action === "server-clan" ? "clan" : "public" },
      ),
    );
  }

  if (parsed.action === "edit") {
    const post = await stores.lfg.readLfgPost(guildId, parsed.postId);
    if (!post || !post.active) {
      return Response.json(buildEphemeralMessage("This LFG post is no longer active."));
    }
    if (post.ownerId !== userId) {
      return Response.json(buildEphemeralMessage("Only the original poster can edit this post."));
    }
    return Response.json(
      buildLfgPostModal(
        post.serverId,
        {
          serverId: post.serverId,
          whenPlay: post.whenPlay,
          lookingFor: post.lookingFor,
          extraInfo: post.extraInfo,
        },
        { customId: `lfg:edit-modal:${post.id}`, title: "Edit LFG Post" },
      ),
    );
  }

  if (parsed.action === "interested") {
    const post = await stores.lfg.readLfgPost(guildId, parsed.postId);
    if (!post || !post.active) {
      return Response.json(buildEphemeralMessage("This LFG post is no longer active."));
    }
    if (post.ownerId === userId) {
      return Response.json(
        buildEphemeralMessage("You cannot mark yourself as interested in your own post."),
      );
    }
    try {
      const config = await service.getConfig(guildId);
      if (config.approvalFlowEnabled) {
        return Response.json(
          await service.startApplication({
            guildId,
            postId: parsed.postId,
            applicantId: userId,
          }),
        );
      }

      const result = await service.notifyOwner({
        guildId,
        postId: parsed.postId,
        interestedUserId: userId,
        interestedUserDisplayName: getInteractionUserDisplayName(interaction) ?? "Unknown user",
      });
      return Response.json(
        buildEphemeralMessage(
          result.dmSent
            ? "The original poster has been notified that you are interested."
            : "You have been marked as interested, but I could not DM the original poster. They may have DMs turned off.",
        ),
      );
    } catch (error) {
      rethrowDiscordRateLimit(error);
      return Response.json(buildEphemeralMessage(describeLfgError(error)));
    }
  }

  if (parsed.action === "application-accept" || parsed.action === "application-reject") {
    try {
      await service.reviewApplication({
        guildId,
        postId: parsed.postId,
        applicantId: parsed.applicantId,
        actorId: userId,
        outcome: parsed.action === "application-accept" ? "accepted" : "rejected",
      });
      return Response.json(
        buildEphemeralMessage(
          parsed.action === "application-accept"
            ? "Application accepted."
            : "Application rejected.",
        ),
      );
    } catch (error) {
      rethrowDiscordRateLimit(error);
      return Response.json(buildEphemeralMessage(describeLfgError(error)));
    }
  }

  if (
    parsed.action === "close" ||
    parsed.action === "close-confirm" ||
    parsed.action === "close-cancel"
  ) {
    const post = await stores.lfg.readLfgPost(guildId, parsed.postId);
    if (!post || post.guildId !== guildId || !post.active) {
      return Response.json(
        buildEphemeralMessage("This post is already closed or could not be found."),
      );
    }
    const canClose =
      post.ownerId === userId ||
      hasManageMessagesPermission(interaction.member?.permissions ?? "") ||
      (await hasInteractionAdminAccess(interaction, stores));
    if (!canClose) {
      return Response.json(
        buildEphemeralMessage("Only the original poster or admins can close this post."),
      );
    }
    if (parsed.action === "close-cancel") {
      return Response.json({
        type: DISCORD_UPDATE_MESSAGE_RESPONSE,
        data: { content: "Cancelled. The LFG post is still open.", components: [] },
      });
    }
    if (parsed.action === "close") {
      const confirmation = buildLfgCloseConfirmation(post);
      return Response.json({
        ...confirmation,
        data: await signSensitiveMessageComponentIds(confirmation.data, componentIdSigner, {
          guildId,
          actorUserId: userId,
          expiresAtMs: Date.now() + 10 * 60 * 1000,
        }),
      });
    }
    try {
      await service.closePost({
        guildId,
        postId: parsed.postId,
        closedByUserId: userId,
      });
      return Response.json({
        type: DISCORD_UPDATE_MESSAGE_RESPONSE,
        data: { content: "LFG post closed.", components: [] },
      });
    } catch (error) {
      rethrowDiscordRateLimit(error);
      console.error("Failed to close LFG post", error);
      return Response.json(buildEphemeralMessage("Failed to close LFG post."));
    }
  }

  if (parsed.action === "renew") {
    try {
      await service.renewPost({ guildId, postId: parsed.postId, userId });
      return Response.json(buildEphemeralMessage("LFG post renewed."));
    } catch (error) {
      rethrowDiscordRateLimit(error);
      return Response.json(buildEphemeralMessage(describeLfgError(error)));
    }
  }

  return Response.json(buildEphemeralMessage("Unsupported LFG interaction."));
}

export async function handleLfgModalSubmitInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  discordBotToken: string,
  services: Partial<ServiceFactory> = {},
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  if (waitUntil) {
    waitUntil(
      handleLfgModalSubmitInteraction(interaction, stores, discordBotToken, services)
        .then(async (response) => {
          const body = (await response.json()) as { data: { content: string } };
          if (interaction.application_id && interaction.token) {
            await editOriginalInteractionResponse(
              interaction.application_id,
              interaction.token,
              body.data,
            );
          }
        })
        .catch(async (error) => {
          console.error("Deferred LFG submission failed", error);
          if (interaction.application_id && interaction.token) {
            await editOriginalInteractionResponse(interaction.application_id, interaction.token, {
              content:
                "Could not confirm the LFG submission. Check the noticeboard before retrying.",
            });
          }
        }),
    );
    return Response.json({
      type: DISCORD_DEFERRED_CHANNEL_MESSAGE_RESPONSE,
      data: { flags: DISCORD_EPHEMERAL_FLAG },
    });
  }
  const parsed = parseLfgCustomId(getInteractionCustomId(interaction) ?? "");
  if (
    !parsed ||
    (parsed.action !== "modal" &&
      parsed.action !== "modal-clan" &&
      parsed.action !== "edit-modal" &&
      parsed.action !== "apply-modal") ||
    typeof interaction.guild_id !== "string"
  ) {
    return Response.json(buildEphemeralMessage("Unsupported LFG form."));
  }
  const userId = getInteractionUserId(interaction);
  const channelId = interaction.channel_id;
  if (!userId || !channelId) {
    return Response.json(buildEphemeralMessage("Could not create LFG post here."));
  }

  const fields = parseInteractionModalFieldValues(interaction);
  try {
    const service = resolveLfgService(stores, discordBotToken, services);
    if (parsed.action === "modal" || parsed.action === "modal-clan") {
      const post = await service.createPost({
        guildId: interaction.guild_id,
        channelId,
        ownerId: userId,
        ownerDisplayName: getInteractionUserDisplayName(interaction) ?? "Unknown user",
        serverId: fields.server_id ?? parsed.serverId,
        whenPlay: fields.when_play ?? "",
        lookingFor: fields.looking_for ?? "",
        extraInfo: fields.extra_info ?? "",
        scope: parsed.action === "modal-clan" ? "clan" : "public",
      });
      return Response.json(buildEphemeralMessage("LFG post created." + lfgPostLink(post)));
    }

    if (parsed.action === "apply-modal") {
      await service.submitApplication({
        guildId: interaction.guild_id,
        postId: parsed.postId,
        applicantId: userId,
        applicantDisplayName: getInteractionUserDisplayName(interaction) ?? "Unknown user",
        message: fields.application_message ?? "",
      });
      return Response.json(buildEphemeralMessage("Your LFG application has been submitted."));
    }

    const post = await stores.lfg.readLfgPost(interaction.guild_id, parsed.postId);
    if (!post) {
      return Response.json(buildEphemeralMessage("This LFG post is no longer active."));
    }
    await service.editPost({
      guildId: interaction.guild_id,
      postId: parsed.postId,
      ownerId: userId,
      serverId: fields.server_id ?? post.serverId,
      whenPlay: fields.when_play ?? "",
      lookingFor: fields.looking_for ?? "",
      extraInfo: fields.extra_info ?? "",
    });
    return Response.json(buildEphemeralMessage("LFG post updated."));
  } catch (error) {
    if (parsed.action === "modal" || parsed.action === "modal-clan") {
      const existing = await stores.lfg.readActiveLfgPostByOwner(interaction.guild_id, userId);
      if (existing?.messageId) {
        return Response.json(
          buildEphemeralMessage(
            `You have an active LFG post. [View post](https://discord.com/channels/${existing.guildId}/${existing.channelId}/${existing.messageId}) before creating another.`,
          ),
        );
      }
    }
    rethrowDiscordRateLimit(error);
    return Response.json(buildEphemeralMessage(describeLfgError(error)));
  }
}

function lfgPostLink(post: LfgPost): string {
  return post.active && post.guildId && post.channelId && post.messageId
    ? `\n\n[View post](https://discord.com/channels/${post.guildId}/${post.channelId}/${post.messageId})`
    : "";
}

function resolveLfgService(
  stores: RuntimeStores,
  discordBotToken: string,
  services: Partial<ServiceFactory>,
) {
  return services.lfgService ?? createServiceFactory({ stores, discordBotToken }).lfgService;
}

function describeLfgError(error: unknown): string {
  if (error instanceof LfgActivePostError || error instanceof LfgConfigError) {
    return error.message;
  }
  console.error("LFG interaction failed", error);
  return "Something went wrong with LFG. Please contact an admin.";
}

const MANAGE_MESSAGES_PERMISSION = 1n << 13n;

function hasManageMessagesPermission(permissions: string): boolean {
  try {
    const perms = BigInt(permissions);
    return (perms & MANAGE_MESSAGES_PERMISSION) !== 0n;
  } catch {
    return false;
  }
}

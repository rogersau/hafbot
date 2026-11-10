import { buildEphemeralMessage } from "../discord-interactions";
import { editChannelMessage } from "../discord/messages";
import type { CreateChannelMessageInput } from "../discord/messages";
import { postMessageAuditEvent } from "../services/guild-audit-log-service";
import { signSensitiveMessageComponentIds } from "../security/sensitive-component-ids";
import type { ComponentIdSigner } from "../security/component-id-signer";
import type { DiscordInteraction, RuntimeStores } from "./app-types";
import { getInteractionCustomId, getInteractionUserId } from "./discord-interaction-parsers";
import { hasInteractionAdminAccess } from "./interaction-admin-access";
import {
  buildBotDefenseComponentId,
  parseBotDefenseComponentId,
} from "../bot-defense-component-id";
import {
  GUILD_BOUND_INTERACTION_DENIAL_MESSAGE,
  isInteractionBoundToGuild,
} from "./interaction-guild-binding";

export function isBotDefenseComponentInteraction(interaction: DiscordInteraction): boolean {
  const customId = getInteractionCustomId(interaction);
  return parseBotDefenseComponentId(customId) !== null;
}

export async function handleBotDefenseComponentInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  discordBotToken: string,
  componentIdSigner?: ComponentIdSigner,
): Promise<Response> {
  const customId = getInteractionCustomId(interaction);
  const parsed = parseBotDefenseComponentId(customId);
  if (!parsed) {
    return Response.json(buildEphemeralMessage("Unsupported Bot Defense action."));
  }
  if (parsed.kind === "legacy") {
    return Response.json(
      buildEphemeralMessage(
        "This Bot Defense control predates generation binding and is no longer available.",
      ),
    );
  }

  const { guildId, userId, action, createdAtMs } = parsed;
  if (!isInteractionBoundToGuild(interaction, guildId)) {
    return Response.json(buildEphemeralMessage(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE));
  }

  const flag = await stores.botDefense.readOpenBotFlag(guildId, userId, createdAtMs);
  if (!flag || flag.createdAtMs !== createdAtMs) {
    return Response.json(
      buildEphemeralMessage(
        "This Bot Defense control is stale, was not found, or the flag is already resolved.",
      ),
    );
  }
  if (!isInteractionBoundToGuild(interaction, guildId, flag.guildId)) {
    return Response.json(buildEphemeralMessage(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE));
  }

  const config = await stores.botDefense.readConfig(flag.guildId);
  const authorized = config?.modRoleIds.length
    ? getInteractionMemberRoles(interaction).some((roleId) => config.modRoleIds.includes(roleId))
    : await hasInteractionAdminAccess(interaction, stores);
  if (!authorized) {
    return Response.json(
      buildEphemeralMessage("Only Bot Defense moderators can resolve this flag."),
    );
  }

  const actorUserId = getInteractionUserId(interaction);
  if (!actorUserId) {
    return Response.json(buildEphemeralMessage("Could not determine your Discord user."));
  }

  const resolution = action === "confirm" ? "confirmed" : "dismissed";
  const resolved = await stores.botDefense.resolveBotFlag(
    guildId,
    userId,
    createdAtMs,
    resolution,
    actorUserId,
  );
  if (!resolved || resolved.status === "open" || resolved.createdAtMs !== createdAtMs) {
    return Response.json(buildEphemeralMessage("This Bot Defense flag has already been handled."));
  }

  const resolvedByDiscordUserId = resolved.resolvedByDiscordUserId;
  if (!resolvedByDiscordUserId) {
    return Response.json(buildEphemeralMessage("This Bot Defense flag has already been handled."));
  }
  const resolvedAction = resolved.status === "confirmed" ? "confirm" : "dismiss";

  if (resolved.queueMessageId && config?.modQueueChannelId) {
    const resolvedQueueMessage = await signSensitiveMessageComponentIds(
      buildResolvedQueueMessage(resolved, resolved.status, resolvedByDiscordUserId),
      componentIdSigner,
      { guildId: resolved.guildId },
    );
    await editChannelMessage(
      config.modQueueChannelId,
      resolved.queueMessageId,
      resolvedQueueMessage,
      discordBotToken,
    );
  }

  const eventId = resolvedAction === "confirm" ? "bot-defense.confirm" : "bot-defense.dismiss";
  await postMessageAuditEvent(
    eventId,
    {
      guildId: resolved.guildId,
      channelId: config?.modQueueChannelId ?? "",
      messageId: resolved.queueMessageId ?? undefined,
      content: `${resolvedAction === "confirm" ? "Confirmed" : "Dismissed"} by <@${resolvedByDiscordUserId}>`,
      author: { id: resolved.userId },
    },
    stores.guildAuditLog,
    discordBotToken,
  );

  return Response.json(
    buildEphemeralMessage(
      resolvedAction === "confirm"
        ? "Flag confirmed. No automatic action was taken."
        : "Flag dismissed.",
    ),
  );
}

function buildResolvedQueueMessage(
  flag: NonNullable<Awaited<ReturnType<RuntimeStores["botDefense"]["readOpenBotFlag"]>>>,
  status: "confirmed" | "dismissed",
  actorUserId: string,
): CreateChannelMessageInput {
  const title = status === "confirmed" ? "Bot Defense: Confirmed" : "Bot Defense: Dismissed";
  const color = status === "confirmed" ? 0x2f855a : 0x95a5a6;
  const description =
    status === "confirmed"
      ? `Confirmed by <@${actorUserId}>. The bot takes no Discord enforcement action.`
      : `Dismissed by <@${actorUserId}>.`;

  const fields = [
    {
      name: "Detector",
      value: flag.detectorType === "honeypot" ? "Honeypot" : "Rate",
      inline: false,
    },
    { name: "Flagged Member", value: `<@${flag.userId}>\nID: ${flag.userId}`, inline: false },
  ];

  if (flag.evidence.kind === "honeypot") {
    fields.push(
      { name: "Honeypot Channel", value: `<#${flag.evidence.channelId}>`, inline: false },
      {
        name: "Tripping Message",
        value: `https://discord.com/channels/${flag.guildId}/${flag.evidence.channelId}/${flag.evidence.messageId}`,
        inline: false,
      },
    );
  } else {
    fields.push(
      { name: "Distinct Channels", value: String(flag.evidence.channelCount), inline: false },
      { name: "Window", value: `${flag.evidence.windowSeconds}s`, inline: false },
    );
  }

  return {
    content: "Bot Defense flag resolved.",
    embeds: [
      {
        title,
        description,
        color,
        fields,
        footer: { text: "hafbot.xyz" },
        timestamp: new Date().toISOString(),
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 4,
            label: "Confirm Bot",
            custom_id: buildBotDefenseComponentId(
              "confirm",
              flag.guildId,
              flag.userId,
              flag.createdAtMs,
            ),
            disabled: true,
          },
          {
            type: 2,
            style: 2,
            label: "Dismiss",
            custom_id: buildBotDefenseComponentId(
              "dismiss",
              flag.guildId,
              flag.userId,
              flag.createdAtMs,
            ),
            disabled: true,
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function getInteractionMemberRoles(interaction: DiscordInteraction): string[] {
  const roles = interaction.member?.roles;
  return Array.isArray(roles)
    ? roles.filter((roleId): roleId is string => typeof roleId === "string")
    : [];
}

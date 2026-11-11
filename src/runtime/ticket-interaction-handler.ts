import { rethrowDiscordRateLimit } from "./interaction-rate-limit";
import { isRecord } from "../unknown-parse";
import {
  createChannelMessage,
  editChannelMessage,
  fetchChannelMessage,
  listChannelMessages,
  createPrivateThread,
  createTicketChannel,
  addTicketParticipantAccess,
  readTicketParticipantAccess,
  removeTicketParticipantAccess,
  deleteChannel,
  editOriginalInteractionResponse,
  allowUserMentions,
  formatUserMention,
  uploadTranscriptToChannel,
  DiscordApiError,
  isDiscordRateLimitError,
} from "../discord";
import { buildAuditEmbed, suppressMentions } from "../discord/messages";
import { buildEphemeralMessage } from "../discord-interactions";
import {
  buildTicketHistoryPageCustomId,
  buildTicketHistoryPromptCustomId,
  buildTicketTemplateReplyCustomId,
  buildTicketModalResponse,
  extractTicketAnswersFromModal,
  parseTicketCustomId,
} from "../tickets";
import type { TicketInstance, TicketLinkPlatform, TicketPanelConfig } from "../types";
import type { DiscordInteraction } from "./app-types";
import type { RuntimeStores } from "./app-types";
import type { TicketTranscriptBlobStore, TicketTranscriptCapabilityAccess } from "./contracts";
import { buildTicketTranscriptArtifacts } from "./ticket-transcript-collector";
import {
  summarizeTicket,
  type AiTranscriptSummary,
} from "../services/tickets/ai-transcript-summarizer";
import { type AiTranscriptSummarizerEnv } from "../services/tickets/ai-transcript-summarizer-env";
import {
  buildTicketOpeningMessage,
  createTicketLifecycle,
  type TicketLifecycle,
} from "../services/tickets/ticket-lifecycle";
import { buildAnonymousSupportHelperMessage } from "../services/tickets/anonymous-staff-thread";
import { toDiscordManagedMessageEmbed } from "../services/managed-message-service";
import { resolveAuditChannelId } from "../services/guild-audit-log-service";
import { hasInteractionAdminAccess } from "./interaction-admin-access";
import type { ComponentIdSigner } from "../security/component-id-signer";
import {
  signSensitiveComponentId,
  signSensitiveMessageComponentIds,
} from "../security/sensitive-component-ids";
import {
  getInteractionCustomId,
  getInteractionUserDisplayName,
  getInteractionUserId,
} from "./discord-interaction-parsers";
import {
  DISCORD_BUTTON_COMPONENT,
  DISCORD_DEFERRED_CHANNEL_MESSAGE_RESPONSE,
  DISCORD_EPHEMERAL_FLAG,
  DISCORD_MESSAGE_COMPONENT_ROW,
  DISCORD_UPDATE_MESSAGE_RESPONSE,
  DISCORD_AUTOCOMPLETE_RESPONSE,
} from "../discord/constants";

export async function handleMessageComponentInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  discordBotToken: string,
  requestOrigin: string,
  ticketTranscriptBlobs?: TicketTranscriptBlobStore,
  waitUntil?: (promise: Promise<unknown>) => void,
  aiTranscriptSummarizerEnv?: AiTranscriptSummarizerEnv,
  ticketLifecycle?: TicketLifecycle,
  ticketTranscriptCapabilities?: TicketTranscriptCapabilityAccess,
  componentIdSigner?: ComponentIdSigner,
): Promise<Response> {
  if (typeof interaction.guild_id !== "string" || interaction.guild_id.length === 0) {
    return Response.json(
      buildEphemeralMessage("This interaction can only be used inside a server."),
    );
  }
  const guildId = interaction.guild_id;

  const customId = getInteractionCustomId(interaction);
  if (!customId) {
    return Response.json(buildEphemeralMessage("Unsupported interaction."));
  }

  const parsedCustomId = parseTicketCustomId(customId);
  if (!parsedCustomId) {
    return Response.json(buildEphemeralMessage("Unsupported interaction."));
  }

  if (parsedCustomId.action === "open") {
    const prepared = await getTicketLifecycle(stores, ticketLifecycle).prepareOpen({
      guildId,
      panelId: parsedCustomId.panelId ?? "main",
      ticketTypeId: parsedCustomId.ticketTypeId,
      memberRoleIds: getInteractionMemberRoles(interaction),
    });
    if (!prepared.ok) return Response.json(buildEphemeralMessage(prepared.message));
    const { panel, ticketType } = prepared;

    const openerUserId = getInteractionUserId(interaction);
    if (!openerUserId) {
      return Response.json(
        buildEphemeralMessage("Could not determine which user opened this ticket."),
      );
    }

    if (ticketType.questions.length === 0) {
      return deferTicketInteraction(interaction, waitUntil, () =>
        createTicketFromInteraction({
          guildId,
          openerUserId,
          openerRoleIds: getInteractionMemberRoles(interaction),
          panelId: panel.panelId ?? "main",
          ticketTypeId: ticketType.id,
          answers: [],
          stores,
          discordBotToken,
          ticketLifecycle,
          componentIdSigner,
        }),
      );
    }

    return Response.json(buildTicketModalResponse(ticketType, panel.panelId));
  }

  if (parsedCustomId.action === "history-open" || parsedCustomId.action === "history-page") {
    const requesterUserId = getInteractionUserId(interaction);
    if (!requesterUserId || requesterUserId !== parsedCustomId.requesterUserId) {
      return Response.json(
        buildEphemeralMessage("Only the staff member who requested this history can use it."),
      );
    }
    const message = await buildTicketHistoryMessage({
      stores,
      guildId,
      requesterUserId,
      targetUserId: parsedCustomId.targetUserId,
      excludeChannelId: parsedCustomId.excludeChannelId,
      beforeOpenedAtMs:
        parsedCustomId.action === "history-page" ? parsedCustomId.beforeOpenedAtMs : null,
    });
    return Response.json(
      parsedCustomId.action === "history-page"
        ? { type: DISCORD_UPDATE_MESSAGE_RESPONSE, data: message }
        : { type: 4, data: { ...message, flags: DISCORD_EPHEMERAL_FLAG } },
    );
  }

  if (parsedCustomId.action === "history-prompt") {
    const requesterUserId = getInteractionUserId(interaction);
    if (!requesterUserId) {
      return Response.json(
        buildEphemeralMessage("Could not determine who requested this history."),
      );
    }
    const ticket = await stores.tickets.readOpenTicketByChannel(
      guildId,
      parsedCustomId.ticketChannelId,
    );
    const isSupport =
      ticket?.supportRoleId !== null &&
      ticket?.supportRoleId !== undefined &&
      getInteractionMemberRoles(interaction).includes(ticket.supportRoleId);
    if (!ticket || (!isSupport && !(await hasInteractionAdminAccess(interaction, stores)))) {
      return Response.json(
        buildEphemeralMessage(
          "Only ticket support staff or a server admin can view Ticket History.",
        ),
      );
    }
    const message = await buildTicketHistoryMessage({
      stores,
      guildId,
      requesterUserId,
      targetUserId: parsedCustomId.targetUserId,
      excludeChannelId: parsedCustomId.ticketChannelId,
      beforeOpenedAtMs: null,
    });
    return Response.json({ type: 4, data: { ...message, flags: DISCORD_EPHEMERAL_FLAG } });
  }

  switch (parsedCustomId.action) {
    case "template-reply":
      return handleTicketTemplateReplyConfirmation(
        interaction,
        guildId,
        parsedCustomId.ticketChannelId,
        parsedCustomId.templateId,
        parsedCustomId.templateUpdatedAtMs,
        stores,
        discordBotToken,
        ticketLifecycle,
      );
    case "close-request":
      return handleTicketCloseRequestInteraction(
        interaction,
        guildId,
        parsedCustomId.channelId,
        stores,
        discordBotToken,
        ticketLifecycle,
        componentIdSigner,
      );
    case "claim":
      return handleTicketClaimInteraction(
        interaction,
        guildId,
        parsedCustomId.channelId,
        stores,
        discordBotToken,
        ticketLifecycle,
        waitUntil,
      );
    case "close-confirm":
      return handleTicketCloseConfirmationInteraction(
        interaction,
        guildId,
        parsedCustomId.channelId,
        stores,
        discordBotToken,
        requestOrigin,
        ticketTranscriptBlobs,
        waitUntil,
        aiTranscriptSummarizerEnv,
        ticketLifecycle,
        ticketTranscriptCapabilities,
      );
    case "close-decline":
      return handleTicketCloseDeclineInteraction(
        interaction,
        guildId,
        parsedCustomId.channelId,
        stores,
        ticketLifecycle,
      );
    case "close":
      return handleTicketCloseInteraction(
        interaction,
        guildId,
        parsedCustomId.channelId,
        stores,
        discordBotToken,
        requestOrigin,
        ticketTranscriptBlobs,
        waitUntil,
        aiTranscriptSummarizerEnv,
        ticketLifecycle,
        ticketTranscriptCapabilities,
      );
    default:
      return Response.json(buildEphemeralMessage("Unsupported interaction."));
  }
}

export async function handleTicketSlashCommandInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  discordBotToken: string,
  requestOrigin: string,
  subcommandName:
    | "close"
    | "request-close"
    | "claim"
    | "history"
    | "reply"
    | "add-user"
    | "remove-user",
  ticketTranscriptBlobs?: TicketTranscriptBlobStore,
  waitUntil?: (promise: Promise<unknown>) => void,
  aiTranscriptSummarizerEnv?: AiTranscriptSummarizerEnv,
  templateId?: string,
  ticketLifecycle?: TicketLifecycle,
  participantUserId?: string,
  ticketTranscriptCapabilities?: TicketTranscriptCapabilityAccess,
  componentIdSigner?: ComponentIdSigner,
): Promise<Response> {
  if (typeof interaction.guild_id !== "string" || interaction.guild_id.length === 0) {
    return Response.json(buildEphemeralMessage("This command can only be used inside a server."));
  }

  if (typeof interaction.channel_id !== "string" || interaction.channel_id.length === 0) {
    return Response.json(
      buildEphemeralMessage("This command can only be used in a ticket channel."),
    );
  }

  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id;

  if (subcommandName === "history") {
    return handleTicketHistoryCommand(interaction, guildId, channelId, stores);
  }

  if (subcommandName === "reply") {
    return handleTicketTemplateReplyPreview(
      interaction,
      guildId,
      channelId,
      templateId ?? "",
      stores,
      ticketLifecycle,
      componentIdSigner,
    );
  }

  switch (subcommandName) {
    case "close":
      return handleTicketCloseInteraction(
        interaction,
        guildId,
        channelId,
        stores,
        discordBotToken,
        requestOrigin,
        ticketTranscriptBlobs,
        waitUntil,
        aiTranscriptSummarizerEnv,
        ticketLifecycle,
        ticketTranscriptCapabilities,
      );
    case "request-close":
      return handleTicketCloseRequestInteraction(
        interaction,
        guildId,
        channelId,
        stores,
        discordBotToken,
        ticketLifecycle,
        componentIdSigner,
      );
    case "claim":
      return handleTicketClaimInteraction(
        interaction,
        guildId,
        channelId,
        stores,
        discordBotToken,
        ticketLifecycle,
        waitUntil,
      );
    case "add-user":
    case "remove-user":
      return handleTicketParticipantCommand(
        interaction,
        guildId,
        channelId,
        participantUserId ?? "",
        subcommandName,
        stores,
        discordBotToken,
        ticketLifecycle,
      );
    default:
      return Response.json(buildEphemeralMessage("Unsupported command."));
  }
}

export async function handleTicketReplyAutocompleteInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  ticketLifecycle?: TicketLifecycle,
): Promise<Response> {
  if (!isRecord(interaction.data) || interaction.data.name !== "ticket") {
    return Response.json({ type: DISCORD_AUTOCOMPLETE_RESPONSE, data: { choices: [] } });
  }
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id;
  if (!guildId || !channelId || !stores.messageTemplates) {
    return Response.json({ type: DISCORD_AUTOCOMPLETE_RESPONSE, data: { choices: [] } });
  }
  const authorization = await authorizeTicketTemplateReply(
    interaction,
    stores,
    getTicketLifecycle(stores, ticketLifecycle),
    guildId,
    channelId,
  );
  if (!authorization.ok) {
    return Response.json({ type: DISCORD_AUTOCOMPLETE_RESPONSE, data: { choices: [] } });
  }
  const query = getTicketReplyTemplateOption(interaction, true).toLowerCase();
  const templates = await stores.messageTemplates.listTicketReplyTemplates(guildId);
  const choices = templates
    .filter((template) => !query || template.internalName.toLowerCase().includes(query))
    .slice(0, 25)
    .map((template) => ({ name: template.internalName.slice(0, 100), value: template.id }));
  return Response.json({ type: DISCORD_AUTOCOMPLETE_RESPONSE, data: { choices } });
}

async function handleTicketParticipantCommand(
  interaction: DiscordInteraction,
  guildId: string,
  channelId: string,
  targetUserId: string,
  action: "add-user" | "remove-user",
  stores: RuntimeStores,
  discordBotToken: string,
  ticketLifecycle?: TicketLifecycle,
): Promise<Response> {
  const actorUserId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!actorUserId || !targetUserId) {
    return Response.json(buildEphemeralMessage("Could not determine the selected member."));
  }
  const data = isRecord(interaction.data) ? interaction.data : null;
  const resolved = data && isRecord(data.resolved) ? data.resolved : null;
  const members = resolved && isRecord(resolved.members) ? resolved.members : null;
  const users = resolved && isRecord(resolved.users) ? resolved.users : null;
  const targetUser = users && isRecord(users[targetUserId]) ? users[targetUserId] : null;
  const lifecycle = getTicketLifecycle(stores, ticketLifecycle);
  const adapters = {
    readAccess: (ticketChannelId: string, userId: string) =>
      readTicketParticipantAccess(ticketChannelId, userId, discordBotToken),
    grantAccess: (ticketChannelId: string, userId: string) =>
      addTicketParticipantAccess(ticketChannelId, userId, discordBotToken),
    revokeAccess: (ticketChannelId: string, userId: string) =>
      removeTicketParticipantAccess(ticketChannelId, userId, discordBotToken),
    postNeutralMessage: (ticketChannelId: string, content: string) =>
      createChannelMessage(
        ticketChannelId,
        { content, allowed_mentions: suppressMentions() },
        discordBotToken,
      ).then(() => undefined),
  };
  const common = {
    guildId,
    channelId,
    actorUserId,
    actorRoleIds: getInteractionMemberRoles(interaction),
    isAdmin: await hasInteractionAdminAccess(interaction, stores),
    targetUserId,
    nowMs: Date.now(),
  };
  const result =
    action === "add-user"
      ? await lifecycle.addParticipant(adapters, {
          ...common,
          targetIsGuildMember: Boolean(members && members[targetUserId]),
          targetIsBot: targetUser?.bot === true,
        })
      : await lifecycle.removeParticipant(adapters, common);
  if (!result.ok) return Response.json(buildEphemeralMessage(result.message));
  return Response.json(
    buildEphemeralMessage(
      result.duplicate
        ? action === "add-user"
          ? "That member already has participant access."
          : "That member is not an added participant."
        : action === "add-user"
          ? "Participant added."
          : "Participant removed.",
    ),
  );
}

async function handleTicketTemplateReplyPreview(
  interaction: DiscordInteraction,
  guildId: string,
  channelId: string,
  templateId: string,
  stores: RuntimeStores,
  ticketLifecycle?: TicketLifecycle,
  componentIdSigner?: ComponentIdSigner,
): Promise<Response> {
  const lifecycle = getTicketLifecycle(stores, ticketLifecycle);
  const authorization = await authorizeTicketTemplateReply(
    interaction,
    stores,
    lifecycle,
    guildId,
    channelId,
  );
  if (!authorization.ok) return Response.json(buildEphemeralMessage(authorization.message));
  const templateResult = await lifecycle.readTemplateReply({ guildId, templateId });
  if (!templateResult.ok) return Response.json(buildEphemeralMessage(templateResult.message));
  const { ticket } = authorization;
  const { template } = templateResult;
  const actorUserId = getInteractionUserId(interaction);
  if (componentIdSigner && !actorUserId) {
    return Response.json(buildEphemeralMessage("Could not identify this ticket reply."));
  }
  const customId = await signSensitiveComponentId(
    buildTicketTemplateReplyCustomId(ticket.channelId, template.id, template.updatedAtMs),
    componentIdSigner,
    {
      guildId,
      actorUserId: actorUserId ?? undefined,
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
    },
  );
  return Response.json({
    type: 4,
    data: {
      content: `Previewing **${template.internalName}**. Nothing has been sent yet.`,
      embeds: template.embeds.map(toDiscordManagedMessageEmbed),
      components: [
        {
          type: DISCORD_MESSAGE_COMPONENT_ROW,
          components: [
            {
              type: DISCORD_BUTTON_COMPONENT,
              custom_id: customId,
              label: "Send",
              style: 1,
            },
          ],
        },
      ],
      flags: DISCORD_EPHEMERAL_FLAG,
      allowed_mentions: { parse: [] },
    },
  });
}

async function handleTicketTemplateReplyConfirmation(
  interaction: DiscordInteraction,
  guildId: string,
  ticketChannelId: string,
  templateId: string,
  templateUpdatedAtMs: number,
  stores: RuntimeStores,
  discordBotToken: string,
  ticketLifecycle?: TicketLifecycle,
): Promise<Response> {
  const lifecycle = getTicketLifecycle(stores, ticketLifecycle);
  const authorization = await authorizeTicketTemplateReply(
    interaction,
    stores,
    lifecycle,
    guildId,
    ticketChannelId,
  );
  if (!authorization.ok) return Response.json(buildEphemeralMessage(authorization.message));
  const staffUserId = getInteractionUserId(interaction);
  const interactionId = interaction.id;
  if (!staffUserId || !interactionId) {
    return Response.json(buildEphemeralMessage("Could not identify this confirmed reply."));
  }
  let result = await lifecycle.deliverTemplateReply(
    {
      async deliver(channelId, template) {
        const message = await createChannelMessage(
          channelId,
          {
            embeds: template.embeds.map(toDiscordManagedMessageEmbed),
            allowed_mentions: { parse: [] },
          },
          discordBotToken,
        );
        return message.id;
      },
    },
    {
      guildId,
      channelId: ticketChannelId,
      actorRoleIds: getInteractionMemberRoles(interaction),
      isAdmin: !(
        authorization.ticket.supportRoleId &&
        getInteractionMemberRoles(interaction).includes(authorization.ticket.supportRoleId)
      ),
      templateId,
      templateUpdatedAtMs,
      interactionId,
      staffUserId,
      nowMs: Date.now(),
    },
  );
  if (!result.ok && result.code === "partial-success" && result.recovery) {
    result = await lifecycle.resumeTemplateReplyCompletion(result.recovery);
    if (!result.ok && result.code === "partial-success" && result.recovery) {
      await deferTicketRecovery(lifecycle, {
        kind: "template-reply-completion",
        recovery: result.recovery,
      });
    }
  }
  if (!result.ok) return Response.json(buildEphemeralMessage(result.message));
  if (result.duplicate) {
    return Response.json({
      type: DISCORD_UPDATE_MESSAGE_RESPONSE,
      data: { content: "This Ticket Template Reply was already sent.", embeds: [], components: [] },
    });
  }
  return Response.json({
    type: DISCORD_UPDATE_MESSAGE_RESPONSE,
    data: { content: `Sent **${result.template.internalName}**.`, embeds: [], components: [] },
  });
}

function getTicketReplyTemplateOption(
  interaction: DiscordInteraction,
  focusedOnly = false,
): string {
  if (!isRecord(interaction.data) || !Array.isArray(interaction.data.options)) return "";
  const reply = interaction.data.options.find(
    (option) => isRecord(option) && option.name === "reply",
  );
  if (!isRecord(reply) || !Array.isArray(reply.options)) return "";
  const template = reply.options.find(
    (option) =>
      isRecord(option) && option.name === "template" && (!focusedOnly || option.focused === true),
  );
  return isRecord(template) && typeof template.value === "string" ? template.value : "";
}

async function handleTicketHistoryCommand(
  interaction: DiscordInteraction,
  guildId: string,
  channelId: string,
  stores: RuntimeStores,
): Promise<Response> {
  const requesterUserId = getInteractionUserId(interaction);
  if (!requesterUserId) {
    return Response.json(buildEphemeralMessage("Could not determine who requested this history."));
  }

  const explicitUserId = getTicketHistoryUserOption(interaction);
  const currentTicket = await stores.tickets.readOpenTicketByChannel(guildId, channelId);
  if (currentTicket) {
    const roles = getInteractionMemberRoles(interaction);
    const isSupport =
      currentTicket.supportRoleId !== null && roles.includes(currentTicket.supportRoleId);
    if (!isSupport && !(await hasInteractionAdminAccess(interaction, stores))) {
      return Response.json(
        buildEphemeralMessage(
          "Only ticket support staff or a server admin can view Ticket History.",
        ),
      );
    }
    const message = await buildTicketHistoryMessage({
      stores,
      guildId,
      requesterUserId,
      targetUserId: explicitUserId ?? currentTicket.openerUserId,
      excludeChannelId: currentTicket.channelId,
      beforeOpenedAtMs: null,
    });
    return Response.json({
      type: 4,
      data: { ...message, flags: DISCORD_EPHEMERAL_FLAG },
    });
  }

  if (!explicitUserId) {
    return Response.json(
      buildEphemeralMessage(
        "Choose a user when running `/ticket history` outside a Ticket channel.",
      ),
    );
  }
  if (!(await hasInteractionAdminAccess(interaction, stores))) {
    return Response.json(
      buildEphemeralMessage("You need server admin access to view Ticket History here."),
    );
  }
  const message = await buildTicketHistoryMessage({
    stores,
    guildId,
    requesterUserId,
    targetUserId: explicitUserId,
    excludeChannelId: null,
    beforeOpenedAtMs: null,
  });
  return Response.json({ type: 4, data: { ...message, flags: DISCORD_EPHEMERAL_FLAG } });
}

async function buildTicketHistoryMessage(options: {
  stores: RuntimeStores;
  guildId: string;
  requesterUserId: string;
  targetUserId: string;
  excludeChannelId: string | null;
  beforeOpenedAtMs: number | null;
}) {
  const page = await options.stores.tickets.listMemberTicketHistory({
    guildId: options.guildId,
    openerUserId: options.targetUserId,
    excludeChannelId: options.excludeChannelId,
    limit: 10,
    beforeOpenedAtMs: options.beforeOpenedAtMs,
  });
  const panels = await options.stores.tickets.listTicketPanelConfigs(options.guildId);
  const panelById = new Map(panels.map((panel) => [panel.panelId ?? "main", panel]));
  const fields = page.tickets.map((ticket) => {
    const opened = `<t:${Math.floor(ticket.openedAtMs / 1000)}:d>`;
    const closed = ticket.closedAtMs
      ? ` · closed <t:${Math.floor(ticket.closedAtMs / 1000)}:d>`
      : "";
    const panel = panelById.get(ticket.panelId ?? "main");
    const link =
      ticket.status === "open"
        ? `https://discord.com/channels/${ticket.guildId}/${ticket.channelId}`
        : ticket.transcriptMessageId && panel?.transcriptChannelId
          ? `https://discord.com/channels/${ticket.guildId}/${panel.transcriptChannelId}/${ticket.transcriptMessageId}`
          : null;
    return {
      name: `${ticket.status === "open" ? "Open" : "Closed"} · ${ticket.ticketTypeLabel}`,
      value: `${opened}${closed}\n${link ? `[Open in Discord](${link})` : "Transcript link unavailable"}`,
    };
  });
  const components = page.nextCursor
    ? [
        {
          type: DISCORD_MESSAGE_COMPONENT_ROW,
          components: [
            {
              type: DISCORD_BUTTON_COMPONENT,
              custom_id: buildTicketHistoryPageCustomId(
                options.requesterUserId,
                options.targetUserId,
                options.excludeChannelId,
                page.nextCursor,
              ),
              label: "Load next 10",
              style: 2,
            },
          ],
        },
      ]
    : [];
  return {
    embeds: [
      {
        title: "Ticket History",
        description:
          page.total === 0
            ? `<@${options.targetUserId}> has no other Tickets in this server.`
            : `${page.total} Ticket${page.total === 1 ? "" : "s"} for <@${options.targetUserId}>`,
        color: 0x5865f2,
        fields,
      },
    ],
    components,
    allowed_mentions: { parse: [] },
  };
}

function getTicketHistoryUserOption(interaction: DiscordInteraction): string | null {
  if (!isRecord(interaction.data) || !Array.isArray(interaction.data.options)) return null;
  const subcommand = interaction.data.options.find(
    (option) => isRecord(option) && option.name === "history",
  );
  if (!isRecord(subcommand) || !Array.isArray(subcommand.options)) return null;
  const user = subcommand.options.find((option) => isRecord(option) && option.name === "user");
  return isRecord(user) && typeof user.value === "string" ? user.value : null;
}

async function handleTicketClaimInteraction(
  interaction: DiscordInteraction,
  guildId: string,
  requestedChannelId: string,
  stores: RuntimeStores,
  discordBotToken: string,
  ticketLifecycle?: TicketLifecycle,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  if (waitUntil) {
    return deferTicketInteraction(
      interaction,
      waitUntil,
      () =>
        handleTicketClaimInteraction(
          interaction,
          guildId,
          requestedChannelId,
          stores,
          discordBotToken,
          ticketLifecycle,
        ),
      "Failed to claim this ticket.",
    );
  }
  const userId = getInteractionUserId(interaction);
  if (!userId) {
    return Response.json(buildEphemeralMessage("Could not determine who is claiming this ticket."));
  }

  const channelId = resolveTicketChannelId(interaction, requestedChannelId);
  if (!channelId) {
    return Response.json(buildEphemeralMessage("That ticket claim button is no longer valid."));
  }

  let claimCommitted = false;
  try {
    const claim = await getTicketLifecycle(stores, ticketLifecycle).claim({
      guildId,
      channelId,
      actorUserId: userId,
      actorRoleIds: getInteractionMemberRoles(interaction),
      nowMs: Date.now(),
    });
    if (!claim.ok) return Response.json(buildEphemeralMessage(claim.message));
    claimCommitted = true;
    await getTicketLifecycle(stores, ticketLifecycle).deliverClaim(
      {
        refreshOpeningMessage: (ticket) =>
          refreshTicketClaimOpeningMessage(interaction, ticket, stores, discordBotToken),
        announce: async (nonce) => {
          await createChannelMessage(
            claim.ticket.channelId,
            {
              content: `Ticket claimed by ${formatUserMention(claim.claimedByUserId)}.`,
              allowed_mentions: allowUserMentions([claim.claimedByUserId]),
              nonce,
              enforce_nonce: true,
            },
            discordBotToken,
          );
        },
        audit: (nonce) =>
          postTicketAuditEvent(stores, discordBotToken, "ticket.claim", {
            guildId: claim.ticket.guildId,
            channelId: claim.ticket.channelId,
            actorUserId: claim.claimedByUserId,
            ticketTypeLabel: claim.ticket.ticketTypeLabel,
            nonce,
          }),
      },
      claim,
    );
    if (claim.alreadyClaimed) {
      return Response.json(buildEphemeralMessage("You have already claimed this ticket."));
    }
    return Response.json(buildEphemeralMessage("Claimed this ticket."));
  } catch (error) {
    if (claimCommitted) {
      console.error("Ticket claim saved but Discord notification failed", error);
      return Response.json(
        buildEphemeralMessage(
          "You have claimed this ticket, but its Discord updates are incomplete. Use the claim button or /ticket claim again to finish them.",
        ),
      );
    }
    rethrowDiscordRateLimit(error);
    console.error("Failed to claim ticket", error);
    return Response.json(buildEphemeralMessage("Failed to claim this ticket."));
  }
}

async function refreshTicketClaimOpeningMessage(
  interaction: DiscordInteraction,
  ticket: TicketInstance,
  stores: RuntimeStores,
  discordBotToken: string,
): Promise<void> {
  let message =
    interaction.message?.id &&
    (!ticket.openingMessageId || ticket.openingMessageId === interaction.message.id)
      ? interaction.message
      : ticket.openingMessageId
        ? await fetchChannelMessage(ticket.channelId, ticket.openingMessageId, discordBotToken)
        : null;
  if (!message && !ticket.openingMessageId) {
    // Older tickets predate the stored opening message ID and may have only close controls.
    const { botUserId } = await stores.blocklist.readConfig();
    const messages = await listChannelMessages(ticket.channelId, discordBotToken, {
      after: ticket.channelId,
      limit: 100,
    });
    message =
      messages.find(
        (candidate) =>
          candidate.author.id === botUserId &&
          candidate.components?.some(
            (row) =>
              isRecord(row) &&
              Array.isArray(row.components) &&
              row.components.some(
                (component) =>
                  isRecord(component) &&
                  (isTicketClaimButton(component) ||
                    (typeof component.custom_id === "string" &&
                      component.label === "Close Ticket")),
              ),
          ),
      ) ?? null;
  }
  // A deleted or undiscoverable opening has nothing left to refresh. Let claim delivery
  // announce the current owner and write the audit event; API failures still propagate.
  if (!message) return;
  if (!message.id) throw new Error("The ticket opening message could not be found.");
  if (!ticket.openingMessageId) {
    await stores.tickets.updateTicketOpeningMessageId({
      guildId: ticket.guildId,
      channelId: ticket.channelId,
      openingMessageId: message.id,
    });
  }
  const components = message.components?.map((row) => {
    if (!isRecord(row) || !Array.isArray(row.components)) return row;
    return {
      ...row,
      components: row.components.map((component) =>
        isRecord(component) && isTicketClaimButton(component)
          ? { ...component, label: ticket.claimedByUserId ? "Transfer Claim" : "Claim Ticket" }
          : component,
      ),
    };
  });
  const embeds = message.embeds?.map((embed, index) =>
    index === 0
      ? {
          ...embed,
          fields: [
            ...(embed.fields ?? []).filter((field) => field.name !== "Claimed by"),
            ...(ticket.claimedByUserId
              ? [{ name: "Claimed by", value: formatUserMention(ticket.claimedByUserId) }]
              : []),
          ],
        }
      : embed,
  );
  await editChannelMessage(
    ticket.channelId,
    message.id,
    { components, embeds, allowed_mentions: suppressMentions() },
    discordBotToken,
  );
}

function isTicketClaimButton(component: Record<string, unknown>): boolean {
  return (
    typeof component.custom_id === "string" &&
    (component.label === "Claim Ticket" ||
      component.label === "Transfer Claim" ||
      (typeof component.label === "string" && component.label.startsWith("Claimed by @")))
  );
}

export async function handleTicketModalSubmitInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  discordBotToken: string,
  waitUntil?: (promise: Promise<unknown>) => void,
  ticketLifecycle?: TicketLifecycle,
  componentIdSigner?: ComponentIdSigner,
): Promise<Response> {
  if (typeof interaction.guild_id !== "string" || interaction.guild_id.length === 0) {
    return Response.json(
      buildEphemeralMessage("This interaction can only be used inside a server."),
    );
  }
  const guildId = interaction.guild_id;

  const openerUserId = getInteractionUserId(interaction);
  if (!openerUserId) {
    return Response.json(
      buildEphemeralMessage("Could not determine which user opened this ticket."),
    );
  }

  const parsedCustomId = parseTicketCustomId(getInteractionCustomId(interaction) ?? "");
  if (!parsedCustomId || parsedCustomId.action !== "open") {
    return Response.json(buildEphemeralMessage("That ticket option is no longer available."));
  }

  const savedPanel = await readInteractionTicketPanel(
    stores.tickets,
    guildId,
    parsedCustomId.panelId,
  );
  const savedTicketType = savedPanel?.ticketTypes.find(
    (entry) => entry.id === parsedCustomId.ticketTypeId,
  );
  if (!savedPanel || !savedTicketType) {
    return Response.json(buildEphemeralMessage("That ticket option is no longer available."));
  }

  const answers = extractTicketAnswersFromModal(
    interaction as Parameters<typeof extractTicketAnswersFromModal>[0],
    savedTicketType.questions,
  );
  const prepared = await getTicketLifecycle(stores, ticketLifecycle).prepareOpen({
    guildId,
    panelId: parsedCustomId.panelId ?? "main",
    ticketTypeId: parsedCustomId.ticketTypeId,
    memberRoleIds: getInteractionMemberRoles(interaction),
    answers,
  });
  if (!prepared.ok) return Response.json(buildEphemeralMessage(prepared.message));

  return deferTicketInteraction(interaction, waitUntil, () =>
    createTicketFromInteraction({
      guildId,
      openerUserId,
      openerRoleIds: getInteractionMemberRoles(interaction),
      panelId: prepared.panel.panelId ?? "main",
      ticketTypeId: prepared.ticketType.id,
      answers: prepared.answers,
      stores,
      discordBotToken,
      ticketLifecycle,
      componentIdSigner,
    }),
  );
}

async function readInteractionTicketPanel(
  store: RuntimeStores["tickets"],
  guildId: string,
  panelId: string | undefined,
): Promise<TicketPanelConfig | null> {
  if (panelId) {
    return store.readTicketPanelConfigById(guildId, panelId);
  }
  return store.readTicketPanelConfig(guildId);
}

function getTicketLifecycle(stores: RuntimeStores, injected?: TicketLifecycle) {
  return (
    injected ??
    createTicketLifecycle({
      tickets: stores.tickets,
      blocklist: stores.blocklist,
      entitlements: stores.guildEntitlements,
      messageTemplates: stores.messageTemplates,
    })
  );
}

async function authorizeTicketTemplateReply(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  lifecycle: TicketLifecycle,
  guildId: string,
  channelId: string,
) {
  const command = {
    guildId,
    channelId,
    actorRoleIds: getInteractionMemberRoles(interaction),
    isAdmin: false,
  };
  const roleAuthorization = await lifecycle.authorizeTemplateReply(command);
  if (roleAuthorization.ok || roleAuthorization.code !== "permission") return roleAuthorization;
  return lifecycle.authorizeTemplateReply({
    ...command,
    isAdmin: await hasInteractionAdminAccess(interaction, stores),
  });
}

function deferTicketInteraction(
  interaction: DiscordInteraction,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  task: () => Promise<Response>,
  failureMessage = "Failed to create your ticket.",
): Promise<Response> {
  if (!waitUntil) {
    return task();
  }

  waitUntil(
    task()
      .then((response) => updateDeferredInteractionResponse(interaction, response))
      .catch(async (error) => {
        console.error("Deferred ticket action failed", error);
        await updateDeferredInteractionResponse(
          interaction,
          Response.json(
            buildEphemeralMessage(
              isDiscordRateLimitError(error)
                ? "Discord is temporarily rate limiting this action. Try again shortly."
                : failureMessage,
            ),
          ),
        );
      }),
  );
  return Promise.resolve(
    Response.json({
      type: DISCORD_DEFERRED_CHANNEL_MESSAGE_RESPONSE,
      data: { flags: DISCORD_EPHEMERAL_FLAG },
    }),
  );
}

async function updateDeferredInteractionResponse(
  interaction: DiscordInteraction,
  response: Response,
): Promise<void> {
  if (!interaction.application_id || !interaction.token) {
    await response.arrayBuffer();
    return;
  }

  const body = (await response.json()) as { data?: unknown };
  if (isRecord(body.data)) {
    try {
      await editOriginalInteractionResponse(
        interaction.application_id,
        interaction.token,
        body.data,
      );
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) {
        let details: unknown;
        try {
          details = JSON.parse(error.details);
        } catch {
          // Unrecognized Discord failures must retain the existing error path.
        }
        if (isRecord(details) && details.code === 10008) {
          console.warn("Deferred ticket response is no longer available", {
            reasonCode: "unknown_message",
          });
          return;
        }
      }
      throw error;
    }
  }
}

async function createTicketFromInteraction({
  guildId,
  openerUserId,
  openerRoleIds,
  panelId,
  ticketTypeId,
  answers,
  stores,
  discordBotToken,
  ticketLifecycle,
  componentIdSigner,
}: {
  guildId: string;
  openerUserId: string;
  openerRoleIds: string[];
  panelId: string;
  ticketTypeId: string;
  answers: TicketInstance["answers"];
  stores: RuntimeStores;
  discordBotToken: string;
  ticketLifecycle?: TicketLifecycle;
  componentIdSigner?: ComponentIdSigner;
}): Promise<Response> {
  try {
    const result = await getTicketLifecycle(stores, ticketLifecycle).open(
      ({ panel, ticketType }) => ({
        createChannel: async (config) => {
          const channel = await createTicketChannel(config, discordBotToken);
          return { id: channel.id };
        },
        deleteChannel: (channelId: string) => deleteTicketResource(channelId, discordBotToken),
        createStaffThread: async (channelId: string, name: string) => {
          const thread = await createPrivateThread(channelId, name, discordBotToken);
          return { id: thread.id };
        },
        deleteStaffThread: (threadId: string) => deleteTicketResource(threadId, discordBotToken),
        createOpeningMessage: async (channelId: string, ticketNumber: number) => {
          const inst: TicketInstance = {
            guildId,
            channelId,
            ticketTypeId: ticketType.id,
            ticketTypeLabel: ticketType.label,
            openerUserId,
            supportRoleId: ticketType.supportRoleId,
            status: "open",
            answers,
            openedAtMs: Date.now(),
            closedAtMs: null,
            closedByUserId: null,
            transcriptMessageId: null,
            staffThreadId: null,
            claimedByUserId: null,
            claimedAtMs: null,
          };
          return await createChannelMessage(
            channelId,
            await signSensitiveMessageComponentIds(
              buildTicketOpeningMessage(inst, ticketNumber, {
                enableTicketClaiming: panel.enableTicketClaiming,
                mentionSupportRole: ticketType.mentionSupportRole === true,
              }),
              componentIdSigner,
              { guildId },
            ),
            discordBotToken,
          );
        },
        createAutoReplyMessage: async (channelId: string, body) => {
          await createChannelMessage(
            channelId,
            typeof body === "string" ? { content: body, allowed_mentions: { parse: [] } } : body,
            discordBotToken,
          );
        },
        createAnonymousSupportHelper: async (staffThreadId: string) => {
          await createChannelMessage(
            staffThreadId,
            buildAnonymousSupportHelperMessage(),
            discordBotToken,
          );
        },
        recordLinkReminder: async ({ channelId, ticketType, rule, platform }) => {
          await postTicketAuditEvent(stores, discordBotToken, "ticket.link-reminder", {
            guildId,
            channelId,
            actorUserId: openerUserId,
            ticketTypeLabel: ticketType.label,
            platform,
            ruleId: rule.id,
          });
        },
        createTicketHistoryPrompt: async (staffThreadId, count, ticketChannelId) => {
          await createChannelMessage(
            staffThreadId,
            {
              content: `${count} other Ticket${count === 1 ? "" : "s"} found for this member.`,
              allowed_mentions: { parse: [] },
              components: [
                {
                  type: DISCORD_MESSAGE_COMPONENT_ROW,
                  components: [
                    {
                      type: DISCORD_BUTTON_COMPONENT,
                      custom_id: buildTicketHistoryPromptCustomId(openerUserId, ticketChannelId),
                      label: "View Ticket History",
                      style: 2,
                    },
                  ],
                },
              ],
            },
            discordBotToken,
          );
        },
      }),
      {
        guildId,
        panelId,
        ticketTypeId,
        openerUserId,
        openerRoleIds,
        answers,
        platformLinkConfigs: await readTicketLinkPlatformConfigs(stores, guildId),
      },
    );
    if (!result.ok) {
      if (result.code === "partial-success" && result.recovery) {
        const recoveryResult = await getTicketLifecycle(stores, ticketLifecycle).resumeOpenCleanup(
          {
            deleteChannel: (channelId) => deleteTicketResource(channelId, discordBotToken),
            deleteStaffThread: (threadId) => deleteTicketResource(threadId, discordBotToken),
          },
          result.recovery,
        );
        if (recoveryResult.ok) {
          return Response.json(
            buildEphemeralMessage(
              "Ticket creation failed, but all created resources were cleaned up.",
            ),
          );
        }
        await deferTicketRecovery(getTicketLifecycle(stores, ticketLifecycle), {
          kind: "open-cleanup",
          recovery: recoveryResult.recovery,
        });
      }
      return Response.json(buildEphemeralMessage(result.message));
    }
    const { ticket: instance, ticketType } = result;
    await postTicketAuditEvent(stores, discordBotToken, "ticket.creation", {
      guildId,
      channelId: instance.channelId,
      actorUserId: openerUserId,
      ticketTypeLabel: ticketType.label,
    });
    return Response.json(buildEphemeralMessage(`Created your ticket: <#${instance.channelId}>`));
  } catch (error) {
    rethrowDiscordRateLimit(error);
    console.error("Failed to create ticket", error);
    return Response.json(buildEphemeralMessage("Failed to create your ticket."));
  }
}

async function handleTicketCloseInteraction(
  interaction: DiscordInteraction,
  guildId: string,
  requestedChannelId: string,
  stores: RuntimeStores,
  discordBotToken: string,
  requestOrigin: string,
  ticketTranscriptBlobs?: TicketTranscriptBlobStore,
  waitUntil?: (promise: Promise<unknown>) => void,
  aiTranscriptSummarizerEnv?: AiTranscriptSummarizerEnv,
  ticketLifecycle?: TicketLifecycle,
  ticketTranscriptCapabilities?: TicketTranscriptCapabilityAccess,
): Promise<Response> {
  const userId = getInteractionUserId(interaction);
  if (!userId) {
    return Response.json(buildEphemeralMessage("Could not determine who is closing this ticket."));
  }

  const channelId = resolveTicketChannelId(interaction, requestedChannelId);
  if (!channelId) {
    return Response.json(buildEphemeralMessage("That ticket close button is no longer valid."));
  }

  const authorization = await getTicketLifecycle(stores, ticketLifecycle).authorize({
    guildId,
    channelId,
    actorUserId: userId,
    actorRoleIds: getInteractionMemberRoles(interaction),
    action: "close",
  });
  if (!authorization.ok) return Response.json(buildEphemeralMessage(authorization.message));

  return closeTicketInteraction({
    interaction,
    ticket: authorization.ticket,
    closedByUserId: userId,
    closerDisplayName: getInteractionUserDisplayName(interaction),
    stores,
    discordBotToken,
    requestOrigin,
    ticketTranscriptBlobs,
    waitUntil,
    aiTranscriptSummarizerEnv,
    ticketLifecycle,
    ticketTranscriptCapabilities,
  });
}

async function handleTicketCloseRequestInteraction(
  interaction: DiscordInteraction,
  guildId: string,
  requestedChannelId: string,
  stores: RuntimeStores,
  discordBotToken: string,
  ticketLifecycle?: TicketLifecycle,
  componentIdSigner?: ComponentIdSigner,
): Promise<Response> {
  const userId = getInteractionUserId(interaction);
  if (!userId) {
    return Response.json(
      buildEphemeralMessage("Could not determine who is requesting a ticket close."),
    );
  }

  const channelId = resolveTicketChannelId(interaction, requestedChannelId);
  if (!channelId) {
    return Response.json(
      buildEphemeralMessage("That ticket close request button is no longer valid."),
    );
  }

  const authorization = await getTicketLifecycle(stores, ticketLifecycle).authorize({
    guildId,
    channelId,
    actorUserId: userId,
    actorRoleIds: getInteractionMemberRoles(interaction),
    action: "request-close",
  });
  if (!authorization.ok) return Response.json(buildEphemeralMessage(authorization.message));

  try {
    await getTicketLifecycle(stores, ticketLifecycle).requestClose(
      {
        createChannelMessage: async (channelId, body) => {
          await createChannelMessage(
            channelId,
            await signSensitiveMessageComponentIds(body, componentIdSigner, {
              guildId,
              actorUserId: authorization.ticket.openerUserId,
              expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
            }),
            discordBotToken,
          );
        },
      },
      {
        ticket: authorization.ticket,
        requesterUserId: userId,
      },
    );
  } catch (error) {
    rethrowDiscordRateLimit(error);
    console.error("Failed to post ticket close request", error);
    return Response.json(
      buildEphemeralMessage("Failed to request confirmation from the ticket opener."),
    );
  }

  return Response.json(buildEphemeralMessage("Requested confirmation from the ticket opener."));
}

async function handleTicketCloseConfirmationInteraction(
  interaction: DiscordInteraction,
  guildId: string,
  requestedChannelId: string,
  stores: RuntimeStores,
  discordBotToken: string,
  requestOrigin: string,
  ticketTranscriptBlobs?: TicketTranscriptBlobStore,
  waitUntil?: (promise: Promise<unknown>) => void,
  aiTranscriptSummarizerEnv?: AiTranscriptSummarizerEnv,
  ticketLifecycle?: TicketLifecycle,
  ticketTranscriptCapabilities?: TicketTranscriptCapabilityAccess,
): Promise<Response> {
  const userId = getInteractionUserId(interaction);
  if (!userId) {
    return Response.json(
      buildEphemeralMessage("Could not determine who is responding to this ticket close request."),
    );
  }

  const channelId = resolveTicketChannelId(interaction, requestedChannelId);
  if (!channelId) {
    return Response.json(buildEphemeralMessage("That ticket close request is no longer valid."));
  }

  const authorization = await getTicketLifecycle(stores, ticketLifecycle).authorize({
    guildId,
    channelId,
    actorUserId: userId,
    actorRoleIds: getInteractionMemberRoles(interaction),
    action: "confirm-close",
  });
  if (!authorization.ok) return Response.json(buildEphemeralMessage(authorization.message));

  return closeTicketInteraction({
    interaction,
    ticket: authorization.ticket,
    closedByUserId: userId,
    closerDisplayName: getInteractionUserDisplayName(interaction),
    stores,
    discordBotToken,
    requestOrigin,
    ticketTranscriptBlobs,
    waitUntil,
    aiTranscriptSummarizerEnv,
    ticketLifecycle,
    ticketTranscriptCapabilities,
  });
}

function closeTicketInteraction(options: {
  interaction: DiscordInteraction;
  ticket: TicketInstance;
  closedByUserId: string;
  closerDisplayName: string | null;
  stores: RuntimeStores;
  discordBotToken: string;
  requestOrigin: string;
  ticketTranscriptBlobs?: TicketTranscriptBlobStore;
  waitUntil?: (promise: Promise<unknown>) => void;
  aiTranscriptSummarizerEnv?: AiTranscriptSummarizerEnv;
  ticketLifecycle?: TicketLifecycle;
  ticketTranscriptCapabilities?: TicketTranscriptCapabilityAccess;
}): Promise<Response> {
  if (!options.waitUntil) {
    return closeTicket(options);
  }

  options.waitUntil(
    closeTicket(options).then(async (response) => {
      await updateDeferredInteractionResponse(options.interaction, response);
    }),
  );
  return Promise.resolve(
    Response.json({
      type: DISCORD_DEFERRED_CHANNEL_MESSAGE_RESPONSE,
      data: { flags: DISCORD_EPHEMERAL_FLAG },
    }),
  );
}

async function handleTicketCloseDeclineInteraction(
  interaction: DiscordInteraction,
  guildId: string,
  requestedChannelId: string,
  stores: RuntimeStores,
  ticketLifecycle?: TicketLifecycle,
): Promise<Response> {
  const userId = getInteractionUserId(interaction);
  if (!userId) {
    return Response.json(
      buildEphemeralMessage("Could not determine who is responding to this ticket close request."),
    );
  }

  const channelId = resolveTicketChannelId(interaction, requestedChannelId);
  if (!channelId) {
    return Response.json(buildEphemeralMessage("That ticket close request is no longer valid."));
  }

  const authorization = await getTicketLifecycle(stores, ticketLifecycle).authorize({
    guildId,
    channelId,
    actorUserId: userId,
    actorRoleIds: getInteractionMemberRoles(interaction),
    action: "decline-close",
  });
  if (!authorization.ok) return Response.json(buildEphemeralMessage(authorization.message));

  return Response.json({
    type: DISCORD_UPDATE_MESSAGE_RESPONSE,
    data: {
      content: "The ticket opener chose to keep this ticket open.",
      allowed_mentions: { parse: [] },
      components: [],
    },
  });
}

async function closeTicket({
  ticket,
  closedByUserId,
  closerDisplayName,
  stores,
  discordBotToken,
  requestOrigin,
  ticketTranscriptBlobs,
  ticketTranscriptCapabilities,
  aiTranscriptSummarizerEnv,
  ticketLifecycle,
}: {
  ticket: TicketInstance;
  closedByUserId: string;
  closerDisplayName: string | null;
  stores: RuntimeStores;
  discordBotToken: string;
  requestOrigin: string;
  ticketTranscriptBlobs?: TicketTranscriptBlobStore;
  ticketTranscriptCapabilities?: TicketTranscriptCapabilityAccess;
  aiTranscriptSummarizerEnv?: AiTranscriptSummarizerEnv;
  ticketLifecycle?: TicketLifecycle;
}): Promise<Response> {
  try {
    const lifecycle = getTicketLifecycle(stores, ticketLifecycle);
    const cleanupAdapters = {
      deleteChannel: (channelId: string) => deleteTicketResource(channelId, discordBotToken),
      deleteStaffThread: (threadId: string) => deleteTicketResource(threadId, discordBotToken),
    };
    let result = await lifecycle.close(
      {
        ...cleanupAdapters,
        uploadTranscript: async (transcriptChannelId, filename, transcript, options) => {
          return await uploadTranscriptToChannel(
            transcriptChannelId,
            filename,
            transcript,
            discordBotToken,
            options,
          );
        },
        buildTranscriptArtifacts: async (options) => {
          return await buildTicketTranscriptArtifacts({
            ...options,
            discordBotToken,
            requestOrigin,
            ticketTranscriptCapabilities,
            staffMessageResolver: {
              readStaffMessageMapping: (body) => stores.tickets.readStaffMessageMapping(body),
            },
            participantEventResolver: {
              listTicketParticipantEvents: (guildId, channelId) =>
                stores.tickets.listTicketParticipantEvents(guildId, channelId),
            },
          });
        },
        createChannelMessage: async (channelId, body) => {
          await createChannelMessage(channelId, body, discordBotToken);
        },
        summarizeTranscript: aiTranscriptSummarizerEnv
          ? async (options): Promise<AiTranscriptSummary | null> => {
              const ticketType = options.panel.ticketTypes.find(
                (type) => type.id === options.ticket.ticketTypeId,
              );
              return summarizeTicket(
                {
                  ticketTypeLabel: ticketType?.label ?? options.ticket.ticketTypeLabel,
                  ticketTypeId: options.ticket.ticketTypeId,
                  answers: options.ticket.answers,
                  messages: options.messages,
                  closerDisplayName: options.presentation.closerDisplayName ?? null,
                },
                aiTranscriptSummarizerEnv,
              );
            }
          : undefined,
      },
      {
        ticket,
        closedByUserId,
        closerDisplayName,
        ticketTranscriptBlobs,
      },
    );
    if (!result.ok && result.code === "partial-success" && result.recovery) {
      result = await lifecycle.resumeCloseCleanup(cleanupAdapters, result.recovery);
      if (!result.ok && result.code === "partial-success" && result.recovery) {
        await deferTicketRecovery(lifecycle, { kind: "close-cleanup", recovery: result.recovery });
      }
    }
    if (!result.ok) {
      if (result.code === "partial-success") console.error("Ticket close needs recovery", result);
      return Response.json(buildEphemeralMessage(result.message));
    }
    await postTicketAuditEvent(stores, discordBotToken, "ticket.close", {
      guildId: ticket.guildId,
      channelId: ticket.channelId,
      actorUserId: closedByUserId,
      ticketTypeLabel: ticket.ticketTypeLabel,
    });
    return Response.json(buildEphemeralMessage("Closed ticket and uploaded the transcript."));
  } catch (error) {
    rethrowDiscordRateLimit(error);
    console.error("Failed to close ticket", error);
    return Response.json(buildEphemeralMessage("Failed to close the ticket."));
  }
}

async function postTicketAuditEvent(
  stores: RuntimeStores,
  discordBotToken: string,
  eventId:
    | "ticket.creation"
    | "ticket.claim"
    | "ticket.close"
    | "ticket.panel-config-change"
    | "ticket.link-reminder",
  input: {
    guildId: string;
    channelId?: string;
    actorUserId?: string;
    ticketTypeLabel?: string;
    platform?: TicketLinkPlatform;
    ruleId?: string;
    nonce?: string;
  },
): Promise<void> {
  const auditChannelId = await resolveAuditChannelId(
    input.guildId,
    null,
    stores.guildAuditLog,
    eventId,
  );
  if (!auditChannelId) return;

  const fields = [
    ...(input.actorUserId ? [{ name: "Actor", value: formatUserMention(input.actorUserId) }] : []),
    ...(input.channelId ? [{ name: "Ticket Channel", value: `<#${input.channelId}>` }] : []),
    ...(input.ticketTypeLabel ? [{ name: "Ticket Type", value: input.ticketTypeLabel }] : []),
    ...(input.platform ? [{ name: "Platform", value: input.platform }] : []),
    ...(input.ruleId ? [{ name: "Rule", value: input.ruleId }] : []),
  ];

  try {
    await createChannelMessage(
      auditChannelId,
      {
        embeds: [
          buildAuditEmbed({
            title:
              eventId === "ticket.creation"
                ? "Ticket Creation"
                : eventId === "ticket.claim"
                  ? "Ticket Claim"
                  : eventId === "ticket.close"
                    ? "Ticket Close"
                    : eventId === "ticket.link-reminder"
                      ? "Ticket Link Reminder"
                      : "Ticket Panel Config Change",
            color: eventId === "ticket.close" ? 0xed4245 : 0x5865f2,
            fields,
          }),
        ],
        allowed_mentions: suppressMentions(),
        ...(input.nonce ? { nonce: input.nonce, enforce_nonce: true } : {}),
      },
      discordBotToken,
    );
  } catch (error) {
    if (input.nonce) throw error;
    console.error("Failed to post ticket audit event", error);
  }
}

function getInteractionMemberRoles(interaction: DiscordInteraction): string[] {
  if (!Array.isArray(interaction.member?.roles)) {
    return [];
  }

  return interaction.member.roles.filter((roleId): roleId is string => typeof roleId === "string");
}

async function deleteTicketResource(channelId: string, discordBotToken: string): Promise<void> {
  try {
    await deleteChannel(channelId, discordBotToken);
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) return;
    throw error;
  }
}

async function deferTicketRecovery(
  lifecycle: TicketLifecycle,
  recovery: Parameters<TicketLifecycle["deferRecovery"]>[0],
): Promise<void> {
  try {
    if (!(await lifecycle.deferRecovery(recovery))) {
      console.error("Ticket recovery queue is not configured", recovery.kind);
    }
  } catch (error) {
    console.error("Failed to enqueue ticket recovery", recovery.kind, error);
  }
}

async function readTicketLinkPlatformConfigs(stores: RuntimeStores, guildId: string) {
  const [steam, xbox, playstation] = await Promise.all([
    stores.platformLink.readPlatformLinkConfig(guildId, "steam"),
    stores.platformLink.readPlatformLinkConfig(guildId, "xbox"),
    stores.platformLink.readPlatformLinkConfig(guildId, "playstation"),
  ]);

  return {
    steam: steam
      ? {
          linkedRoleId: steam.linkedRoleId,
          panelButtonLabel: steam.panelButtonLabel,
          panelButtonStyle: steam.panelButtonStyle,
        }
      : null,
    xbox: xbox
      ? {
          linkedRoleId: xbox.linkedRoleId,
          panelButtonLabel: xbox.panelButtonLabel,
          panelButtonStyle: xbox.panelButtonStyle,
        }
      : null,
    playstation: playstation
      ? {
          linkedRoleId: playstation.linkedRoleId,
          panelButtonLabel: playstation.panelButtonLabel,
          panelButtonStyle: playstation.panelButtonStyle,
        }
      : null,
  };
}

function resolveTicketChannelId(
  interaction: DiscordInteraction,
  requestedChannelId: string,
): string | null {
  const channelId =
    typeof interaction.channel_id === "string" && interaction.channel_id.length > 0
      ? interaction.channel_id
      : requestedChannelId;

  return channelId === requestedChannelId ? channelId : null;
}

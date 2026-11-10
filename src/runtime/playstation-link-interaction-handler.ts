import { rethrowDiscordRateLimit } from "./interaction-rate-limit";
import { createChannelMessage } from "../discord";
import { buildEphemeralMessage } from "../discord-interactions";
import type { DiscordInteraction } from "../runtime/app-types";
import type { PlatformLink, PlatformLinkConfig } from "../runtime/contracts/platform-link-store";
import {
  PlatformLinkFinalizationError,
  type PlatformLinkService,
} from "../services/platform-link-service";
import { getInteractionUserId } from "./discord-interaction-parsers";
import { isRecord } from "../unknown-parse";
import { QuantityLimitError } from "./entitlement-checks";
import {
  DISCORD_MESSAGE_COMPONENT_ROW,
  DISCORD_MODAL_RESPONSE,
  DISCORD_TEXT_INPUT_COMPONENT,
} from "../discord/constants";
import { buildPlatformLinkMessage } from "./platform-link-buttons";

const PLATFORM = "playstation";
const PLAYSTATION_BUTTON_CUSTOM_ID = "playstation_link_button";
const PLAYSTATION_MODAL_CUSTOM_ID = "playstation_link_modal";
const PSN_ONLINE_ID_FIELD_CUSTOM_ID = "psn_online_id";
const PSN_ONLINE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,15}$/;

export function isPlayStationLinkButtonInteraction(interaction: DiscordInteraction): boolean {
  return getCustomId(interaction) === PLAYSTATION_BUTTON_CUSTOM_ID;
}

export function isPlayStationLinkModalSubmit(interaction: DiscordInteraction): boolean {
  return getCustomId(interaction) === PLAYSTATION_MODAL_CUSTOM_ID;
}

export async function handlePlayStationLinkButton(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (typeof interaction.guild_id !== "string" || interaction.guild_id.length === 0) {
    return Response.json(
      buildEphemeralMessage("This button must be used inside a Discord server."),
    );
  }

  const userId = getInteractionUserId(interaction);
  if (!userId) {
    return Response.json(buildEphemeralMessage("Could not determine your user ID."));
  }

  const config = await platformLinkService.readConfig(interaction.guild_id, PLATFORM);
  if (config?.enabled === false) {
    return Response.json(buildEphemeralMessage("Account linking is disabled in this server."));
  }
  if (!config) {
    return Response.json(
      buildEphemeralMessage(
        "This server has not been set up for PlayStation linking. A server admin needs to run `/playstationlink setup` first.",
      ),
    );
  }

  const userLinks = await platformLinkService.getLinksByUser(interaction.guild_id, userId);
  const userPlatformLinks = userLinks.filter((link) => link.platform === PLATFORM && link.active);
  if (!config.allowMultipleLinks && userPlatformLinks.length > 0 && !config.allowRelink) {
    return Response.json(
      buildEphemeralMessage(
        `You are already linked to PSN Online ID: ${userPlatformLinks[0]?.platformId}`,
      ),
    );
  }

  return Response.json({
    type: DISCORD_MODAL_RESPONSE,
    data: {
      custom_id: PLAYSTATION_MODAL_CUSTOM_ID,
      title: config.panelTitle || "Link your PlayStation account",
      components: [
        {
          type: DISCORD_MESSAGE_COMPONENT_ROW,
          components: [
            {
              type: DISCORD_TEXT_INPUT_COMPONENT,
              custom_id: PSN_ONLINE_ID_FIELD_CUSTOM_ID,
              label: "PSN Online ID",
              style: 1,
              min_length: 3,
              max_length: 16,
              required: true,
              placeholder: "Your PlayStation Online ID",
            },
          ],
        },
      ],
    },
  });
}

export async function handlePlayStationLinkModalSubmit(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (typeof interaction.guild_id !== "string" || interaction.guild_id.length === 0) {
    return Response.json(
      buildEphemeralMessage("This interaction can only be used inside a server."),
    );
  }

  const userId = getInteractionUserId(interaction);
  if (!userId) {
    return Response.json(buildEphemeralMessage("Could not determine your user ID."));
  }

  const psnId = getModalTextValue(interaction, PSN_ONLINE_ID_FIELD_CUSTOM_ID).trim();
  if (!PSN_ONLINE_ID_PATTERN.test(psnId)) {
    return Response.json(
      buildEphemeralMessage(
        "Invalid PSN Online ID. Use 3-16 characters, start with a letter, and only use letters, numbers, hyphens, or underscores.",
      ),
    );
  }

  const config = await platformLinkService.readConfig(interaction.guild_id, PLATFORM);
  if (config?.enabled === false) {
    return Response.json(buildEphemeralMessage("Account linking is disabled in this server."));
  }
  if (!config) {
    return Response.json(
      buildEphemeralMessage(
        "This server has not been set up for PlayStation linking. A server admin needs to run `/playstationlink setup` first.",
      ),
    );
  }

  const duplicate = await platformLinkService.getLinkByPlatformId(
    interaction.guild_id,
    PLATFORM,
    psnId,
  );
  if (duplicate && duplicate.userId !== userId) {
    return Response.json(
      buildEphemeralMessage(
        `That PSN Online ID is already linked to <@${duplicate.userId}> in this server.`,
      ),
    );
  }

  const existingLinks = await platformLinkService.getLinksByUser(interaction.guild_id, userId);
  const existingPlatformLinks = existingLinks.filter((link) => link.platform === PLATFORM);
  const existingMatch = existingPlatformLinks.find((link) => link.platformId === psnId);
  if (existingMatch?.active) {
    return Response.json(buildEphemeralMessage(`That PSN Online ID is already linked to you.`));
  }
  if (
    !existingMatch &&
    !config.allowMultipleLinks &&
    existingPlatformLinks.length > 0 &&
    !config.allowRelink
  ) {
    return Response.json(
      buildEphemeralMessage(
        `You are already linked to PSN Online ID: ${existingPlatformLinks[0]?.platformId}`,
      ),
    );
  }

  let needsFollowUp = false;
  try {
    await platformLinkService.saveLink(
      {
        guildId: interaction.guild_id,
        userId,
        platform: PLATFORM,
        platformId: psnId,
        linkedAtMs: Date.now(),
        manual: true,
        actionedByUserId: null,
        metadataJson: null,
        active: true,
      },
      !existingMatch && !config.allowMultipleLinks && existingPlatformLinks.length > 0,
    );
  } catch (error) {
    if (error instanceof PlatformLinkFinalizationError) {
      needsFollowUp = true;
    } else {
      rethrowDiscordRateLimit(error);
      if (error instanceof QuantityLimitError) {
        return Response.json(buildEphemeralMessage(error.message));
      }
      throw error;
    }
  }

  try {
    await platformLinkService.assignLinkedRole(interaction.guild_id, userId, PLATFORM);
  } catch {
    needsFollowUp = true;
  }
  try {
    await platformLinkService.sendLogEmbed(interaction.guild_id, "manual", {
      discordId: userId,
      platform: PLATFORM,
      platformId: psnId,
    });
  } catch {
    needsFollowUp = true;
  }

  return Response.json(
    buildEphemeralMessage(
      `Linked your PlayStation account: ${psnId}${needsFollowUp ? "\nThe link was saved, but follow-up processing is incomplete. Ask a server admin to check the linked role and audit log." : ""}`,
    ),
  );
}

export async function handlePlayStationLinkSetupCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
  resolveBotDisplayName: (guildId: string) => Promise<string> = async () => "HAF Bot",
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const options = getSubcommandOptions(interaction);
  const existingConfig = await platformLinkService.readConfig(interaction.guild_id, PLATFORM);
  const linkedRole = options.find((o) => o.name === "psn_linked_role")?.value as string | undefined;
  const logChannel = options.find((o) => o.name === "log_channel")?.value as string | undefined;
  const panelTitle = options.find((o) => o.name === "panel_title")?.value as string | undefined;
  const panelDescription = options.find((o) => o.name === "panel_description")?.value as
    | string
    | undefined;
  const panelButtonLabel = options.find((o) => o.name === "panel_button_label")?.value as
    | string
    | undefined;
  const panelButtonStyle = options.find((o) => o.name === "panel_button_style")?.value as
    | string
    | undefined;
  const allowRelink = options.find((o) => o.name === "allow_relink")?.value as boolean | undefined;
  const allowMultipleLinks = options.find((o) => o.name === "allow_multiple_links")?.value as
    | boolean
    | undefined;

  const botDisplayName = await resolveBotDisplayName(interaction.guild_id);

  const config: PlatformLinkConfig = {
    guildId: interaction.guild_id,
    platform: PLATFORM,
    linkedRoleId: linkedRole ?? existingConfig?.linkedRoleId ?? null,
    logChannelId: logChannel ?? existingConfig?.logChannelId ?? null,
    gameAppIds: [],
    panelTitle: panelTitle ?? existingConfig?.panelTitle ?? "Link your PlayStation account",
    panelDescription:
      panelDescription ??
      existingConfig?.panelDescription ??
      `Click the button below to link your Discord account to your PlayStation account. ${botDisplayName} stores the PSN Online ID exactly as you type it and does not verify it with Sony.`,
    panelButtonLabel: panelButtonLabel ?? existingConfig?.panelButtonLabel ?? "Link PlayStation",
    panelButtonStyle: panelButtonStyle ?? existingConfig?.panelButtonStyle ?? "Primary",
    panelColor: existingConfig?.panelColor ?? 0x003791,
    allowRelink: allowRelink !== undefined ? allowRelink : (existingConfig?.allowRelink ?? true),
    allowMultipleLinks:
      allowMultipleLinks !== undefined
        ? allowMultipleLinks
        : (existingConfig?.allowMultipleLinks ?? false),
    requireRelinkOnRejoin: existingConfig?.requireRelinkOnRejoin ?? false,
    whoisFields: existingConfig?.whoisFields ?? [],
    customLinks: [],
    panelChannelId: existingConfig?.panelChannelId ?? null,
    panelMessageId: existingConfig?.panelMessageId ?? null,
    updatedAtMs: Date.now(),
  };

  await platformLinkService.saveConfig(config);
  return Response.json(
    buildEphemeralMessage(
      `Setup saved for this server.\nPlayStation linked role: ${config.linkedRoleId ? `<@&${config.linkedRoleId}>` : "Not set"}\nLog channel: ${config.logChannelId ? `<#${config.logChannelId}>` : "Not set"}`,
    ),
  );
}

export async function handlePlayStationPanelCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
  discordBotToken: string,
): Promise<Response> {
  if (!interaction.guild_id || !interaction.channel_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const config = await platformLinkService.readConfig(interaction.guild_id, PLATFORM);
  if (config?.enabled === false) {
    return Response.json(buildEphemeralMessage("Account linking is disabled in this server."));
  }
  if (!config) {
    return Response.json(
      buildEphemeralMessage(
        "This server has not been set up for PlayStation linking. Run `/playstationlink setup` first.",
      ),
    );
  }

  try {
    await createChannelMessage(
      interaction.channel_id,
      buildPlatformLinkMessage("playstation", config),
      discordBotToken,
    );
    return Response.json(buildEphemeralMessage("PlayStation link panel posted."));
  } catch {
    return Response.json(buildEphemeralMessage("Failed to post the panel."));
  }
}

export async function handlePlayStationRequestCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
  discordBotToken: string,
): Promise<Response> {
  if (!interaction.guild_id || !interaction.channel_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const config = await platformLinkService.readConfig(interaction.guild_id, PLATFORM);
  if (config?.enabled === false) {
    return Response.json(buildEphemeralMessage("Account linking is disabled in this server."));
  }
  if (!config) {
    return Response.json(
      buildEphemeralMessage(
        "This server has not been set up for PlayStation linking. Run `/playstationlink setup` first.",
      ),
    );
  }

  try {
    await createChannelMessage(
      interaction.channel_id,
      buildPlatformLinkMessage("playstation", config, { buttonOnly: true }),
      discordBotToken,
    );
    return Response.json(buildEphemeralMessage("PlayStation link request posted."));
  } catch {
    return Response.json(buildEphemeralMessage("Failed to post the link request."));
  }
}

export async function handlePlayStationWhoisCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const options = getSubcommandOptions(interaction);
  const userId = options.find((o) => o.name === "user")?.value as string | undefined;
  const psnId = options.find((o) => o.name === "psn_id")?.value as string | undefined;
  if (!userId && !psnId) {
    return Response.json(buildEphemeralMessage("Use either user or PSN Online ID."));
  }

  let links: PlatformLink[] = [];
  if (psnId) {
    const link = await platformLinkService.getLinkByPlatformId(
      interaction.guild_id,
      PLATFORM,
      psnId,
    );
    if (link) links = [link];
  } else if (userId) {
    links = (await platformLinkService.getLinksByUser(interaction.guild_id, userId)).filter(
      (link) => link.platform === PLATFORM,
    );
  }

  if (links.length === 0) {
    return Response.json(
      buildEphemeralMessage("No linked PlayStation account found in this server."),
    );
  }

  const lines = links.flatMap((link, index) => {
    const entryLines = [
      `**Discord User:** <@${link.userId}> (ID: ${link.userId})`,
      "**Platform:** PlayStation",
      `**PSN Online ID:** ${link.platformId}`,
      `**Status:** ${link.active ? "Active" : "Inactive - relink required"}`,
      `**PlayStation Profile:** https://psnprofiles.com/${link.platformId}`,
      `**Linked At:** <t:${Math.floor(link.linkedAtMs / 1000)}:F>`,
      "**Link Type:** Self-attested link",
    ];
    return index > 0 ? ["", ...entryLines] : entryLines;
  });

  return Response.json(buildEphemeralMessage(lines.join("\n")));
}

export async function handlePlayStationManualLinkCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const options = getSubcommandOptions(interaction);
  const targetUser = options.find((o) => o.name === "user")?.value as string | undefined;
  const psnId = options.find((o) => o.name === "psn_id")?.value as string | undefined;
  if (!targetUser || !psnId?.trim()) {
    return Response.json(buildEphemeralMessage("Missing user or PSN Online ID."));
  }

  const config = await platformLinkService.readConfig(interaction.guild_id, PLATFORM);
  if (config?.enabled === false) {
    return Response.json(buildEphemeralMessage("Account linking is disabled in this server."));
  }
  if (!config) {
    return Response.json(
      buildEphemeralMessage(
        "This server has not been set up for PlayStation linking. A server admin needs to run `/playstationlink setup` first.",
      ),
    );
  }

  const duplicate = await platformLinkService.getLinkByPlatformId(
    interaction.guild_id,
    PLATFORM,
    psnId,
  );
  if (duplicate && duplicate.userId !== targetUser) {
    return Response.json(
      buildEphemeralMessage(
        `That PSN Online ID is already linked to <@${duplicate.userId}> in this server.`,
      ),
    );
  }

  const existingLinks = await platformLinkService.getLinksByUser(interaction.guild_id, targetUser);
  const existingPlatformLinks = existingLinks.filter((link) => link.platform === PLATFORM);
  if (existingPlatformLinks.some((link) => link.platformId === psnId && link.active)) {
    return Response.json(
      buildEphemeralMessage(
        `That PSN Online ID is already linked to <@${targetUser}> in this server.`,
      ),
    );
  }

  const actionedBy = getInteractionUserId(interaction);
  let needsFollowUp = false;
  try {
    await platformLinkService.saveLink(
      {
        guildId: interaction.guild_id,
        userId: targetUser,
        platform: PLATFORM,
        platformId: psnId,
        linkedAtMs: Date.now(),
        manual: true,
        actionedByUserId: actionedBy ?? null,
        metadataJson: null,
        active: true,
      },
      !config.allowMultipleLinks && existingPlatformLinks.length > 0,
    );
  } catch (error) {
    if (error instanceof PlatformLinkFinalizationError) {
      needsFollowUp = true;
    } else {
      rethrowDiscordRateLimit(error);
      if (error instanceof QuantityLimitError) {
        return Response.json(buildEphemeralMessage(error.message));
      }
      throw error;
    }
  }

  try {
    await platformLinkService.assignLinkedRole(interaction.guild_id, targetUser, PLATFORM);
  } catch {
    needsFollowUp = true;
  }
  try {
    await platformLinkService.sendLogEmbed(interaction.guild_id, "manual", {
      discordId: targetUser,
      platform: PLATFORM,
      platformId: psnId,
      actionedBy: actionedBy ?? undefined,
    });
  } catch {
    needsFollowUp = true;
  }

  return Response.json(
    buildEphemeralMessage(
      `Manually linked <@${targetUser}> to PSN Online ID: ${psnId}${needsFollowUp ? "\nThe link was saved, but follow-up processing is incomplete. Ask a server admin to check the linked role and audit log." : ""}`,
    ),
  );
}

export async function handlePlayStationUnlinkCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const options = getSubcommandOptions(interaction);
  const targetUser = options.find((o) => o.name === "user")?.value as string | undefined;
  const psnId = options.find((o) => o.name === "psn_id")?.value as string | undefined;
  const selfUnlink = !targetUser;
  const userId = selfUnlink ? getInteractionUserId(interaction) : targetUser;
  if (!userId) {
    return Response.json(buildEphemeralMessage("Could not determine user."));
  }

  let link: PlatformLink | null = null;
  if (psnId) {
    link = await platformLinkService.getLinkByPlatformId(interaction.guild_id, PLATFORM, psnId);
    if (link && link.userId !== userId) {
      return Response.json(
        buildEphemeralMessage(
          selfUnlink
            ? "That PSN Online ID is not linked to your Discord account in this server."
            : "That PSN Online ID is not linked to the selected user in this server.",
        ),
      );
    }
  } else {
    const platformLinks = (
      await platformLinkService.getLinksByUser(interaction.guild_id, userId)
    ).filter((entry) => entry.platform === PLATFORM);
    if (platformLinks.length === 1) link = platformLinks[0];
    if (platformLinks.length > 1) {
      return Response.json(
        buildEphemeralMessage(
          "Multiple PlayStation links found for that user. Provide a PSN Online ID to unlink a specific account.",
        ),
      );
    }
  }

  if (!link) {
    return Response.json(
      buildEphemeralMessage(
        selfUnlink
          ? "You do not have a linked PlayStation account in this server."
          : "That user is not linked in this server.",
      ),
    );
  }

  await deleteSinglePlayStationLink(
    interaction.guild_id,
    userId,
    link.platformId,
    platformLinkService,
  );
  const remainingPlatformLinks = (
    await platformLinkService.getLinksByUser(interaction.guild_id, userId)
  ).filter((entry) => entry.platform === PLATFORM && entry.active);
  if (remainingPlatformLinks.length === 0) {
    await platformLinkService.removeLinkedRole(interaction.guild_id, userId, PLATFORM);
  }
  const actionedBy = selfUnlink ? userId : getInteractionUserId(interaction);
  await platformLinkService.sendLogEmbed(interaction.guild_id, "unlinked", {
    discordId: userId,
    platform: PLATFORM,
    platformId: link.platformId,
    actionedBy: actionedBy ?? undefined,
  });

  return Response.json(
    buildEphemeralMessage(
      selfUnlink
        ? `Your PlayStation account has been unlinked.\nPSN Online ID: ${link.platformId}`
        : `Unlinked <@${userId}>.\nPSN Online ID: ${link.platformId}`,
    ),
  );
}

export async function handlePlayStationLinkedCountCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const links = (await platformLinkService.listLinks(interaction.guild_id, PLATFORM)).filter(
    (link) => link.active,
  );
  return Response.json(
    buildEphemeralMessage(`Total linked PlayStation users in this server: **${links.length}**`),
  );
}

export async function handlePlayStationSyncRolesCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const result = await platformLinkService.syncLinkedRoles(interaction.guild_id, PLATFORM);
  return Response.json(
    buildEphemeralMessage(
      `Role sync complete.\nLinked PlayStation users: **${result.total}**\nRoles fixed: **${result.fixed}**\nSkipped: **${result.skipped}**\nFailed: **${result.failed}**`,
    ),
  );
}

function getSubcommandOptions(interaction: DiscordInteraction): Array<Record<string, unknown>> {
  const data = interaction.data as Record<string, unknown> | undefined;
  const topLevelOptions = Array.isArray(data?.options)
    ? (data.options as Array<Record<string, unknown>>)
    : [];
  const subcommand = topLevelOptions.find((option) => option.type === 1);
  return Array.isArray(subcommand?.options)
    ? (subcommand.options as Array<Record<string, unknown>>)
    : [];
}

function getCustomId(interaction: DiscordInteraction): string | null {
  if (!isRecord(interaction.data)) {
    return null;
  }
  const customId = interaction.data.custom_id;
  return typeof customId === "string" ? customId : null;
}

function getModalTextValue(interaction: DiscordInteraction, customId: string): string {
  const data = interaction.data as { components?: unknown } | undefined;
  if (!Array.isArray(data?.components)) return "";
  for (const row of data.components) {
    const components = (row as { components?: unknown }).components;
    if (!Array.isArray(components)) continue;
    const input = components.find(
      (component) => (component as { custom_id?: unknown }).custom_id === customId,
    ) as { value?: unknown } | undefined;
    if (typeof input?.value === "string") return input.value;
  }
  return "";
}

async function deleteSinglePlayStationLink(
  guildId: string,
  userId: string,
  platformId: string,
  platformLinkService: PlatformLinkService,
): Promise<void> {
  await platformLinkService.deleteLink(guildId, userId, PLATFORM, platformId);
}

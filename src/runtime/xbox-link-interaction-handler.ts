import { rethrowDiscordRateLimit } from "./interaction-rate-limit";
import { createChannelMessage } from "../discord";
import { buildEphemeralMessage } from "../discord-interactions";
import type { DiscordInteraction } from "./app-types";
import type { PlatformLink } from "./contracts/platform-link-store";
import {
  PlatformLinkFinalizationError,
  type PlatformLinkService,
} from "../services/platform-link-service";
import { getInteractionUserId } from "./discord-interaction-parsers";
import { QuantityLimitError } from "./entitlement-checks";
import { DISCORD_CHANNEL_MESSAGE_RESPONSE, DISCORD_EPHEMERAL_FLAG } from "../discord/constants";
import { buildPlatformLinkMessage } from "./platform-link-buttons";

const PENDING_LINK_TTL_MS = 15 * 60 * 1000;

const PLATFORM = "xbox";

export async function handleXboxLinkButtonInteraction(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
  publicUrl: string,
): Promise<Response> {
  if (typeof interaction.guild_id !== "string" || interaction.guild_id.length === 0) {
    return Response.json(
      buildEphemeralMessage("This button must be used inside a Discord server."),
    );
  }

  const guildId = interaction.guild_id;
  const userId = getInteractionUserId(interaction);
  if (!userId) {
    return Response.json(buildEphemeralMessage("Could not determine your user ID."));
  }

  const config = await platformLinkService.readConfig(guildId, PLATFORM);
  if (config?.enabled === false) {
    return Response.json(buildEphemeralMessage("Account linking is disabled in this server."));
  }
  if (!config) {
    return Response.json(
      buildEphemeralMessage(
        "This server has not been set up for Xbox linking. A server admin needs to run `/xboxlink setup` first.",
      ),
    );
  }

  const userLinks = await platformLinkService.getLinksByUser(guildId, userId);
  const userPlatformLinks = userLinks.filter((l) => l.platform === PLATFORM && l.active);
  if (!config.allowMultipleLinks && userPlatformLinks.length > 0 && !config.allowRelink) {
    return Response.json(
      buildEphemeralMessage(
        `You are already linked to Xbox XUID: ${userPlatformLinks[0]?.platformId}`,
      ),
    );
  }

  const state = crypto.randomUUID().replace(/-/g, "");
  await platformLinkService.clearExpiredPendingLinks(Date.now() - PENDING_LINK_TTL_MS);
  await platformLinkService.createPendingLink(state, guildId, userId, PLATFORM);

  const authUrl = `${publicUrl}/auth/xbox/start?state=${encodeURIComponent(state)}`;

  return Response.json({
    type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
    data: {
      content: `Click here to sign in with Xbox and link your account:\n${authUrl}`,
      flags: DISCORD_EPHEMERAL_FLAG,
    },
  });
}

export async function handleXboxRequestCommand(
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
        "This server has not been set up for Xbox linking. Run `/xboxlink setup` first.",
      ),
    );
  }

  try {
    await createChannelMessage(
      interaction.channel_id,
      buildPlatformLinkMessage("xbox", config, { buttonOnly: true }),
      discordBotToken,
    );
    return Response.json(buildEphemeralMessage("Xbox link request posted."));
  } catch {
    return Response.json(buildEphemeralMessage("Failed to post the link request."));
  }
}

export async function handleXboxWhoisCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const options = getSubcommandOptions(interaction);

  const userOption = options.find((o) => o.name === "user");
  const xuidOption = options.find((o) => o.name === "xuid");

  const userId = userOption?.value as string | undefined;
  const xuid = xuidOption?.value as string | undefined;

  if (!userId && !xuid) {
    return Response.json(buildEphemeralMessage("Use either user or xuid."));
  }

  let links: PlatformLink[] = [];

  if (xuid) {
    const link = await platformLinkService.getLinkByPlatformId(
      interaction.guild_id,
      PLATFORM,
      xuid,
    );
    if (link) {
      links = [link];
    }
  } else if (userId) {
    links = await platformLinkService.getLinksByUser(interaction.guild_id, userId);
  }

  if (links.length === 0) {
    return Response.json(buildEphemeralMessage("No linked Platform Link found in this server."));
  }

  const config = await platformLinkService.readConfig(interaction.guild_id, PLATFORM);
  const wf = config?.whoisFields ?? [];

  const showProfile = wf.length === 0 || wf.includes("profile");

  const lines: string[] = links.flatMap((link, index) => {
    const metadata = getPlatformDisplay(link.platform);
    const entryLines: string[] = [
      `**Discord User:** <@${link.userId}> (ID: ${link.userId})`,
      `**Platform:** ${metadata.name}`,
      `**${metadata.idLabel}:** ${link.platformId}`,
      `**Status:** ${link.active ? "Active" : "Inactive - relink required"}`,
    ];

    if (showProfile) {
      entryLines.push(`**${metadata.name} Profile:** ${metadata.profileUrl(link.platformId)}`);
    }

    entryLines.push(
      `**Linked At:** <t:${Math.floor(link.linkedAtMs / 1000)}:F>`,
      `**Link Type:** ${link.manual ? "Manual admin link" : `${metadata.name} sign-in`}`,
    );

    if (index > 0) {
      return ["", ...entryLines];
    }
    return entryLines;
  });

  return Response.json(buildEphemeralMessage(lines.join("\n")));
}

export async function handleXboxManualLinkCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const options = getSubcommandOptions(interaction);

  const targetUser = options.find((o) => o.name === "user")?.value as string | undefined;
  const xuid = options.find((o) => o.name === "xuid")?.value as string | undefined;

  if (!targetUser || !xuid) {
    return Response.json(buildEphemeralMessage("Missing user or xuid."));
  }

  const duplicate = await platformLinkService.getLinkByPlatformId(
    interaction.guild_id,
    PLATFORM,
    xuid,
  );
  if (duplicate && duplicate.userId !== targetUser) {
    return Response.json(
      buildEphemeralMessage(
        `That Xbox XUID is already linked to <@${duplicate.userId}> in this server.`,
      ),
    );
  }

  const actionedBy = getInteractionUserId(interaction);
  const config = await platformLinkService.readConfig(interaction.guild_id, PLATFORM);
  if (config?.enabled === false) {
    return Response.json(buildEphemeralMessage("Account linking is disabled in this server."));
  }
  if (!config) {
    return Response.json(
      buildEphemeralMessage(
        "This server has not been set up for Xbox linking. A server admin needs to run `/xboxlink setup` first.",
      ),
    );
  }

  const existingLinks = await platformLinkService.getLinksByUser(interaction.guild_id, targetUser);
  const existingPlatformLinks = existingLinks.filter((l) => l.platform === PLATFORM);
  const existingMatch = existingPlatformLinks.find((link) => link.platformId === xuid);

  if (existingMatch?.active) {
    return Response.json(
      buildEphemeralMessage(`That Xbox XUID is already linked to <@${targetUser}> in this server.`),
    );
  }

  let needsFollowUp = false;
  try {
    await platformLinkService.saveLink(
      {
        guildId: interaction.guild_id,
        userId: targetUser,
        platform: PLATFORM,
        platformId: xuid,
        linkedAtMs: Date.now(),
        manual: true,
        actionedByUserId: actionedBy,
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
      platformId: xuid,
      actionedBy: actionedBy ?? undefined,
    });
  } catch {
    needsFollowUp = true;
  }

  return Response.json(
    buildEphemeralMessage(
      `Manually linked <@${targetUser}> to Xbox XUID: ${xuid}${needsFollowUp ? "\nThe link was saved, but follow-up processing is incomplete. Ask a server admin to check the linked role and audit log." : ""}`,
    ),
  );
}

export async function handleXboxUnlinkCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const options = getSubcommandOptions(interaction);

  const targetUser = options.find((o) => o.name === "user")?.value as string | undefined;
  const xuid = options.find((o) => o.name === "xuid")?.value as string | undefined;
  const selfUnlink = !targetUser;
  const userId = selfUnlink ? getInteractionUserId(interaction) : targetUser;

  if (!userId) {
    return Response.json(buildEphemeralMessage("Could not determine user."));
  }

  let link: PlatformLink | null = null;
  if (xuid) {
    link = await platformLinkService.getLinkByPlatformId(interaction.guild_id, PLATFORM, xuid);
    if (link && link.userId !== userId) {
      return Response.json(
        buildEphemeralMessage(
          selfUnlink
            ? "That Xbox XUID is not linked to your Discord account in this server."
            : "That Xbox XUID is not linked to the selected user in this server.",
        ),
      );
    }
  } else {
    const allLinks = await platformLinkService.getLinksByUser(interaction.guild_id, userId);
    const platformLinks = allLinks.filter((l) => l.platform === PLATFORM);
    if (platformLinks.length === 1) {
      link = platformLinks[0];
    }
    if (platformLinks.length > 1) {
      return Response.json(
        buildEphemeralMessage(
          "Multiple Xbox links found for that user. Provide `xuid` to unlink a specific account.",
        ),
      );
    }
  }

  if (!link) {
    return Response.json(
      buildEphemeralMessage(
        selfUnlink
          ? "You do not have a linked Xbox account in this server."
          : "That user is not linked in this server.",
      ),
    );
  }

  await platformLinkService.deleteLink(interaction.guild_id, userId, PLATFORM);
  const remainingLinks = await platformLinkService.getLinksByUser(interaction.guild_id, userId);
  const remainingPlatformLinks = remainingLinks.filter((l) => l.platform === PLATFORM && l.active);
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
        ? `Your Xbox account has been unlinked.\nXUID: ${link.platformId}`
        : `Unlinked <@${userId}>.\nXUID: ${link.platformId}`,
    ),
  );
}

export async function handleXboxLinkedCountCommand(
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
    buildEphemeralMessage(`Total linked Xbox users in this server: **${links.length}**`),
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

function getPlatformDisplay(platform: PlatformLink["platform"]): {
  name: string;
  idLabel: string;
  profileUrl: (platformId: string) => string;
} {
  if (platform === "steam") {
    return {
      name: "Steam",
      idLabel: "SteamID64",
      profileUrl: (platformId) => `https://steamcommunity.com/profiles/${platformId}`,
    };
  }
  if (platform === "xbox") {
    return {
      name: "Xbox",
      idLabel: "Xbox XUID",
      profileUrl: (platformId) => `https://account.xbox.com/profile?gamertag=${platformId}`,
    };
  }
  return {
    name: platform,
    idLabel: "Platform ID",
    profileUrl: (platformId) => `https://example.invalid/${platform}/${platformId}`,
  };
}

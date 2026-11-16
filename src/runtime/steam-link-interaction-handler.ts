import { rethrowDiscordRateLimit } from "./interaction-rate-limit";
import { createChannelMessage } from "../discord";
import { buildEphemeralMessage } from "../discord-interactions";
import type { DiscordInteraction } from "./app-types";
import type { PlatformLink } from "./contracts/platform-link-store";
import {
  PlatformLinkFinalizationError,
  type PlatformLinkService,
} from "../services/platform-link-service";
import { createSteamIdentityAdapter } from "../services/platform-identity-adapter";
import { getInteractionUserId } from "./discord-interaction-parsers";
import { QuantityLimitError } from "./entitlement-checks";
import { DISCORD_CHANNEL_MESSAGE_RESPONSE, DISCORD_EPHEMERAL_FLAG } from "../discord/constants";
import { buildPlatformLinkMessage } from "./platform-link-buttons";

const PENDING_LINK_TTL_MS = 15 * 60 * 1000;
const steamIdentityAdapter = createSteamIdentityAdapter({});

export async function handleSteamLinkButtonInteraction(
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

  const config = await platformLinkService.readConfig(guildId, "steam");
  if (config?.enabled === false) {
    return Response.json(buildEphemeralMessage("Account linking is disabled in this server."));
  }
  if (!config) {
    return Response.json(
      buildEphemeralMessage(
        "This server has not been set up for Steam linking. A server admin needs to run `/setup` first.",
      ),
    );
  }

  const userLinks = (await platformLinkService.getLinksByUser(guildId, userId)).filter(
    (link) => link.platform === "steam" && link.active,
  );
  if (!config.allowMultipleLinks && userLinks.length > 0 && !config.allowRelink) {
    return Response.json(
      buildEphemeralMessage(`You are already linked to SteamID64: ${userLinks[0].platformId}`),
    );
  }

  const state = crypto.randomUUID().replace(/-/g, "");
  await platformLinkService.clearExpiredPendingLinks(Date.now() - PENDING_LINK_TTL_MS);
  await platformLinkService.createPendingLink(state, guildId, userId, "steam");

  const authUrl = `${publicUrl}/auth/steam/start?state=${encodeURIComponent(state)}`;

  return Response.json({
    type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
    data: {
      content: `Click here to sign in with Steam and link your account:\n${authUrl}\n\nOpenID only verifies your SteamID64 \u2014 your username and password stay with Steam.`,
      flags: DISCORD_EPHEMERAL_FLAG,
    },
  });
}

export async function handleSteamRequestCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
  discordBotToken: string,
): Promise<Response> {
  if (!interaction.guild_id || !interaction.channel_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const config = await platformLinkService.readConfig(interaction.guild_id, "steam");
  if (config?.enabled === false) {
    return Response.json(buildEphemeralMessage("Account linking is disabled in this server."));
  }
  if (!config) {
    return Response.json(
      buildEphemeralMessage(
        "This server has not been set up for Steam linking. Run `/steamlink setup` first.",
      ),
    );
  }

  try {
    await createChannelMessage(
      interaction.channel_id,
      buildPlatformLinkMessage("steam", config, { buttonOnly: true }),
      discordBotToken,
    );
    return Response.json(buildEphemeralMessage("Steam link request posted."));
  } catch {
    return Response.json(buildEphemeralMessage("Failed to post the link request."));
  }
}

export async function handleSteamWhoisCommand(
  interaction: DiscordInteraction,
  platformLinkService: Pick<
    PlatformLinkService,
    "readConfig" | "getLinksByUser" | "getLinkByPlatformId"
  >,
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const options = getSubcommandOptions(interaction);

  const userOption = options.find((o) => o.name === "user");
  const steamIdOption = options.find((o) => o.name === "steamid");

  const userId = userOption?.value as string | undefined;
  const steamId = steamIdOption?.value as string | undefined;

  if (!userId && !steamId) {
    return Response.json(buildEphemeralMessage("Use either user or steamid."));
  }

  let platformLinks: PlatformLink[] = [];

  if (steamId) {
    const link = await platformLinkService.getLinkByPlatformId(
      interaction.guild_id,
      "steam",
      steamId,
    );
    if (link) {
      platformLinks = [link];
    }
  } else if (userId) {
    platformLinks = await platformLinkService.getLinksByUser(interaction.guild_id, userId);
  }

  const links = platformLinks.filter((link) => link.platform === "steam");
  const additionalPlatformLinks = platformLinks.filter((link) => link.platform !== "steam");

  if (links.length === 0 && additionalPlatformLinks.length === 0) {
    return Response.json(buildEphemeralMessage("No linked account found in this server."));
  }

  const config = await platformLinkService.readConfig(interaction.guild_id, "steam");
  const wf = config?.whoisFields ?? [];

  const showProfile = wf.length === 0 || wf.includes("profile");

  const lines: string[] = links.flatMap((link, index) => {
    const entryLines: string[] = [
      `**Discord User:** <@${link.userId}> (ID: ${link.userId})`,
      `**SteamID64:** ${link.platformId}`,
      `**Status:** ${link.active ? "Active" : "Inactive - relink required"}`,
    ];

    if (showProfile) {
      entryLines.push(`**Steam Profile:** https://steamcommunity.com/profiles/${link.platformId}`);
    }

    entryLines.push(
      `**Linked At:** <t:${Math.floor(link.linkedAtMs / 1000)}:F>`,
      `**Link Type:** ${link.manual ? "Manual admin link" : "Steam sign-in"}`,
    );
    entryLines.push(...steamIdentityAdapter.describe(link, config).whoisLines);

    if (index > 0) {
      return ["", ...entryLines];
    }
    return entryLines;
  });

  for (const link of additionalPlatformLinks) {
    const metadata = getPlatformDisplay(link.platform);
    if (lines.length > 0) lines.push("");
    lines.push(
      `**Discord User:** <@${link.userId}> (ID: ${link.userId})`,
      `**Platform:** ${metadata.name}`,
      `**${metadata.idLabel}:** ${link.platformId}`,
    );
    if (showProfile) {
      lines.push(`**${metadata.name} Profile:** ${metadata.profileUrl(link.platformId)}`);
    }
    lines.push(
      `**Linked At:** <t:${Math.floor(link.linkedAtMs / 1000)}:F>`,
      `**Link Type:** ${link.manual ? "Manual admin link" : `${metadata.name} sign-in`}`,
    );
  }

  return Response.json(buildEphemeralMessage(lines.join("\n")));
}

export async function handleSteamManualLinkCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const options = getSubcommandOptions(interaction);

  const targetUser = options.find((o) => o.name === "user")?.value as string | undefined;
  const steamId64 = options.find((o) => o.name === "steamid")?.value as string | undefined;

  if (!targetUser || !steamId64) {
    return Response.json(buildEphemeralMessage("Missing user or steamid."));
  }

  if (!/^\d{17}$/.test(steamId64)) {
    return Response.json(
      buildEphemeralMessage("That does not look like a valid SteamID64. It should be 17 numbers."),
    );
  }

  const duplicate = await platformLinkService.getLinkByPlatformId(
    interaction.guild_id,
    "steam",
    steamId64,
  );
  if (duplicate && duplicate.userId !== targetUser) {
    return Response.json(
      buildEphemeralMessage(
        `That SteamID64 is already linked to <@${duplicate.userId}> in this server.`,
      ),
    );
  }

  const actionedBy = getInteractionUserId(interaction);
  const config = await platformLinkService.readConfig(interaction.guild_id, "steam");
  if (config?.enabled === false) {
    return Response.json(buildEphemeralMessage("Account linking is disabled in this server."));
  }
  if (!config) {
    return Response.json(
      buildEphemeralMessage(
        "This server has not been set up for Steam linking. A server admin needs to run `/setup` first.",
      ),
    );
  }
  const existingLinks = (
    await platformLinkService.getLinksByUser(interaction.guild_id, targetUser)
  ).filter((link) => link.platform === "steam");
  const existingMatch = existingLinks.find((link) => link.platformId === steamId64);

  if (existingMatch?.active) {
    return Response.json(
      buildEphemeralMessage(`That SteamID64 is already linked to <@${targetUser}> in this server.`),
    );
  }

  let needsFollowUp = false;
  try {
    await platformLinkService.saveLink(
      {
        guildId: interaction.guild_id,
        userId: targetUser,
        platform: "steam",
        platformId: steamId64,
        linkedAtMs: Date.now(),
        manual: true,
        actionedByUserId: actionedBy,
        metadataJson: null,
        active: true,
      },
      !config.allowMultipleLinks && existingLinks.length > 0,
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
    await platformLinkService.assignLinkedRole(interaction.guild_id, targetUser, "steam");
  } catch {
    needsFollowUp = true;
  }
  try {
    await platformLinkService.sendLogEmbed(interaction.guild_id, "manual", {
      discordId: targetUser,
      platform: "steam",
      platformId: steamId64,
      actionedBy: actionedBy ?? undefined,
    });
  } catch {
    needsFollowUp = true;
  }

  return Response.json(
    buildEphemeralMessage(
      `Manually linked <@${targetUser}> to SteamID64: ${steamId64}\nProfile: https://steamcommunity.com/profiles/${steamId64}${needsFollowUp ? "\nThe link was saved, but follow-up processing is incomplete. Ask a server admin to check Server Levels, the linked role, and the audit log." : ""}`,
    ),
  );
}

export async function handleSteamUnlinkCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const options = getSubcommandOptions(interaction);

  const targetUser = options.find((o) => o.name === "user")?.value as string | undefined;
  const steamId = options.find((o) => o.name === "steamid")?.value as string | undefined;
  const selfUnlink = !targetUser;
  const userId = selfUnlink ? getInteractionUserId(interaction) : targetUser;

  if (!userId) {
    return Response.json(buildEphemeralMessage("Could not determine user."));
  }

  if (steamId && !/^\d{17}$/.test(steamId)) {
    return Response.json(
      buildEphemeralMessage("That does not look like a valid SteamID64. It should be 17 numbers."),
    );
  }

  let link = null;
  if (steamId) {
    link = await platformLinkService.getLinkByPlatformId(interaction.guild_id, "steam", steamId);
    if (link && link.userId !== userId) {
      return Response.json(
        buildEphemeralMessage(
          selfUnlink
            ? "That SteamID64 is not linked to your Discord account in this server."
            : "That SteamID64 is not linked to the selected user in this server.",
        ),
      );
    }
  } else {
    const links = (await platformLinkService.getLinksByUser(interaction.guild_id, userId)).filter(
      (entry) => entry.platform === "steam",
    );
    if (links.length === 1) {
      link = links[0];
    }
    if (links.length > 1) {
      return Response.json(
        buildEphemeralMessage(
          "Multiple Steam links found for that user. Provide `steamid` to unlink a specific account.",
        ),
      );
    }
  }

  if (!link) {
    return Response.json(
      buildEphemeralMessage(
        selfUnlink
          ? "You do not have a linked Steam account in this server."
          : "That user is not linked in this server.",
      ),
    );
  }

  await platformLinkService.deleteLink(interaction.guild_id, userId, "steam", link.platformId);
  const remainingLinks = (
    await platformLinkService.getLinksByUser(interaction.guild_id, userId)
  ).filter((entry) => entry.platform === "steam" && entry.active);
  if (remainingLinks.length === 0) {
    await platformLinkService.removeLinkedRole(interaction.guild_id, userId, "steam");
  }

  const actionedBy = selfUnlink ? userId : getInteractionUserId(interaction);
  await platformLinkService.sendLogEmbed(interaction.guild_id, "unlinked", {
    actionedBy: actionedBy ?? undefined,
    linkSnapshot: link,
  });

  return Response.json(
    buildEphemeralMessage(
      selfUnlink
        ? `Your Steam account has been unlinked.\nSteamID64: ${link.platformId}`
        : `Unlinked <@${userId}>.\nSteamID64: ${link.platformId}`,
    ),
  );
}

export async function handleSteamLinkedCountCommand(
  interaction: DiscordInteraction,
  platformLinkService: PlatformLinkService,
): Promise<Response> {
  if (!interaction.guild_id) {
    return Response.json(buildEphemeralMessage("This command must be used inside a server."));
  }

  const links = (await platformLinkService.listLinks(interaction.guild_id, "steam")).filter(
    (link) => link.active,
  );
  return Response.json(
    buildEphemeralMessage(`Total linked users in this server: **${links.length}**`),
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

import { buildEphemeralMessage, type CommandInvocation } from "../discord-interactions";
import { createPlatformLinkIdentityReader } from "../services/platform-link-identity-reader";
import {
  STEAM_ID64,
  WARDOGS_TRACKER_URL,
  type WardogsCommunityData,
  type WardogsPublicStats,
} from "../wardogs/community-data";
import { formatWardogsGoldStatus } from "../wardogs/gold-status";
import type { WardogsTrackerConnect } from "../wardogs/tracker-connect";
import type { PlatformLinkStore } from "./contracts/platform-link-store";

const cashNumber = new Intl.NumberFormat("en-US");
const roles = ["assault", "medic", "recon", "support", "driver", "pilot"];
const reply = (message: string) => Response.json(buildEphemeralMessage(message));

export async function handleWardogsCommunityCommand(
  invocation: Exclude<
    Extract<CommandInvocation, { commandName: "wardogs" }>,
    { subcommandName: "gold-daily" }
  >,
  options: {
    guildId: string;
    actorUserId: string | undefined;
    platformLink: PlatformLinkStore;
    data: WardogsCommunityData;
    connect?: WardogsTrackerConnect;
    steamLinkEnabled: boolean;
  },
): Promise<Response> {
  if (invocation.subcommandName === "gold") {
    try {
      const gold = await options.data.readGoldStatus();
      if (!gold) return reply("The bot operator needs to configure the WARDOGS gold price feed.");
      return reply(formatWardogsGoldStatus(gold));
    } catch {
      return reply("The WARDOGS gold price is temporarily unavailable. Try again shortly.");
    }
  }

  const steamId = invocation.steamId;
  if (steamId !== null && !STEAM_ID64.test(steamId)) return reply("Enter a 17-digit SteamID64.");

  if (invocation.subcommandName === "stats" && steamId !== null) {
    if (invocation.userId) return reply("Choose a server member or enter a SteamID64.");
    return readStats(options.data, steamId, options.connect !== undefined);
  }

  if (invocation.subcommandName === "sync" && !options.connect) {
    return reply(
      `Sync your profile on [WARDOGS Tracker](${WARDOGS_TRACKER_URL}/stats). Close WARDOGS before signing in with Steam.`,
    );
  }
  if (!options.steamLinkEnabled) {
    return reply(
      "Steam Player Link is disabled here. You can look up a public profile with /wardogs stats steamid.",
    );
  }
  const userId =
    (invocation.subcommandName === "stats" ? invocation.userId : null) ?? options.actorUserId;
  if (!userId) return reply("Unable to identify the requesting member.");
  const links = await createPlatformLinkIdentityReader(options.platformLink).listActiveIdentities(
    options.guildId,
    userId,
    "steam",
  );
  const linkedSteamIds = links
    .filter((link) => link.assurance === "authenticated" && STEAM_ID64.test(link.platformId))
    .map((link) => link.platformId);
  if (linkedSteamIds.length === 0) {
    return reply(
      userId === options.actorUserId
        ? "Use your server’s Steam Player Link panel or `/steamlink request` to link your Steam account. For a public lookup, use `/wardogs stats steamid`."
        : "That member has no active Steam Player Link verified through Steam sign-in. Use /wardogs stats steamid to look up a public profile directly.",
    );
  }
  if (steamId === null && linkedSteamIds.length > 1) {
    return reply(
      "More than one Steam account is linked. Use /wardogs " +
        invocation.subcommandName +
        " steamid to choose an account.",
    );
  }
  const selectedSteamId = steamId ?? linkedSteamIds[0]!;
  if (invocation.subcommandName === "sync" && options.connect) {
    if (!linkedSteamIds.includes(selectedSteamId))
      return reply("Choose one of your verified Steam links.");
    const url = await options.connect.createStartUrl({
      guildId: options.guildId,
      userId,
      steamId: selectedSteamId,
    });
    return reply(
      `Close WARDOGS, then [sync with WARDOGS Tracker](${url}). This signs you in through Steam and creates or refreshes your Tracker profile. You can manage its visibility on WARDOGS Tracker.`,
    );
  }
  return readStats(options.data, selectedSteamId, options.connect !== undefined);
}

async function readStats(data: WardogsCommunityData, steamId: string, canSync: boolean) {
  try {
    const stats = await data.readPublicStats(steamId);
    if (!stats) {
      const sync = canSync ? "`/wardogs sync`" : `[WARDOGS Tracker](${WARDOGS_TRACKER_URL}/stats)`;
      return reply(
        `WARDOGS Tracker has no public stats available for that Steam account. If it’s yours, you can start a sync using ${sync}.`,
      );
    }
    return reply(formatStats(steamId, stats));
  } catch {
    return reply("WARDOGS Tracker is temporarily unavailable. Try again shortly.");
  }
}

function formatStats(steamId: string, stats: WardogsPublicStats): string {
  const lines = [
    `**[WARDOGS career stats](${WARDOGS_TRACKER_URL}/profile/${steamId})**`,
    `Level **${cashNumber.format(stats.wardogLevel)}** · **${cashNumber.format(stats.careerXp)}** career XP`,
  ];
  const roleLevels = roles.flatMap((role) => {
    const level = stats.roles?.[role]?.level;
    return level === undefined
      ? []
      : [`${role[0]!.toUpperCase()}${role.slice(1)} ${cashNumber.format(level)}`];
  });
  if (roleLevels.length) lines.push(roleLevels.join(" · "));
  const holdings = [
    stats.unlocks == null ? null : `${cashNumber.format(stats.unlocks)} unlocks`,
    stats.cash == null ? null : `${cashNumber.format(stats.cash)} cash`,
    stats.gold == null ? null : `${cashNumber.format(stats.gold)} gold bars`,
  ].filter(Boolean);
  if (holdings.length) lines.push(holdings.join(" · "));
  lines.push(
    `Synced <t:${Math.floor(Date.parse(stats.syncedAt) / 1000)}:R>`,
    `[Data from WARDOGS Tracker](${WARDOGS_TRACKER_URL})`,
  );
  return lines.join("\n");
}

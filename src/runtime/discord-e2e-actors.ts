import { isRecord } from "../unknown-parse";
import type { GatewayDiscordCapabilities } from "./gateway-events/discord-capabilities";

export interface DiscordE2eActors {
  readonly guildId: string;
  view<T>(payload: T, guildId: string, activeBotUserId?: string): T;
}

export function readDiscordE2eActors(
  environment: Record<string, string | undefined>,
): DiscordE2eActors {
  if (environment.STAGING_MODE !== "true") {
    throw new Error("The Discord E2E entrypoint requires STAGING_MODE=true.");
  }
  let database: URL;
  try {
    database = new URL(environment.DATABASE_URL ?? "");
  } catch {
    throw new Error("Discord E2E requires a separate DATABASE_URL ending in _e2e or _e2e_test.");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !/^\/[a-zA-Z0-9_]+_e2e(?:_test)?$/.test(database.pathname) ||
    ["database", "dbname", "options"].some((name) => database.searchParams.has(name))
  ) {
    throw new Error("Discord E2E requires a separate DATABASE_URL ending in _e2e or _e2e_test.");
  }
  const guildId = snowflake(environment.HAF_E2E_GUILD_ID, "HAF_E2E_GUILD_ID");
  const ownBotId = snowflake(environment.BOT_USER_ID, "BOT_USER_ID");
  const rawIds = (environment.HAF_E2E_BOT_USER_IDS ?? "").split(",");
  if (rawIds.length > 10) throw new Error("HAF_E2E_BOT_USER_IDS supports at most ten tester bots.");
  const botIds = new Set(rawIds.map((id) => snowflake(id.trim(), "HAF_E2E_BOT_USER_IDS")));
  if (botIds.has(ownBotId)) throw new Error("HAF_E2E_BOT_USER_IDS must not include HAF's own bot.");

  return Object.freeze({
    guildId,
    view<T>(payload: T, eventGuildId: string, activeBotUserId = ownBotId): T {
      if (
        eventGuildId !== guildId ||
        !isRecord(payload) ||
        (payload.guild_id !== undefined && payload.guild_id !== guildId) ||
        payload.webhook_id != null
      )
        return payload;
      const userView = (user: unknown) => {
        if (
          !isRecord(user) ||
          user.bot !== true ||
          typeof user.id !== "string" ||
          !botIds.has(user.id) ||
          user.id === ownBotId ||
          user.id === activeBotUserId
        )
          return user;
        return { ...user, bot: false };
      };
      const author = userView(payload.author);
      const user = userView(payload.user);
      const memberUser = isRecord(payload.member) ? userView(payload.member.user) : undefined;
      return {
        ...payload,
        ...(author !== payload.author ? { author } : {}),
        ...(user !== payload.user ? { user } : {}),
        ...(isRecord(payload.member) && memberUser !== payload.member.user
          ? { member: { ...payload.member, user: memberUser } }
          : {}),
      } as T;
    },
  });
}
export function rejectDiscordE2eEnvironment(environment: Record<string, string | undefined>): void {
  if (
    environment.HAF_E2E_GUILD_ID !== undefined ||
    environment.HAF_E2E_BOT_USER_IDS !== undefined
  ) {
    throw new Error("HAF_E2E_* configuration requires the separate Discord E2E entrypoint.");
  }
}

export function withDiscordE2eActors(
  discord: GatewayDiscordCapabilities,
  actors: DiscordE2eActors | undefined,
  guildId: string,
  activeBotUserId: string,
): GatewayDiscordCapabilities {
  if (!actors) return discord;
  return {
    ...discord,
    fetchGuildMember: async (memberGuildId, userId) =>
      actors.view(
        await discord.fetchGuildMember(memberGuildId, userId),
        memberGuildId,
        activeBotUserId,
      ),
    fetchChannelMessage: async (channelId, messageId) =>
      actors.view(
        await discord.fetchChannelMessage(channelId, messageId),
        guildId,
        activeBotUserId,
      ),
    reactionRoles: {
      ...discord.reactionRoles,
      fetchMember: async (memberGuildId, userId) =>
        actors.view(
          await discord.reactionRoles.fetchMember(memberGuildId, userId),
          memberGuildId,
          activeBotUserId,
        ),
    },
  };
}

function snowflake(raw: string | undefined, name: string): string {
  if (!raw || !/^[1-9][0-9]{16,19}$/.test(raw) || BigInt(raw) > 18_446_744_073_709_551_615n) {
    throw new Error(`${name} must contain a valid Discord snowflake ID.`);
  }
  return raw;
}

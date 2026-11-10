import {
  GuildResourceScope,
  GuildResourceValidator,
  type GuildResourceLoader,
} from "../../src/discord/guild-resource-validator";
import type {
  DiscordChannelResource,
  DiscordRoleResource,
  GuildTicketResources,
} from "../../src/discord/guilds";

function channel(id: string, type: number, guildId?: string, parentId: string | null = null) {
  return {
    id,
    guild_id: guildId,
    name: id,
    type,
    parent_id: parentId,
    position: 0,
  } satisfies DiscordChannelResource;
}

function role(id: string) {
  return {
    id,
    name: id,
    permissions: "0",
    position: 0,
  } satisfies DiscordRoleResource;
}

/** Deterministic no-network validator for tests that are not exercising resource rejection. */
export function createPermissiveGuildResourceValidator(): GuildResourceValidator {
  const loader: GuildResourceLoader = {
    async list() {
      return { channels: [], roles: [] };
    },
    async fetchChannel(channelId) {
      return channel(channelId, 11, "test-guild", "test-parent");
    },
  };
  const validator = new GuildResourceValidator(loader);
  validator.forGuild = async (guildId: string) =>
    ({
      guildId,
      channels: [],
      roles: [],
      requireChannel: (id: string) => channel(id, 0, guildId),
      requireTextChannel: (id: string) => channel(id, 0, guildId),
      requireVoiceChannel: (id: string) => channel(id, 2, guildId),
      requireForumChannel: (id: string) => channel(id, 15, guildId),
      requireCategory: (id: string) => channel(id, 4, guildId),
      requireMessageChannel: (id: string) => channel(id, 0, guildId),
      requireRole: (id: string) => role(id),
      requireRoles: () => undefined,
      requireChannels: () => undefined,
      requireThread: async (id: string, expectedParentId?: string) =>
        channel(id, 11, guildId, expectedParentId ?? "test-parent"),
    }) as unknown as GuildResourceScope;
  validator.requireTextChannel = async (guildId, id) => channel(id, 0, guildId);
  validator.requireVoiceChannel = async (guildId, id) => channel(id, 2, guildId);
  validator.requireForumChannel = async (guildId, id) => channel(id, 15, guildId);
  validator.requireMessageChannel = async (guildId, id) => channel(id, 0, guildId);
  validator.requireCategory = async (guildId, id) => channel(id, 4, guildId);
  validator.requireRole = async (_guildId, id) => role(id);
  validator.requireThread = async (guildId, id, expectedParentId) =>
    channel(id, 11, guildId, expectedParentId ?? "test-parent");
  return validator;
}

export function createStaticGuildResourceValidator(input: {
  guilds: Record<string, GuildTicketResources>;
  fetchedChannels?: Record<string, DiscordChannelResource | Error>;
}): GuildResourceValidator {
  return new GuildResourceValidator({
    async list(guildId) {
      return input.guilds[guildId] ?? { channels: [], roles: [] };
    },
    async fetchChannel(channelId) {
      const value = input.fetchedChannels?.[channelId];
      if (value instanceof Error) throw value;
      if (value) return value;
      throw new Error("not found");
    },
  });
}

export function testChannel(
  id: string,
  type: number,
  guildId?: string,
  parentId: string | null = null,
): DiscordChannelResource {
  return channel(id, type, guildId, parentId);
}

export function testRole(id: string): DiscordRoleResource {
  return role(id);
}

import {
  fetchDiscordChannel,
  listGuildTicketResources,
  type DiscordChannelResource,
  type DiscordRoleResource,
  type GuildTicketResources,
} from "./guilds";

const TEXT_CHANNEL_TYPES = new Set([0, 5]);
const VOICE_CHANNEL_TYPES = new Set([2]);
const CATEGORY_CHANNEL_TYPES = new Set([4]);
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
const FORUM_CHANNEL_TYPES = new Set([15]);
const MESSAGE_CHANNEL_TYPES = new Set([...TEXT_CHANNEL_TYPES, ...THREAD_CHANNEL_TYPES]);
const THREAD_PARENT_CHANNEL_TYPES = new Set([...TEXT_CHANNEL_TYPES, ...FORUM_CHANNEL_TYPES]);

export type GuildResourceKind =
  | "channel"
  | "text-channel"
  | "voice-channel"
  | "forum-channel"
  | "category"
  | "thread"
  | "message-channel"
  | "role";

export class GuildResourceValidationError extends Error {
  constructor(
    readonly resourceKind: GuildResourceKind,
    options?: ErrorOptions,
  ) {
    super("Invalid Discord resource.", options);
    this.name = "GuildResourceValidationError";
  }
}

export interface GuildResourceLoader {
  list(guildId: string): Promise<GuildTicketResources>;
  fetchChannel(channelId: string): Promise<DiscordChannelResource>;
}

export class GuildResourceScope {
  readonly channels: readonly DiscordChannelResource[];
  readonly roles: readonly DiscordRoleResource[];
  private readonly channelsById: Map<string, DiscordChannelResource>;
  private readonly rolesById: Map<string, DiscordRoleResource>;

  constructor(
    readonly guildId: string,
    resources: GuildTicketResources,
    private readonly loader: GuildResourceLoader,
  ) {
    this.channels = resources.channels;
    this.roles = resources.roles;
    this.channelsById = new Map(resources.channels.map((channel) => [channel.id, channel]));
    this.rolesById = new Map(resources.roles.map((role) => [role.id, role]));
  }

  requireChannel(channelId: string): DiscordChannelResource {
    return this.requireKnownChannel(channelId, undefined, "channel");
  }

  requireTextChannel(channelId: string): DiscordChannelResource {
    return this.requireKnownChannel(channelId, TEXT_CHANNEL_TYPES, "text-channel");
  }

  requireVoiceChannel(channelId: string): DiscordChannelResource {
    return this.requireKnownChannel(channelId, VOICE_CHANNEL_TYPES, "voice-channel");
  }

  requireForumChannel(channelId: string): DiscordChannelResource {
    return this.requireKnownChannel(channelId, FORUM_CHANNEL_TYPES, "forum-channel");
  }

  requireCategory(categoryId: string): DiscordChannelResource {
    return this.requireKnownChannel(categoryId, CATEGORY_CHANNEL_TYPES, "category");
  }

  requireMessageChannel(channelId: string): DiscordChannelResource {
    return this.requireKnownChannel(channelId, MESSAGE_CHANNEL_TYPES, "message-channel");
  }

  requireRole(roleId: string): DiscordRoleResource {
    const role = this.rolesById.get(roleId);
    if (!role) throw new GuildResourceValidationError("role");
    return role;
  }

  requireRoles(roleIds: Iterable<string>): void {
    for (const roleId of roleIds) this.requireRole(roleId);
  }

  requireChannels(channelIds: Iterable<string>): void {
    for (const channelId of channelIds) this.requireChannel(channelId);
  }

  async requireThread(
    threadId: string,
    expectedParentId?: string,
  ): Promise<DiscordChannelResource> {
    let thread: DiscordChannelResource;
    try {
      // Fetch directly so delayed operations revalidate current Guild ownership and parentage.
      thread = await this.loader.fetchChannel(threadId);
    } catch (cause) {
      throw new GuildResourceValidationError("thread", { cause });
    }
    const parent = thread.parent_id ? this.channelsById.get(thread.parent_id) : undefined;
    if (
      !THREAD_CHANNEL_TYPES.has(thread.type) ||
      thread.guild_id !== this.guildId ||
      !parent ||
      !THREAD_PARENT_CHANNEL_TYPES.has(parent.type) ||
      (expectedParentId !== undefined && thread.parent_id !== expectedParentId)
    ) {
      throw new GuildResourceValidationError("thread");
    }
    return thread;
  }

  private requireKnownChannel(
    channelId: string,
    allowedTypes: ReadonlySet<number> | undefined,
    resourceKind: GuildResourceKind,
  ): DiscordChannelResource {
    const channel = this.channelsById.get(channelId);
    if (!channel || (allowedTypes && !allowedTypes.has(channel.type))) {
      throw new GuildResourceValidationError(resourceKind);
    }
    return channel;
  }
}

export class GuildResourceValidator {
  constructor(private readonly loader: GuildResourceLoader) {}

  async forGuild(guildId: string): Promise<GuildResourceScope> {
    return new GuildResourceScope(guildId, await this.loader.list(guildId), this.loader);
  }

  async requireTextChannel(guildId: string, channelId: string): Promise<DiscordChannelResource> {
    return (await this.forGuild(guildId)).requireTextChannel(channelId);
  }

  async requireVoiceChannel(guildId: string, channelId: string): Promise<DiscordChannelResource> {
    return (await this.forGuild(guildId)).requireVoiceChannel(channelId);
  }

  async requireForumChannel(guildId: string, channelId: string): Promise<DiscordChannelResource> {
    return (await this.forGuild(guildId)).requireForumChannel(channelId);
  }

  async requireMessageChannel(guildId: string, channelId: string): Promise<DiscordChannelResource> {
    return (await this.forGuild(guildId)).requireMessageChannel(channelId);
  }

  async requireCategory(guildId: string, categoryId: string): Promise<DiscordChannelResource> {
    return (await this.forGuild(guildId)).requireCategory(categoryId);
  }

  async requireRole(guildId: string, roleId: string): Promise<DiscordRoleResource> {
    return (await this.forGuild(guildId)).requireRole(roleId);
  }

  async requireThread(
    guildId: string,
    threadId: string,
    expectedParentId?: string,
  ): Promise<DiscordChannelResource> {
    return (await this.forGuild(guildId)).requireThread(threadId, expectedParentId);
  }
}

export function createDiscordGuildResourceValidator(
  botToken: string,
  listResources: GuildResourceLoader["list"] = (guildId) =>
    listGuildTicketResources(guildId, botToken),
): GuildResourceValidator {
  return new GuildResourceValidator({
    list: listResources,
    fetchChannel: (channelId) => fetchDiscordChannel(channelId, botToken),
  });
}

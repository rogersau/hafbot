export interface DiscordGuildMemberAdd {
  guild_id?: string;
  nick?: string | null;
  user?: {
    id?: string;
    username?: string;
    global_name?: string | null;
  };
}

export interface DiscordGuildMemberUpdate extends DiscordGuildMemberAdd {
  roles?: string[];
}

export interface DiscordGatewayGuildLifecycle {
  id?: string;
  name?: string;
  member_count?: number;
  owner_id?: string;
  owner?: boolean;
  icon?: string | null;
}

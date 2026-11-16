import type { GuildNotificationChannelStore } from "./guild-notification-channel-store";
import type { BlocklistConfig, ChannelFilterMode } from "../../types";

export interface BlocklistStore extends GuildNotificationChannelStore {
  setGuildEnabled(guildId: string, enabled: boolean): Promise<void>;
  readConfig(): Promise<BlocklistConfig>;
  readGuildConfig(guildId: string): Promise<BlocklistConfig>;
  applyGuildEmojiMutation(body: {
    guildId: string;
    emoji: string;
    action: "add" | "remove";
  }): Promise<BlocklistConfig>;
  applyGuildEmojiMutations(body: {
    guildId: string;
    emojis: string[];
    action: "add";
  }): Promise<BlocklistConfig>;
  upsertGuildChannelFilter(body: {
    guildId: string;
    channelMode: ChannelFilterMode;
    channelIds: string[];
  }): Promise<BlocklistConfig>;
}

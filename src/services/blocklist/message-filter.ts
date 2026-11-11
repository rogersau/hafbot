import {
  allowUserMentions,
  formatUserMention,
  type CreateChannelMessageInput,
} from "../../discord/messages";
import type { Env } from "../../env";
import type { BlocklistConfig, DiscordMessageCreate } from "../../types";
import { isEmojiBlocked, normalizeEmoji } from "../../blocklist";

type BlocklistEnv = Pick<Env, "BOT_USER_ID" | "DISCORD_BOT_TOKEN">;

export interface MessageFilterDependencies {
  readBlocklistForGuild(guildId: string): Promise<BlocklistConfig>;
  resolveBotDisplayName(guildId: string): Promise<string>;
  deleteChannelMessage(channelId: string, messageId: string, token: string): Promise<void>;
  createUserDmMessage(
    userId: string,
    body: CreateChannelMessageInput,
    token: string,
  ): Promise<{ id: string; channel_id: string; content: string }>;
}

export async function moderateMessageCreate(
  message: DiscordMessageCreate | null,
  env: BlocklistEnv,
  dependencies: MessageFilterDependencies,
): Promise<void> {
  if (!message?.guild_id || !message.author?.id) return;

  let blocklist;
  try {
    blocklist = await dependencies.readBlocklistForGuild(message.guild_id);
  } catch (error) {
    console.error("Failed to load blocklist config", error);
    return;
  }

  if (message.author?.id === blocklist.botUserId) {
    return;
  }

  if (!message.guild_id || !message.author?.id) {
    return;
  }

  const blockedEmoji = findBlockedEmoji(
    message.content,
    blocklist,
    message.guild_id,
    message.channel_id,
  );

  if (!blockedEmoji) {
    return;
  }

  try {
    await dependencies.deleteChannelMessage(message.channel_id, message.id, env.DISCORD_BOT_TOKEN);
  } catch (error) {
    console.error("Failed to delete blocked message", error);
    return;
  }

  if (message.author.bot || message.webhook_id) return;

  try {
    await dependencies.createUserDmMessage(
      message.author.id,
      {
        content:
          `Your message was deleted by ${await dependencies.resolveBotDisplayName(message.guild_id)}.\n` +
          `Who sent it: ${formatUserMention(message.author.id)}\n` +
          `Message: ${message.content}\n` +
          `Blocked emoji: ${blockedEmoji}\n` +
          `Reason: This guild blocks that emoji in messages.`,
        allowed_mentions: allowUserMentions([message.author.id]),
      },
      env.DISCORD_BOT_TOKEN,
    );
  } catch (error) {
    console.error("Failed to DM user about blocked message", error);
  }
}

function findBlockedEmoji(
  content: string,
  blocklist: BlocklistConfig,
  guildId: string | undefined,
  channelId: string,
): string | null {
  if (!guildId) {
    return null;
  }

  const guildConfig = blocklist.guilds[guildId];
  if (!guildConfig?.enabled) {
    return null;
  }

  const contentWithoutEmojiPresentation = stripEmojiPresentationSelector(content);

  for (const blockedEmoji of guildConfig.emojis) {
    if (blockedEmoji.includes(":")) {
      if (findCustomEmojiIdentity(content, blocklist, guildId, channelId)) {
        return blockedEmoji;
      }
      continue;
    }

    const normalized = normalizeEmoji(blockedEmoji);
    if (
      normalized &&
      isEmojiBlocked(normalized, blocklist, guildId, channelId) &&
      contentWithoutEmojiPresentation.includes(stripEmojiPresentationSelector(blockedEmoji))
    ) {
      return blockedEmoji;
    }
  }

  return null;
}

function findCustomEmojiIdentity(
  content: string,
  blocklist: BlocklistConfig,
  guildId: string,
  channelId?: string,
): boolean {
  const matches = content.matchAll(/<a?:([^:\s>]+):(\d+)>/g);

  for (const match of matches) {
    const [, name, id] = match;
    if (isEmojiBlocked(`${name}:${id}`, blocklist, guildId, channelId)) {
      return true;
    }
  }

  return false;
}

function stripEmojiPresentationSelector(value: string): string {
  return value.replace(/\uFE0F/g, "");
}

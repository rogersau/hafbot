import {
  allowUserMentions,
  formatUserMention,
  type CreateChannelMessageInput,
} from "../../discord/messages";
import type { Env } from "../../env";
import { createCloudflareBlocklistStore } from "../../runtime/cloudflare-blocklist-store";
import type { BlocklistConfig, DiscordMessageCreate } from "../../types";
import { isEmojiBlocked, normalizeEmoji } from "../../blocklist";
import { createUserDmMessage, deleteChannelMessage } from "../../discord";

type BlocklistEnv = Pick<Env, "BOT_USER_ID" | "DISCORD_BOT_TOKEN"> & {
  HAF_DB?: D1Database;
};

interface MessageFilterDependencies {
  readBlocklist(): Promise<BlocklistConfig>;
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
  dependencies: Partial<MessageFilterDependencies> = {},
  resolveBotDisplayName?: (guildId: string) => Promise<string>,
): Promise<void> {
  if (!message) {
    return;
  }

  const readBlocklistFn =
    message.guild_id && dependencies.readBlocklistForGuild
      ? () => dependencies.readBlocklistForGuild!(message.guild_id!)
      : (dependencies.readBlocklist ?? (() => readBlocklist(env)));
  let blocklist;
  try {
    blocklist = await readBlocklistFn();
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

  const deleteMessageFn = dependencies.deleteChannelMessage ?? deleteChannelMessage;
  try {
    await deleteMessageFn(message.channel_id, message.id, env.DISCORD_BOT_TOKEN);
  } catch (error) {
    console.error("Failed to delete blocked message", error);
    return;
  }

  if (message.author.bot || message.webhook_id) return;

  try {
    const botDisplayName =
      resolveBotDisplayName ?? dependencies.resolveBotDisplayName ?? (async () => "HAF Bot");
    const createDmFn = dependencies.createUserDmMessage ?? createUserDmMessage;
    await createDmFn(
      message.author.id,
      {
        content:
          `Your message was deleted by ${await botDisplayName(message.guild_id)}.\n` +
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

async function readBlocklist(env: BlocklistEnv): Promise<BlocklistConfig> {
  if (!env.HAF_DB) {
    return {
      guilds: {},
      botUserId: env.BOT_USER_ID,
    };
  }

  return createCloudflareBlocklistStore(env.HAF_DB, env.BOT_USER_ID).readConfig();
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

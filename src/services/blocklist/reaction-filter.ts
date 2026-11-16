import { isEmojiBlocked, normalizeEmoji } from "../../blocklist";
import type { Env } from "../../env";
import type { BlocklistConfig, DiscordReaction } from "../../types";

type BlocklistEnv = Pick<Env, "BOT_USER_ID" | "DISCORD_BOT_TOKEN">;

export interface ReactionFilterDependencies {
  deleteReaction(
    channelId: string,
    messageId: string,
    emoji: DiscordReaction["emoji"],
    userId: string,
    token: string,
  ): Promise<void>;
  readBlocklistForGuild(guildId: string): Promise<BlocklistConfig>;
}

export async function moderateReactionAdd(
  reaction: DiscordReaction | null,
  env: BlocklistEnv,
  dependencies: ReactionFilterDependencies,
): Promise<"removed" | "ignored" | "failed"> {
  if (!reaction?.guild_id) {
    return "ignored";
  }

  const emojiName = normalizeEmoji(reaction.emoji.name);
  let emojiId: string;

  if (reaction.emoji.id && reaction.emoji.name) {
    emojiId = `${reaction.emoji.name}:${reaction.emoji.id}`;
  } else if (emojiName) {
    emojiId = emojiName;
  } else {
    return "ignored";
  }

  let blocklist;
  try {
    blocklist = await dependencies.readBlocklistForGuild(reaction.guild_id);
  } catch (error) {
    console.error("Failed to load blocklist config", error);
    return "failed";
  }

  if (reaction.user_id === blocklist.botUserId) {
    return "ignored";
  }

  if (!isEmojiBlocked(emojiId, blocklist, reaction.guild_id, reaction.channel_id)) {
    return "ignored";
  }

  try {
    await dependencies.deleteReaction(
      reaction.channel_id,
      reaction.message_id,
      reaction.emoji,
      reaction.user_id,
      env.DISCORD_BOT_TOKEN,
    );

    console.log(
      `Removed reaction ${emojiId} from message ${reaction.message_id} in channel ${reaction.channel_id}`,
    );
    return "removed";
  } catch (error) {
    console.error("Failed to remove reaction:", error);
    return "failed";
  }
}

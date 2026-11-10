import { isEmojiBlocked, normalizeEmoji } from "../../blocklist";
import { deleteReaction } from "../../discord";
import type { Env } from "../../env";
import { createCloudflareBlocklistStore } from "../../runtime/cloudflare-blocklist-store";
import type { BlocklistConfig, DiscordReaction } from "../../types";

type BlocklistEnv = Pick<Env, "BOT_USER_ID" | "DISCORD_BOT_TOKEN"> & {
  HAF_DB?: D1Database;
};

interface ReactionFilterDependencies {
  readBlocklist(): Promise<BlocklistConfig>;
  readBlocklistForGuild(guildId: string): Promise<BlocklistConfig>;
}

export async function moderateReactionAdd(
  reaction: DiscordReaction | null,
  env: BlocklistEnv,
  dependencies: Partial<ReactionFilterDependencies> = {},
): Promise<"removed" | "ignored" | "failed"> {
  if (!reaction) {
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
    const readBlocklistFn =
      reaction.guild_id && dependencies.readBlocklistForGuild
        ? () => dependencies.readBlocklistForGuild!(reaction.guild_id!)
        : (dependencies.readBlocklist ?? (() => readBlocklist(env)));
    blocklist = await readBlocklistFn();
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
    await deleteReaction(
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

async function readBlocklist(env: BlocklistEnv): Promise<BlocklistConfig> {
  return env.HAF_DB
    ? await createCloudflareBlocklistStore(env.HAF_DB, env.BOT_USER_ID).readConfig()
    : { guilds: {}, botUserId: env.BOT_USER_ID };
}

import { DISCORD_API, discordRequest } from "./client";
import type { CreateChannelMessageInput } from "./messages";

export interface CreateForumThreadInput {
  /** The GUILD_FORUM channel to create the thread in. */
  channelId: string;
  name: string;
  /** Starter message content (embeds, components, etc.). */
  message: CreateChannelMessageInput;
  /** Forum tag ids to apply to the new thread. */
  appliedTags?: string[];
}

export interface ForumThread {
  id: string;
  message: {
    id: string;
  };
}

/**
 * Create a thread in a GUILD_FORUM channel with a starter message.
 * Mirrors Discord's "Start Thread with Message" endpoint for forum channels.
 */
export async function createForumThread(
  input: CreateForumThreadInput,
  botToken: string,
): Promise<ForumThread> {
  const response = await discordRequest(
    `${DISCORD_API}/channels/${input.channelId}/threads`,
    "POST",
    botToken,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        auto_archive_duration: 10080,
        type: 11,
        applied_tags: input.appliedTags ?? [],
        message: input.message,
      }),
    },
  );

  const thread = (await response.json()) as ForumThread;
  return thread;
}

export interface ThreadModification {
  appliedTags?: string[];
  name?: string;
  locked?: boolean;
  archived?: boolean;
}

export interface MessageThread {
  id: string;
}

export async function createMessageThread(
  input: { channelId: string; messageId: string; name: string },
  botToken: string,
): Promise<MessageThread> {
  const response = await discordRequest(
    `${DISCORD_API}/channels/${input.channelId}/messages/${input.messageId}/threads`,
    "POST",
    botToken,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        auto_archive_duration: 10080,
      }),
    },
  );

  return (await response.json()) as MessageThread;
}

export async function removeThreadMember(
  threadId: string,
  userId: string,
  botToken: string,
): Promise<void> {
  const response = await discordRequest(
    `${DISCORD_API}/channels/${threadId}/thread-members/${userId}`,
    "DELETE",
    botToken,
  );
  response.body?.cancel();
}

/**
 * Modify a thread (e.g. apply or change its forum tags).
 */
export async function modifyThread(
  threadId: string,
  modification: ThreadModification,
  botToken: string,
): Promise<void> {
  const response = await discordRequest(`${DISCORD_API}/channels/${threadId}`, "PATCH", botToken, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(modification.name !== undefined ? { name: modification.name } : {}),
      ...(modification.appliedTags !== undefined ? { applied_tags: modification.appliedTags } : {}),
    }),
  });
  response.body?.cancel();
}

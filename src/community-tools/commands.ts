import type { DiscordCommandDefinition } from "../discord-commands";
const user = { type: 6, name: "user", description: "Member to target", required: true };
const reason = {
  type: 3,
  name: "reason",
  description: "Private staff reason",
  required: true,
  max_length: 500,
};
export const COMMUNITY_COMMAND_DEFINITIONS: DiscordCommandDefinition[] = [
  {
    name: "custom",
    description: "Use one of this server's custom replies",
    options: [
      {
        type: 3,
        name: "name",
        description: "Custom command name shown by the server admins",
        required: true,
        max_length: 40,
      },
    ],
  },
  { name: "Report Message", type: 3 },
  {
    name: "rep",
    description: "Thank helpful community members",
    options: [
      {
        type: 1,
        name: "give",
        description: "Thank a helpful teammate",
        options: [
          user,
          {
            type: 3,
            name: "reason",
            description: "Why you are thanking this member",
            max_length: 500,
          },
        ],
      },
      {
        type: 1,
        name: "profile",
        description: "View a member's reputation",
        options: [{ ...user, required: false }],
      },
      { type: 1, name: "leaderboard", description: "View reputation leaders" },
    ],
  },
  {
    name: "mod",
    description: "Staff moderation tools",
    options: [
      { type: 1, name: "warn", description: "Record a member warning", options: [user, reason] },
      {
        type: 1,
        name: "history",
        description: "View private member moderation history",
        options: [user],
      },
      {
        type: 1,
        name: "timeout",
        description: "Time out a member",
        options: [
          user,
          reason,
          {
            type: 4,
            name: "minutes",
            description: "Timeout duration in minutes",
            min_value: 1,
            max_value: 40320,
          },
        ],
      },
      {
        type: 1,
        name: "kick",
        description: "Remove a member from the server",
        options: [user, reason],
      },
      {
        type: 1,
        name: "ban",
        description: "Ban a member without deleting message history",
        options: [user, reason],
      },
      {
        type: 1,
        name: "unban",
        description: "Unban a Discord account by ID",
        options: [
          { type: 3, name: "user", description: "Discord user ID to unban", required: true },
          reason,
        ],
      },
      {
        type: 1,
        name: "purge",
        description: "Remove matching recent messages in this channel",
        options: [
          reason,
          {
            type: 4,
            name: "count",
            description: "Number of recent messages to inspect",
            min_value: 1,
            max_value: 100,
          },
          { ...user, required: false },
          {
            type: 3,
            name: "contains",
            description: "Only delete messages containing this text",
            max_length: 100,
          },
        ],
      },
    ],
  },
];

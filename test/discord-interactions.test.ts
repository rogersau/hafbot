/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import {
  ADMINISTRATOR_PERMISSION,
  MANAGE_GUILD_PERMISSION,
  type CommandInvocation,
  hasGuildAdminPermission,
  extractCommandInvocation,
  buildEphemeralMessage,
} from "../src/discord-interactions";
import { ALL_SLASH_COMMAND_DEFINITIONS, getSlashCommandDefinitions } from "../src/discord-commands";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";

type IsExact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

function expectTrue<T extends true>(_value: T) {}

expectTrue<IsExact<ReturnType<typeof extractCommandInvocation>, CommandInvocation | null>>(true);

test("hasGuildAdminPermission accepts Administrator and Manage Guild", () => {
  assert.equal(hasGuildAdminPermission(ADMINISTRATOR_PERMISSION.toString()), true);
  assert.equal(hasGuildAdminPermission(MANAGE_GUILD_PERMISSION.toString()), true);
  assert.equal(hasGuildAdminPermission("0"), false);
});

test("Discord command definitions include Hide Evidence message context menu", () => {
  assert.deepEqual(
    ALL_SLASH_COMMAND_DEFINITIONS.find((command) => command.name === "Hide Evidence"),
    { name: "Hide Evidence", type: 3 },
  );
});

test("/help is available without feature flags, options or privileged permissions", () => {
  const disabledFeatures = { ...ALL_FEATURES_ENABLED };
  for (const key of Object.keys(disabledFeatures) as Array<keyof typeof disabledFeatures>) {
    disabledFeatures[key] = false;
  }
  assert.deepEqual(
    getSlashCommandDefinitions(disabledFeatures).find((command) => command.name === "help"),
    { name: "help", description: "Get HAF Bot commands, setup guides and dashboard links" },
  );
  assert.deepEqual(extractCommandInvocation({ data: { name: "help" } }), {
    commandName: "help",
  });
});

test("extractCommandInvocation parses Hide Evidence target message", () => {
  assert.deepEqual(
    extractCommandInvocation({
      data: {
        name: "Hide Evidence",
        type: 3,
        target_id: "message-1",
        resolved: { messages: { "message-1": { id: "message-1", content: "proof" } } },
      },
    } as any),
    {
      commandName: "hide-evidence",
      targetId: "message-1",
      sourceMessage: { id: "message-1", content: "proof" },
    },
  );
});

test("extractCommandInvocation rejects Hide Evidence without target message data", () => {
  assert.equal(
    extractCommandInvocation({
      data: { name: "Hide Evidence", type: 3, target_id: "message-1" },
    } as any),
    null,
  );
});

test("extractCommandInvocation returns blocklist add/remove requests", () => {
  const addInvocation = {
    data: {
      name: "blocklist",
      options: [
        {
          name: "add",
          type: 1,
          options: [{ name: "emoji", value: "✅" }],
        },
      ],
    },
  } as any;

  const removeInvocation = {
    data: {
      name: "blocklist",
      options: [
        {
          name: "remove",
          type: 1,
          options: [{ name: "emoji", value: "❌" }],
        },
      ],
    },
  } as any;

  assert.deepEqual(extractCommandInvocation(addInvocation), {
    commandName: "blocklist",
    subcommandName: "add",
    emoji: "✅",
  });

  assert.deepEqual(extractCommandInvocation(removeInvocation), {
    commandName: "blocklist",
    subcommandName: "remove",
    emoji: "❌",
  });

  assert.equal(extractCommandInvocation({} as any), null);
});

test("extractCommandInvocation returns timedrole add/remove/list requests", () => {
  assert.deepEqual(
    extractCommandInvocation({
      data: {
        name: "timedrole",
        options: [
          {
            name: "add",
            type: 1,
            options: [
              { name: "user", value: "user-1" },
              { name: "role", value: "role-1" },
              { name: "duration", value: "1w" },
            ],
          },
        ],
        resolved: {
          users: {
            "user-1": { id: "user-1", username: "freshspawn", global_name: "Fresh Spawn" },
          },
          members: {
            "user-1": { nick: "Fresh Spawn" },
          },
        },
      },
    } as any),
    {
      commandName: "timedrole",
      subcommandName: "add",
      userId: "user-1",
      roleId: "role-1",
      duration: "1w",
      targetDisplayName: "Fresh Spawn",
    },
  );

  assert.deepEqual(
    extractCommandInvocation({
      data: {
        name: "timedrole",
        options: [
          {
            name: "remove",
            type: 1,
            options: [
              { name: "user", value: "user-1" },
              { name: "role", value: "role-1" },
            ],
          },
        ],
        resolved: {
          users: {
            "user-1": { id: "user-1", username: "freshspawn", global_name: "Fresh Spawn" },
          },
          members: {
            "user-1": { nick: "Fresh Spawn" },
          },
        },
      },
    } as any),
    {
      commandName: "timedrole",
      subcommandName: "remove",
      userId: "user-1",
      roleId: "role-1",
      targetDisplayName: "Fresh Spawn",
    },
  );

  assert.deepEqual(
    extractCommandInvocation({
      data: { name: "timedrole", options: [{ name: "list", type: 1 }] },
    } as any),
    {
      commandName: "timedrole",
      subcommandName: "list",
    },
  );
});

test("extractCommandInvocation parses /ticket close", () => {
  assert.deepEqual(
    extractCommandInvocation({
      data: {
        name: "ticket",
        options: [{ name: "close", type: 1 }],
      },
    } as any),
    {
      commandName: "ticket",
      subcommandName: "close",
    },
  );
});

test("extractCommandInvocation parses Ticket participant commands", () => {
  for (const subcommandName of ["add-user", "remove-user"] as const) {
    assert.deepEqual(
      extractCommandInvocation({
        data: {
          name: "ticket",
          options: [
            {
              name: subcommandName,
              type: 1,
              options: [{ name: "user", type: 6, value: "user-2" }],
            },
          ],
        },
      } as any),
      { commandName: "ticket", subcommandName, userId: "user-2" },
    );
  }
});

test("extractCommandInvocation parses /ticket history with an optional member", () => {
  assert.deepEqual(
    extractCommandInvocation({
      data: {
        name: "ticket",
        options: [
          {
            name: "history",
            type: 1,
            options: [{ name: "user", type: 6, value: "user-2" }],
          },
        ],
      },
    } as any),
    {
      commandName: "ticket",
      subcommandName: "history",
      userId: "user-2",
    },
  );

  assert.deepEqual(
    extractCommandInvocation({
      data: { name: "ticket", options: [{ name: "history", type: 1 }] },
    } as any),
    { commandName: "ticket", subcommandName: "history", userId: null },
  );
});

test("extractCommandInvocation parses /ticket reply with a Message Template", () => {
  assert.deepEqual(
    extractCommandInvocation({
      type: 2,
      data: {
        name: "ticket",
        options: [
          { name: "reply", type: 1, options: [{ name: "template", type: 3, value: "template-1" }] },
        ],
      },
    }),
    { commandName: "ticket", subcommandName: "reply", templateId: "template-1" },
  );
});

test("extractCommandInvocation rejects unknown commands and subcommands", () => {
  const bogusSub = {
    data: {
      name: "blocklist",
      options: [
        {
          name: "bogus",
          type: 1,
          options: [{ name: "emoji", value: "💀" }],
        },
      ],
    },
  } as any;

  const unknownCmd = {
    data: {
      name: "unknown",
      options: [],
    },
  } as any;

  assert.equal(extractCommandInvocation(bogusSub), null);
  assert.equal(extractCommandInvocation(unknownCmd), null);
});

test("extractCommandInvocation rejects future commands with timedrole-shaped options", () => {
  ALL_SLASH_COMMAND_DEFINITIONS.push({
    name: "futurecommand",
    description: "Future command",
    options: [
      {
        type: 1,
        name: "add",
        description: "Add",
        options: [
          { type: 6, name: "user", description: "User", required: true },
          { type: 8, name: "role", description: "Role", required: true },
          { type: 3, name: "duration", description: "Duration", required: true },
        ],
      },
    ],
  });

  try {
    assert.equal(
      extractCommandInvocation({
        data: {
          name: "futurecommand",
          options: [
            {
              name: "add",
              type: 1,
              options: [
                { name: "user", value: "user-1" },
                { name: "role", value: "role-1" },
                { name: "duration", value: "1w" },
              ],
            },
          ],
        },
      } as any),
      null,
    );
  } finally {
    ALL_SLASH_COMMAND_DEFINITIONS.pop();
  }
});

test("extractCommandInvocation rejects non-string emoji values", () => {
  const nonStringEmoji = {
    data: {
      name: "blocklist",
      options: [
        {
          name: "add",
          type: 1,
          options: [{ name: "emoji", value: { raw: "💀" } }],
        },
      ],
    },
  } as any;

  assert.equal(extractCommandInvocation(nonStringEmoji), null);
});

test("ALL_SLASH_COMMAND_DEFINITIONS matches expected command tree (steamlink excluded, checked inline)", () => {
  const expected = [
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
    {
      name: "Report Message",
      type: 3,
    },
    {
      name: "rep",
      description: "Thank helpful community members",
      options: [
        {
          type: 1,
          name: "give",
          description: "Thank a helpful teammate",
          options: [
            {
              type: 6,
              name: "user",
              description: "Member to target",
              required: true,
            },
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
          options: [
            {
              type: 6,
              name: "user",
              description: "Member to target",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "leaderboard",
          description: "View reputation leaders",
        },
      ],
    },
    {
      name: "mod",
      description: "Staff moderation tools",
      options: [
        {
          type: 1,
          name: "warn",
          description: "Record a member warning",
          options: [
            {
              type: 6,
              name: "user",
              description: "Member to target",
              required: true,
            },
            {
              type: 3,
              name: "reason",
              description: "Private staff reason",
              required: true,
              max_length: 500,
            },
          ],
        },
        {
          type: 1,
          name: "history",
          description: "View private member moderation history",
          options: [
            {
              type: 6,
              name: "user",
              description: "Member to target",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "timeout",
          description: "Time out a member",
          options: [
            {
              type: 6,
              name: "user",
              description: "Member to target",
              required: true,
            },
            {
              type: 3,
              name: "reason",
              description: "Private staff reason",
              required: true,
              max_length: 500,
            },
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
          options: [
            {
              type: 6,
              name: "user",
              description: "Member to target",
              required: true,
            },
            {
              type: 3,
              name: "reason",
              description: "Private staff reason",
              required: true,
              max_length: 500,
            },
          ],
        },
        {
          type: 1,
          name: "ban",
          description: "Ban a member without deleting message history",
          options: [
            {
              type: 6,
              name: "user",
              description: "Member to target",
              required: true,
            },
            {
              type: 3,
              name: "reason",
              description: "Private staff reason",
              required: true,
              max_length: 500,
            },
          ],
        },
        {
          type: 1,
          name: "unban",
          description: "Unban a Discord account by ID",
          options: [
            {
              type: 3,
              name: "user",
              description: "Discord user ID to unban",
              required: true,
            },
            {
              type: 3,
              name: "reason",
              description: "Private staff reason",
              required: true,
              max_length: 500,
            },
          ],
        },
        {
          type: 1,
          name: "purge",
          description: "Remove matching recent messages in this channel",
          options: [
            {
              type: 3,
              name: "reason",
              description: "Private staff reason",
              required: true,
              max_length: 500,
            },
            {
              type: 4,
              name: "count",
              description: "Number of recent messages to inspect",
              min_value: 1,
              max_value: 100,
            },
            {
              type: 6,
              name: "user",
              description: "Member to target",
              required: false,
            },
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
    {
      name: "help",
      description: "Get HAF Bot commands, setup guides and dashboard links",
    },
    {
      name: "Hide Evidence",
      type: 3,
    },
    {
      name: "blocklist",
      description: "Manage this server's blocked emoji list",
      options: [
        {
          type: 1,
          name: "add",
          description: "Block an emoji in this server",
          options: [{ type: 3, name: "emoji", description: "Emoji to block", required: true }],
        },
        {
          type: 1,
          name: "remove",
          description: "Unblock an emoji in this server",
          options: [{ type: 3, name: "emoji", description: "Emoji to unblock", required: true }],
        },
        {
          type: 1,
          name: "list",
          description: "List the emojis blocked in this server",
        },
      ],
    },
    {
      name: "timedrole",
      description: "Manage timed role assignments in this server",
      options: [
        {
          type: 1,
          name: "add",
          description: "Assign a role to a user for a limited duration",
          options: [
            { type: 6, name: "user", description: "User to assign the role to", required: true },
            { type: 8, name: "role", description: "Role to assign", required: true },
            {
              type: 3,
              name: "duration",
              description: "How long to keep the role (for example 1h, 1w, 1m)",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "remove",
          description: "Remove a timed role assignment from a user",
          options: [
            { type: 6, name: "user", description: "User to remove the role from", required: true },
            { type: 8, name: "role", description: "Role to remove", required: true },
          ],
        },
        {
          type: 1,
          name: "list",
          description: "List timed role assignments in this server",
        },
      ],
    },
    {
      name: "playercount",
      description: "Manage and show player count for game servers",
      options: [
        {
          type: 1,
          name: "add",
          description: "Add a server to track",
          options: [
            {
              type: 3,
              name: "name",
              description: "Display name for this server (e.g. Main PvP)",
              required: true,
            },
            {
              type: 3,
              name: "steam_host",
              description: "Steam query IP or hostname",
              required: true,
            },
            {
              type: 4,
              name: "steam_port",
              description: "Steam query port (default 27015)",
              required: false,
              min_value: 1,
              max_value: 65535,
            },
            {
              type: 7,
              name: "channel",
              description: "Voice channel to rename with player count",
              required: false,
              channel_types: [2],
            },
            {
              type: 7,
              name: "alert_channel",
              description: "Text channel to receive offline alerts",
              required: false,
              channel_types: [0],
            },
            {
              type: 4,
              name: "refresh_interval_minutes",
              description: "How often to refresh this server (5-60, default 10)",
              required: false,
              min_value: 5,
              max_value: 60,
            },
            {
              type: 4,
              name: "failure_threshold",
              description: "Consecutive failed checks before alerting (1-20, default 3)",
              required: false,
              min_value: 1,
              max_value: 20,
            },
          ],
        },
        {
          type: 1,
          name: "remove",
          description: "Remove a tracked server",
          options: [
            { type: 3, name: "name", description: "Name of the server to remove", required: true },
          ],
        },
        {
          type: 1,
          name: "list",
          description: "List tracked servers",
        },
        {
          type: 1,
          name: "show",
          description: "Show current player counts",
        },
      ],
    },
    {
      name: "serverlevel",
      description: "View Server Levels earned from trusted game-server attendance",
      options: [
        {
          type: 1,
          name: "profile",
          description: "Show your Server Level or another current member's aggregate profile",
          options: [
            {
              type: 6,
              name: "user",
              description: "Current server member to view",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "leaderboard",
          description: "Show the top Server Levels for current members",
        },
      ],
    },
    {
      name: "ticket",
      description: "Manage the current ticket channel",
      options: [
        {
          type: 1,
          name: "close",
          description: "Close this ticket",
        },
        {
          type: 1,
          name: "request-close",
          description: "Request that the opener confirm ticket close",
        },
        {
          type: 1,
          name: "claim",
          description: "Claim this ticket",
        },
        {
          type: 1,
          name: "add-user",
          description: "Add a member to this ticket",
          options: [{ type: 6, name: "user", description: "Member to add", required: true }],
        },
        {
          type: 1,
          name: "remove-user",
          description: "Remove an added member from this ticket",
          options: [{ type: 6, name: "user", description: "Member to remove", required: true }],
        },
        {
          type: 1,
          name: "history",
          description: "View a member's ticket history",
          options: [
            {
              type: 6,
              name: "user",
              description: "Member to look up (defaults to this ticket's opener)",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "reply",
          description: "Preview and send a saved Message Template",
          options: [
            {
              type: 3,
              name: "template",
              description: "Message Template to send",
              required: true,
              autocomplete: true,
            },
          ],
        },
      ],
    },
    {
      name: "clan",
      description: "Request or manage a persistent Clan",
      options: [
        {
          type: 1,
          name: "request",
          description: "Submit a Clan Request",
          options: [
            { type: 3, name: "name", description: "Clan name", required: true, max_length: 100 },
            { type: 3, name: "tag", description: "Short Clan tag", required: true, max_length: 12 },
            {
              type: 3,
              name: "description",
              description: "Clan description",
              required: true,
              max_length: 1000,
            },
            {
              type: 3,
              name: "focus",
              description: "Game or platform focus",
              required: true,
              max_length: 200,
            },
            {
              type: 3,
              name: "recruitment",
              description: "Initial recruitment state",
              required: true,
              choices: [
                { name: "Applications open", value: "applications-open" },
                { name: "Invite only", value: "invite-only" },
                { name: "Closed", value: "closed" },
              ],
            },
          ],
        },
        { type: 1, name: "manage", description: "Open your Clan management controls" },
      ],
    },
    {
      name: "haf-admin",
      description: "Manage HAF from the private admin server",
      options: [
        {
          type: 1,
          name: "suspend-guild",
          description: "Stop all HAF service for a guild",
          options: [
            {
              type: 3,
              name: "guild_id",
              description: "Discord guild ID to suspend",
              required: true,
            },
            {
              type: 3,
              name: "reason",
              description: "Private internal reason for the suspension",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "leave-guild",
          description: "Suspend HAF and remove the bot from a guild",
          options: [
            {
              type: 3,
              name: "guild_id",
              description: "Discord guild ID to suspend and leave",
              required: true,
            },
            {
              type: 3,
              name: "reason",
              description: "Private internal reason for the suspension",
              required: true,
              max_length: 500,
            },
            {
              type: 3,
              name: "confirm_guild_id",
              description: "Repeat the Discord guild ID to confirm removal",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "restore-guild",
          description: "Restore HAF service for a suspended guild",
          options: [
            {
              type: 3,
              name: "guild_id",
              description: "Discord guild ID to restore",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "list-suspensions",
          description: "List guilds whose HAF service is suspended",
        },
        {
          type: 1,
          name: "gateway-status",
          description: "Show the HAF Discord gateway status",
        },
        {
          type: 1,
          name: "start-gateway",
          description: "Start the gateway and synchronize commands",
        },
        {
          type: 1,
          name: "show-plan",
          description: "Show a guild's effective plan",
          options: [
            {
              type: 3,
              name: "guild_id",
              description: "Discord guild ID to inspect",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "repair-verification-panel",
          description: "Publish or repair a guild's Member Verification panel",
          options: [
            {
              type: 3,
              name: "guild_id",
              description: "Discord guild ID whose panel should be repaired",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "adjust-server-xp",
          description: "Append a reasoned Server XP support adjustment",
          options: [
            {
              type: 3,
              name: "guild_id",
              description: "Target Discord Guild ID",
              required: true,
            },
            {
              type: 3,
              name: "user_id",
              description: "Target Discord user ID",
              required: true,
            },
            {
              type: 4,
              name: "amount_xp",
              description: "Whole Server XP amount; negative values correct XP",
              required: true,
            },
            {
              type: 3,
              name: "reason",
              description: "Required private support reason",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "erase-server-level-data",
          description: "Complete a verified Server Levels personal-data erasure request",
          options: [
            {
              type: 3,
              name: "guild_id",
              description: "Target Discord Guild ID",
              required: true,
            },
            {
              type: 3,
              name: "user_id",
              description: "Target Discord user ID",
              required: true,
            },
            {
              type: 3,
              name: "reason",
              description: "Required private erasure verification note",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "erase-reputation-data",
          description: "Complete a verified Reputation personal-data erasure request",
          options: [
            { type: 3, name: "guild_id", description: "Target Discord Guild ID", required: true },
            { type: 3, name: "user_id", description: "Target Discord user ID", required: true },
            {
              type: 3,
              name: "reason",
              description: "Required private erasure verification note",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "identity-patterns",
          description: "List, add, or disable Evidence Vault identity patterns",
          options: [
            { type: 3, name: "action", description: "list, add, or disable", required: true },
            {
              type: 3,
              name: "platform",
              description: "discord, steam, xbox, playstation, or cftools",
              required: false,
            },
            {
              type: 3,
              name: "pattern",
              description: "Regex source or pattern ID",
              required: false,
            },
            {
              type: 4,
              name: "capture_group",
              description: "1-indexed regex capture group",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "list-guilds",
          description: "List bot guilds and their effective plans",
        },
      ],
    },
    {
      name: "evidence-vault",
      description: "Search and amend Evidence Vault subjects",
      options: [
        {
          type: 1,
          name: "search",
          description: "Search evidence by subject identifier or Evidence Fields",
          options: [
            {
              type: 3,
              name: "user",
              description: "Discord, Steam, Xbox, PlayStation, or cftools identifier",
              required: false,
            },
            {
              type: 3,
              name: "source_text",
              description: "Text contained in the hidden message",
              required: false,
            },
            {
              type: 3,
              name: "field_1",
              description: "Value for configured Evidence Field 1",
              required: false,
            },
            {
              type: 3,
              name: "field_2",
              description: "Value for configured Evidence Field 2",
              required: false,
            },
            {
              type: 3,
              name: "field_3",
              description: "Value for configured Evidence Field 3",
              required: false,
            },
            {
              type: 3,
              name: "field_4",
              description: "Value for configured Evidence Field 4",
              required: false,
            },
            {
              type: 3,
              name: "field_5",
              description: "Value for configured Evidence Field 5",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "amend",
          description: "Add or remove a subject on an evidence record",
          options: [
            { type: 3, name: "record_id", description: "Evidence Vault record ID", required: true },
            {
              type: 3,
              name: "action",
              description: "Subject change to apply",
              required: true,
              choices: [
                { name: "Add", value: "add" },
                { name: "Remove", value: "remove" },
              ],
            },
            { type: 3, name: "identifier", description: "Subject identifier", required: true },
          ],
        },
      ],
    },
  ];

  assert.ok(
    ALL_SLASH_COMMAND_DEFINITIONS.some((command) => command.name === "steamlink"),
    "Steam link command should be registered",
  );
  assert.ok(
    ALL_SLASH_COMMAND_DEFINITIONS.some((command) => command.name === "xboxlink"),
    "Xbox link command should be registered",
  );
  assert.ok(
    ALL_SLASH_COMMAND_DEFINITIONS.some((command) => command.name === "playstationlink"),
    "PlayStation link command should be registered",
  );
  assert.deepEqual(
    ALL_SLASH_COMMAND_DEFINITIONS.filter(
      (command) =>
        command.name !== "steamlink" &&
        command.name !== "xboxlink" &&
        command.name !== "playstationlink" &&
        command.name !== "event",
    ).sort((a, b) => a.name.localeCompare(b.name)),
    [...expected].sort((a, b) => a.name.localeCompare(b.name)),
  );
});

test("ALL_SLASH_COMMAND_DEFINITIONS includes the blocklist list subcommand", () => {
  const blocklistCommand = ALL_SLASH_COMMAND_DEFINITIONS.find(
    (command) => command.name === "blocklist",
  );
  assert.deepEqual(
    blocklistCommand?.options?.map((option) => option.name),
    ["add", "remove", "list"],
  );
});

test("extractCommandInvocation returns a list invocation without an emoji", () => {
  const interaction = {
    data: {
      name: "blocklist",
      options: [
        {
          name: "list",
          type: 1,
        },
      ],
    },
  };

  assert.deepEqual(extractCommandInvocation(interaction), {
    commandName: "blocklist",
    subcommandName: "list",
  });
});

test("extractCommandInvocation returns haf-admin list-guilds requests", () => {
  const interaction = {
    data: {
      name: "haf-admin",
      options: [
        {
          name: "list-guilds",
          type: 1,
        },
      ],
    },
  };

  assert.deepEqual(extractCommandInvocation(interaction), {
    commandName: "haf-admin",
    subcommandName: "list-guilds",
  });
});

test("extractCommandInvocation returns haf-admin show-plan requests", () => {
  const interaction = {
    data: {
      name: "haf-admin",
      options: [
        {
          name: "show-plan",
          type: 1,
          options: [{ name: "guild_id", value: "guild-1" }],
        },
      ],
    },
  };

  assert.deepEqual(extractCommandInvocation(interaction), {
    commandName: "haf-admin",
    subcommandName: "show-plan",
    guildId: "guild-1",
  });
});

test("extractCommandInvocation returns haf-admin panel repair requests", () => {
  const interaction = {
    data: {
      name: "haf-admin",
      options: [
        {
          name: "repair-verification-panel",
          type: 1,
          options: [{ name: "guild_id", value: "guild-1" }],
        },
      ],
    },
  };

  assert.deepEqual(extractCommandInvocation(interaction), {
    commandName: "haf-admin",
    subcommandName: "repair-verification-panel",
    guildId: "guild-1",
  });
});

test("extractCommandInvocation returns confirmed haf-admin guild removal requests", () => {
  const interaction = {
    data: {
      name: "haf-admin",
      options: [
        {
          name: "leave-guild",
          type: 1,
          options: [
            { name: "guild_id", value: "guild-1" },
            { name: "reason", value: "  Internal evidence  " },
            { name: "confirm_guild_id", value: "guild-1" },
          ],
        },
      ],
    },
  };

  assert.deepEqual(extractCommandInvocation(interaction), {
    commandName: "haf-admin",
    subcommandName: "leave-guild",
    guildId: "guild-1",
    reason: "Internal evidence",
    confirmedGuildId: "guild-1",
  });
});

test("ALL_SLASH_COMMAND_DEFINITIONS no longer includes removed LFG command", () => {
  assert.equal(
    ALL_SLASH_COMMAND_DEFINITIONS.some((command) => command.name === "lfg"),
    false,
    "LFG slash command group should be removed",
  );
});

test("ALL_SLASH_COMMAND_DEFINITIONS no longer includes removed marketplace command", () => {
  assert.equal(
    ALL_SLASH_COMMAND_DEFINITIONS.some((command) => command.name === "marketplace"),
    false,
    "Marketplace slash command group should be removed",
  );
});

test("ALL_SLASH_COMMAND_DEFINITIONS no longer includes steamlink setup, panel, or syncroles subcommands", () => {
  const steamlinkCommand = ALL_SLASH_COMMAND_DEFINITIONS.find(
    (command) => command.name === "steamlink",
  );
  assert.ok(steamlinkCommand, "Steam link command should still be registered");
  const subNames = steamlinkCommand?.options?.map((option) => option.name) ?? [];
  assert.equal(subNames.includes("setup"), false, "steamlink setup should be removed");
  assert.equal(subNames.includes("panel"), false, "steamlink panel should be removed");
  assert.equal(subNames.includes("syncroles"), false, "steamlink syncroles should be removed");
  assert.ok(subNames.includes("whois"), "steamlink whois should remain");
  assert.ok(subNames.includes("manual-link"), "steamlink manual-link should remain");
  assert.ok(subNames.includes("unlink"), "steamlink unlink should remain");
  assert.ok(subNames.includes("linkedcount"), "steamlink linkedcount should remain");
  assert.ok(subNames.includes("request"), "steamlink request should be registered");
});

test("extractCommandInvocation parses platform link request subcommands", () => {
  assert.deepEqual(
    extractCommandInvocation({
      data: { name: "steamlink", options: [{ name: "request", type: 1 }] },
    } as any),
    { commandName: "steamlink", subcommandName: "request" },
  );
  assert.deepEqual(
    extractCommandInvocation({
      data: { name: "xboxlink", options: [{ name: "request", type: 1 }] },
    } as any),
    { commandName: "xboxlink", subcommandName: "request" },
  );
  assert.deepEqual(
    extractCommandInvocation({
      data: { name: "playstationlink", options: [{ name: "request", type: 1 }] },
    } as any),
    { commandName: "playstationlink", subcommandName: "request" },
  );
});

test("ALL_SLASH_COMMAND_DEFINITIONS includes the haf-admin list-guilds subcommand", () => {
  const hafAdminCommand = ALL_SLASH_COMMAND_DEFINITIONS.find(
    (command) => command.name === "haf-admin",
  );
  assert.deepEqual(
    hafAdminCommand?.options?.map((option) => option.name),
    [
      "suspend-guild",
      "leave-guild",
      "restore-guild",
      "list-suspensions",
      "gateway-status",
      "start-gateway",
      "show-plan",
      "repair-verification-panel",
      "adjust-server-xp",
      "erase-server-level-data",
      "erase-reputation-data",
      "identity-patterns",
      "list-guilds",
    ],
  );
});

test("buildEphemeralMessage returns the Discord ephemeral response shape", () => {
  const msg = buildEphemeralMessage("Hello");
  assert.deepEqual(msg, { type: 4, data: { content: "Hello", flags: 64 } });
});

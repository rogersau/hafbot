import type { FeatureFlags } from "./runtime/features";
import { COMMUNITY_COMMAND_DEFINITIONS } from "./community-tools/commands";

export interface DiscordCommandOption {
  type: number;
  name: string;
  description?: string;
  required?: boolean;
  options?: DiscordCommandOption[];
  choices?: Array<{ name: string; value: string | number }>;
  autocomplete?: boolean;
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
  channel_types?: number[];
}
export interface DiscordCommandDefinition {
  name: string;
  type?: number;
  description?: string;
  options?: DiscordCommandOption[];
  default_member_permissions?: string;
  dm_permission?: boolean;
}
const _ALL_SLASH_COMMAND_DEFINITIONS: DiscordCommandDefinition[] = [
  ...COMMUNITY_COMMAND_DEFINITIONS,
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
    name: "event",
    description: "Manage Event participation and Event Teams",
    options: [
      ...[
        "manage",
        "list-teams",
        "view-team",
        "leave",
        "leave-team",
        "create-team",
        "rename-team",
        "join-team",
        "withdraw-request",
        "accept",
        "decline",
        "open-requests",
        "close-requests",
        "reject-request",
        "disband",
      ].map((name) => ({
        type: 1,
        name,
        description: `Event ${name.replaceAll("-", " ")}`,
        options: [
          { type: 3, name: "event_id", description: "Event ID", required: true },
          ...(name === "create-team"
            ? [
                { type: 3, name: "group_id", description: "Signup Group ID", required: true },
                {
                  type: 3,
                  name: "name",
                  description: "Event Team name",
                  required: true,
                  min_length: 2,
                  max_length: 40,
                },
              ]
            : []),
          ...(name === "rename-team"
            ? [
                {
                  type: 3,
                  name: "name",
                  description: "New Event Team name",
                  required: true,
                  min_length: 2,
                  max_length: 40,
                },
              ]
            : []),
          ...(name === "join-team" ||
          name === "view-team" ||
          name === "rename-team" ||
          name === "open-requests" ||
          name === "close-requests" ||
          name === "disband"
            ? [{ type: 3, name: "team_id", description: "Event Team ID", required: true }]
            : []),
          ...(name === "withdraw-request" ||
          name === "accept" ||
          name === "decline" ||
          name === "reject-request"
            ? [{ type: 3, name: "proposal_id", description: "Proposal ID", required: true }]
            : []),
        ],
      })),
      {
        type: 1,
        name: "invite",
        description: "Invite a participant to an Event Team",
        options: [
          { type: 3, name: "event_id", description: "Event ID", required: true },
          { type: 3, name: "team_id", description: "Event Team ID", required: true },
          { type: 6, name: "user", description: "Participant", required: true },
        ],
      },
      {
        type: 1,
        name: "remove-member",
        description: "Remove a participant from your Event Team",
        options: [
          { type: 3, name: "event_id", description: "Event ID", required: true },
          { type: 3, name: "team_id", description: "Event Team ID", required: true },
          { type: 6, name: "user", description: "Participant", required: true },
        ],
      },
      {
        type: 1,
        name: "transfer-captain",
        description: "Transfer Event Team captaincy",
        options: [
          { type: 3, name: "event_id", description: "Event ID", required: true },
          { type: 3, name: "team_id", description: "Event Team ID", required: true },
          { type: 6, name: "user", description: "New captain", required: true },
        ],
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
          {
            type: 3,
            name: "name",
            description: "Name of the server to remove",
            required: true,
          },
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
    name: "steamlink",
    description: "Manage Steam account linking for this server",
    options: [
      {
        type: 1,
        name: "whois",
        description: "Admin lookup for linked Steam/Discord accounts",
        options: [
          {
            type: 6,
            name: "user",
            description: "Discord user to look up",
            required: false,
          },
          {
            type: 3,
            name: "steamid",
            description: "SteamID64 to look up",
            required: false,
          },
        ],
      },
      {
        type: 1,
        name: "manual-link",
        description: "Admin manually link a Discord user to a SteamID64",
        options: [
          {
            type: 6,
            name: "user",
            description: "Discord user to link",
            required: true,
          },
          {
            type: 3,
            name: "steamid",
            description: "SteamID64 to assign",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "unlink",
        description: "Admin force unlink a user's Steam account (or unlink yourself)",
        options: [
          {
            type: 6,
            name: "user",
            description: "Discord user to unlink (omit to unlink yourself)",
            required: false,
          },
          {
            type: 3,
            name: "steamid",
            description: "SteamID64 to unlink (required when user has multiple links)",
            required: false,
          },
        ],
      },
      {
        type: 1,
        name: "linkedcount",
        description: "Show how many users have linked Steam",
      },
      {
        type: 1,
        name: "request",
        description: "Post a Steam link button in this channel",
      },
    ],
  },
  {
    name: "xboxlink",
    description: "Manage Xbox account linking for this server",
    options: [
      {
        type: 1,
        name: "whois",
        description: "Admin lookup for linked Xbox/Discord accounts",
        options: [
          {
            type: 6,
            name: "user",
            description: "Discord user to look up",
            required: false,
          },
          {
            type: 3,
            name: "xuid",
            description: "Xbox XUID to look up",
            required: false,
          },
        ],
      },
      {
        type: 1,
        name: "manual-link",
        description: "Admin manually link a Discord user to an Xbox XUID",
        options: [
          {
            type: 6,
            name: "user",
            description: "Discord user to link",
            required: true,
          },
          {
            type: 3,
            name: "xuid",
            description: "Xbox XUID to assign",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "unlink",
        description: "Admin force unlink a user's Xbox account (or unlink yourself)",
        options: [
          {
            type: 6,
            name: "user",
            description: "Discord user to unlink (omit to unlink yourself)",
            required: false,
          },
          {
            type: 3,
            name: "xuid",
            description: "Xbox XUID to unlink (required when user has multiple links)",
            required: false,
          },
        ],
      },
      {
        type: 1,
        name: "linkedcount",
        description: "Show how many users have linked Xbox",
      },
      {
        type: 1,
        name: "request",
        description: "Post an Xbox link button in this channel",
      },
    ],
  },
  {
    name: "playstationlink",
    description: "Manage PlayStation platform links for this server",
    options: [
      {
        type: 1,
        name: "setup",
        description: "Configure PlayStation platform linking",
        options: [
          {
            type: 8,
            name: "psn_linked_role",
            description: "Role assigned to linked members",
            required: false,
          },
          {
            type: 7,
            name: "log_channel",
            description: "Channel for PlayStation link audit logs",
            required: false,
          },
          { type: 3, name: "panel_title", description: "Panel embed title", required: false },
          {
            type: 3,
            name: "panel_description",
            description: "Panel embed description",
            required: false,
          },
          {
            type: 3,
            name: "panel_button_label",
            description: "Panel button label",
            required: false,
          },
          {
            type: 3,
            name: "panel_button_style",
            description: "Panel button style",
            required: false,
            choices: [
              { name: "Primary", value: "Primary" },
              { name: "Secondary", value: "Secondary" },
              { name: "Success", value: "Success" },
              { name: "Danger", value: "Danger" },
            ],
          },
          {
            type: 5,
            name: "allow_relink",
            description: "Allow members to replace their link",
            required: false,
          },
          {
            type: 5,
            name: "allow_multiple_links",
            description: "Allow multiple PlayStation links per member",
            required: false,
          },
        ],
      },
      { type: 1, name: "panel", description: "Post the PlayStation link panel in this channel" },
      {
        type: 1,
        name: "request",
        description: "Post a PlayStation link button in this channel",
      },
      {
        type: 1,
        name: "whois",
        description: "Admin lookup for linked PlayStation/Discord accounts",
        options: [
          { type: 6, name: "user", description: "Discord user to look up", required: false },
          { type: 3, name: "psn_id", description: "PSN Online ID to look up", required: false },
        ],
      },
      {
        type: 1,
        name: "manual-link",
        description: "Admin manually link a Discord user to a PSN Online ID",
        options: [
          { type: 6, name: "user", description: "Discord user to link", required: true },
          { type: 3, name: "psn_id", description: "PSN Online ID to assign", required: true },
        ],
      },
      {
        type: 1,
        name: "unlink",
        description: "Admin force unlink a user's PlayStation account (or unlink yourself)",
        options: [
          {
            type: 6,
            name: "user",
            description: "Discord user to unlink (omit to unlink yourself)",
            required: false,
          },
          {
            type: 3,
            name: "psn_id",
            description: "PSN Online ID to unlink (required when user has multiple links)",
            required: false,
          },
        ],
      },
      { type: 1, name: "linkedcount", description: "Show how many users have linked PlayStation" },
      {
        type: 1,
        name: "syncroles",
        description: "Assign the linked role to all linked PlayStation users",
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
          { type: 3, name: "guild_id", description: "Target Discord Guild ID", required: true },
          { type: 3, name: "user_id", description: "Target Discord user ID", required: true },
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
          { type: 3, name: "pattern", description: "Regex source or pattern ID", required: false },
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
];

export const ALL_SLASH_COMMAND_DEFINITIONS = _ALL_SLASH_COMMAND_DEFINITIONS;

export function getSlashCommandDefinitions(features: FeatureFlags) {
  return ALL_SLASH_COMMAND_DEFINITIONS.filter((command) => {
    switch (command.name) {
      case "blocklist":
        return features.blocklist;
      case "timedrole":
        return features.timedRoles;
      case "ticket":
        return features.tickets;
      case "clan":
        return features.clans !== false;
      case "event":
        return features.events;
      case "playercount":
        return features.playerCount;
      case "steamlink":
        return features.steamLink;
      case "xboxlink":
        return features.xboxLink;
      case "playstationlink":
        return features.playstationLink;
      case "evidence-vault":
        return features.evidenceVault;
      case "Hide Evidence":
        return features.evidenceVault;
      case "serverlevel":
        return features.serverLevels !== false;
      default:
        return true;
    }
  });
}

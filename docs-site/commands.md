---
description: "HAF Bot's Discord command reference for members and staff, including player links, tickets, LFG, evidence, timed roles and server-level profiles."
---

# Discord Commands

This page lists the commands available to members and Guild staff. Discord only shows commands that are registered for the current HAF Bot installation.

## Help

Use `/help` inside your Discord server to get a private response with the command reference,
documentation, first Ticket setup guide and dashboard links. Every member can use it; configuring
the server in the dashboard still requires the appropriate admin access.

## Custom Replies

Use `/custom name:<command-name>` to run a server's configured reply. Replies can also respond to configured message triggers. Channel restrictions, required roles and member cooldowns apply. See [Custom Replies and Schedules](/features/automation).

## Chat Moderation

These commands require configured staff access. Account actions also require the actor's corresponding Discord permissions and a lower target role. All command responses are private.

| Command        | Result                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/mod warn`    | Records a warning with a private staff reason                                                                    |
| `/mod history` | Shows a member's recent moderation history                                                                       |
| `/mod timeout` | Applies a timeout without shortening an existing longer timeout                                                  |
| `/mod kick`    | Removes a member                                                                                                 |
| `/mod ban`     | Bans a member without deleting message history                                                                   |
| `/mod unban`   | Unbans a Discord account by ID                                                                                   |
| `/mod purge`   | Inspects up to 100 recent channel messages and removes matching messages; optional member and text filters apply |

Members can use **Report Message** in a message's Apps menu to send its link privately to the configured staff channel. See [Chat Moderation](/features/chat-moderation).

## Reputation

| Command            | Result                                                        |
| ------------------ | ------------------------------------------------------------- |
| `/rep give`        | Thanks another current member and awards one reputation point |
| `/rep profile`     | Shows the selected current member's reputation                |
| `/rep leaderboard` | Shows reputation leaders who are still members                |

Reputation must be enabled by the server admin. Self awards, bot awards, role eligibility and the configured member cooldown are enforced. See [Reputation](/features/reputation).

## Reaction Rules

These commands require server-management access.

| Command             | Parameters | Result                                          |
| ------------------- | ---------- | ----------------------------------------------- |
| `/blocklist add`    | `emoji`    | Adds a Unicode or server emoji to the Blocklist |
| `/blocklist remove` | `emoji`    | Removes an emoji from the Blocklist             |
| `/blocklist list`   | None       | Shows the server's blocked emojis               |

Example: `/blocklist add emoji:🤡`

## Timed Roles

These commands require server-management access. HAF Bot's highest Discord role must be above the role being assigned or removed.

| Command             | Parameters                 | Result                                             |
| ------------------- | -------------------------- | -------------------------------------------------- |
| `/timedrole add`    | `user`, `role`, `duration` | Gives the member a role until the duration expires |
| `/timedrole remove` | `user`, `role`             | Removes the role and its timed assignment          |
| `/timedrole list`   | None                       | Lists active timed assignments                     |

Duration values accept one positive whole number followed by:

- `h` — hours, such as `24h`;
- `w` — weeks, such as `2w`; or
- `m` — calendar months, such as `1m`.

Minutes, days, seconds, decimals, and combined values are not accepted.

Example: `/timedrole add user:@Player role:@Muted duration:24h`

## Tickets

Ticket commands must be used inside an active Ticket channel.

| Command                 | Audience        | Parameters      | Result                                                                             |
| ----------------------- | --------------- | --------------- | ---------------------------------------------------------------------------------- |
| `/ticket close`         | Member or staff | None            | Closes the current Ticket                                                          |
| `/ticket request-close` | Member or staff | None            | Asks the opener to confirm closure                                                 |
| `/ticket claim`         | Staff           | None            | Assigns the Ticket to the staff member                                             |
| `/ticket history`       | Staff           | Optional `user` | Shows previous Tickets for the selected member, or the current opener when omitted |
| `/ticket reply`         | Staff           | `template`      | Previews and sends a saved Message Template                                        |
| `/ticket add-user`      | Staff           | `user`          | Grants a Guild member access to the current Ticket                                 |
| `/ticket remove-user`   | Staff           | `user`          | Revokes access previously granted to an added participant                          |

## Clan Management

| Command         | Audience         | Parameters                                           | Result                                   |
| --------------- | ---------------- | ---------------------------------------------------- | ---------------------------------------- |
| `/clan request` | Eligible members | `name`, `tag`, `description`, `focus`, `recruitment` | Submits a Clan proposal for staff review |
| `/clan manage`  | Clan members     | None                                                 | Opens the member's Clan controls         |

Recruitment can be **Applications open**, **Invite only**, or **Closed**.

## Events and Event Teams

Events require a paid plan. Participant and captain actions are private; Event Team IDs and proposal IDs are shown by `/event manage` and `/event list-teams`.

| Command                   | Result                                                  |
| ------------------------- | ------------------------------------------------------- |
| `/event manage`           | Opens the current private Event management view         |
| `/event list-teams`       | Lists Event Teams, openings, and readiness              |
| `/event view-team`        | Shows one accepted Event Team roster                    |
| `/event leave`            | Withdraws from the Event                                |
| `/event leave-team`       | Leaves the Event Team but keeps the Event Signup        |
| `/event create-team`      | Creates an Event Team in the selected Signup Group      |
| `/event rename-team`      | Renames the captain's Event Team                        |
| `/event join-team`        | Requests to join an Event Team                          |
| `/event withdraw-request` | Withdraws a pending join request                        |
| `/event accept`           | Accepts an invitation or captain-approved join request  |
| `/event decline`          | Declines and blocks repeat invitations from that team   |
| `/event open-requests`    | Opens captain-managed recruitment                       |
| `/event close-requests`   | Closes captain-managed recruitment                      |
| `/event reject-request`   | Rejects a pending join request                          |
| `/event invite`           | Invites a participant to an Event Team                  |
| `/event remove-member`    | Removes a member while preserving their Event Signup    |
| `/event transfer-captain` | Transfers captainship to an accepted Event Team member  |
| `/event disband`          | Disbands the Event Team and returns members to the pool |

## Player Count

These commands require server-management access. Player Count requires a paid plan.

| Command               | Parameters                                                                                                               | Result                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `/playercount add`    | `name`, `steam_host`; optional `steam_port`, `channel`, `alert_channel`, `refresh_interval_minutes`, `failure_threshold` | Adds a Steam-query server      |
| `/playercount remove` | `name`                                                                                                                   | Removes a tracked server       |
| `/playercount list`   | None                                                                                                                     | Lists configured servers       |
| `/playercount show`   | None                                                                                                                     | Shows the latest player counts |

The query port must be between `1` and `65535`. Refresh intervals can be `5` to `60` minutes. The failure threshold can be `1` to `20` consecutive failed checks.

## Server Levels

Server Levels is a paid beta. Commands publish aggregate progression only; attendance history remains private.

| Command                    | Parameters      | Result                                          |
| -------------------------- | --------------- | ----------------------------------------------- |
| `/serverlevel profile`     | Optional `user` | Shows Server XP, level, and next-level progress |
| `/serverlevel leaderboard` | None            | Shows the current-member Server XP leaders      |

Only members who are currently in the Discord server appear. A targeted profile also requires the target to be a current member.

## Player Link

Member-facing `request` commands post a link button in the current channel. Lookup, manual-link, count, setup, panel, and role-sync commands are staff tools.

### Steam

| Command                  | Parameters                                                             |
| ------------------------ | ---------------------------------------------------------------------- |
| `/steamlink request`     | None                                                                   |
| `/steamlink whois`       | Optional `user` or `steamid`                                           |
| `/steamlink manual-link` | `user`, `steamid`                                                      |
| `/steamlink unlink`      | Optional `user`; optional `steamid` when the member has multiple links |
| `/steamlink linkedcount` | None                                                                   |

Steam IDs must be 17-digit SteamID64 values.

### Xbox

| Command                 | Parameters                                                          |
| ----------------------- | ------------------------------------------------------------------- |
| `/xboxlink request`     | None                                                                |
| `/xboxlink whois`       | Optional `user` or `xuid`                                           |
| `/xboxlink manual-link` | `user`, `xuid`                                                      |
| `/xboxlink unlink`      | Optional `user`; optional `xuid` when the member has multiple links |
| `/xboxlink linkedcount` | None                                                                |

### PlayStation

| Command                        | Parameters                                                               |
| ------------------------------ | ------------------------------------------------------------------------ |
| `/playstationlink request`     | None                                                                     |
| `/playstationlink panel`       | None                                                                     |
| `/playstationlink setup`       | Optional linked role, log channel, panel text/style, and relink settings |
| `/playstationlink whois`       | Optional `user` or `psn_id`                                              |
| `/playstationlink manual-link` | `user`, `psn_id`                                                         |
| `/playstationlink unlink`      | Optional `user`; optional `psn_id` when the member has multiple links    |
| `/playstationlink linkedcount` | None                                                                     |
| `/playstationlink syncroles`   | None                                                                     |

PlayStation links use a self-reported PSN Online ID unless a staff member creates the link manually.

## Evidence Vault

These actions require Guild Administrator, **Manage Guild**, or a configured Evidence Vault access role.

| Command or action        | Parameters                                                        | Result                                                                          |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Apps → Hide Evidence** | Select a Discord message                                          | Stores the message, deletes the original when possible, and posts a placeholder |
| `/evidence-vault search` | At least one of `user`, `source_text`, or configured field values | Searches records in the current Guild                                           |
| `/evidence-vault amend`  | `record_id`, `action`, `identifier`                               | Adds or removes a subject identifier                                            |

## Common Problems

- **Command is missing:** Confirm the feature is enabled and the bot commands have been synced for the server.
- **Missing access:** Use the required staff role or Discord permission.
- **Role cannot be assigned:** Move HAF Bot above the target role and grant **Manage Roles**.
- **Invalid Timed Role duration:** Use a single hours, weeks, or months value such as `12h`, `2w`, or `1m`.
- **Ticket command fails:** Run it inside an active HAF Ticket channel.
- **Lookup returns nothing:** Check the identifier format and confirm the member is linked in the current Discord server.

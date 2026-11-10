---
description: "Recognise helpful Discord members with HAF Bot Reputation: member-awarded thanks, cooldowns, leaderboards and safe milestone role rewards."
---

# Reputation

Reputation recognises helpful members through explicit thanks. It is separate from Server Levels, which awards XP from verified game-server attendance.

Reputation starts disabled. Open **Admin Dashboard → Reputation**, enable it and save the settings.

## Member commands

| Command                 | Result                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `/rep give user reason` | Gives another current member one reputation point. The reason is optional and limited to 300 characters. |
| `/rep profile user`     | Shows a current member's total; omit the member to show your own.                                        |
| `/rep leaderboard`      | Shows current-member leaders.                                                                            |

Thanks confirmations are private. Profiles and leaderboards display names and aggregate reputation, without raw Discord IDs or award reasons. Bots cannot give or receive reputation, and members cannot thank themselves.

## Eligibility and cooldowns

The giver cooldown applies across all recipients. It defaults to one day and can be configured from one minute to seven days. A failed eligibility check does not consume the cooldown. Repeated delivery of the same Discord interaction never adds a second point.

Leave **Roles allowed to give reputation** empty to allow every eligible member, or select the roles permitted to give thanks. Members holding any **Excluded role** cannot give or receive reputation. Both the giver and recipient must currently belong to the Discord server.

## Role rewards

Add up to 20 dedicated role rewards with a minimum reputation threshold. The role must already exist, be below HAF Bot's highest role, and have no staff or management permissions. Roles owned by verification, paid access, timed restrictions, linked identities and other protected HAF workflows cannot be used.

Chat Moderation moderator roles are protected even when they have no Discord permission bits. Previously configured panels and rewards are checked against the current moderator roles before granting access.

HAF checks role safety again when delivering a reward. Active Timed Role suspensions are respected. Failed or temporarily unsafe grants remain pending and are retried; reputation is retained when a Discord role operation fails.

Rewards add roles. Changing settings, disabling Reputation or removing a reward does not remove a member's existing role. Newly configured eligible milestones can reward existing reputation, without awarding extra points.

## Membership and privacy

Members who leave are hidden from leaderboards. Discord membership is checked before displaying leaders; an unusually large backlog of departed accounts can produce a shorter result while the bounded lookup marks those accounts inactive.

Disabling Reputation preserves settings, points and pending rewards, but stops new thanks and role processing. The personal-erasure operation removes a member's score, cooldown and pending rewards and clears their identity and reasons from award records. Anonymous interaction receipts remain to prevent replay of completed awards. Existing Discord reward roles and points already given to other members are retained.

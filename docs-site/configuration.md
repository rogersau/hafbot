---
description: "Configure HAF Bot's Discord channels, roles and feature settings. Understand permissions, saved configuration and testing before enabling a workflow."
---

# Configuration

Most setup happens in the [Admin Dashboard](/admin-dashboard). Feature pages use the same basic pattern: choose Discord resources, configure the feature, save, then publish any member-facing panel.

## Choose the Correct Server

After signing in, choose the Discord server you want to configure.

Dashboard access follows your Discord server permissions. Server owners, Discord Administrators, and members with the nominated **HAF admin role** can view and change settings. **Manage Server** also grants access by default unless the server owner turns it off in **Guild Settings**.

Always check **Current Guild** before saving. HAF stores most feature settings separately for each Discord server.

## Discord Role Hierarchy

HAF Bot can only assign, remove, or manage roles below its highest Discord role.

Move HAF Bot's role above any role used for:

- member verification;
- linked-player access;
- Clan membership;
- temporary restrictions or Timed Roles; and
- event or workflow role grants.

The bot also needs **Manage Roles** for those actions. Discord Administrator permission is not required when the individual permissions are configured correctly.

## Channels, Categories, and Roles

Most features need one or more Discord resources:

- **Panel or noticeboard channel** — where members start a workflow.
- **Log or audit channel** — where staff review activity.
- **Review queue** — where moderators act on flagged content.
- **Private category** — where HAF creates tickets, Clan channels, or temporary rooms.
- **Access role** — staff who may view or operate a sensitive feature.
- **Excluded role** — trusted members ignored by a moderation rule.

Many feature pages can create recommended resources or reuse existing ones. Review the visibility preview before confirming resource creation.

If a channel or role is missing from a picker, refresh the dashboard cache and check the bot's permissions in **Troubleshooting**.

## Save and Publish

**Save** stores the configuration in HAF Bot.

A separate **Publish** action creates or updates the message members use in Discord. Changing saved panel text does not change the live Discord message until you publish again.

Some features do not use a member-facing panel and therefore have no Publish action.

## Setup Check and Test Configuration

These actions answer different questions.

### Setup check

Checks the last saved configuration against the selected Discord server. It can identify missing channels, roles, permissions, or role-order problems.

It does not save edits, publish messages, or trigger the feature.

### Test configuration

Some editors provide a safe preview for the fields currently on screen. For example, a tester may preview a regex match or resolve a URL template.

It does not save the draft or send data to the configured external destination unless the page explicitly describes a live test.

### Real member-flow test

A passing check does not prove the complete workflow. Test member-facing features from a non-admin account in a suitable test channel before announcing them.

## Common Permission Problems

| Symptom                               | Check                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| A role is not assigned                | Move HAF Bot above the target role and grant **Manage Roles**                         |
| A panel cannot be published           | Grant **View Channel**, **Send Messages**, and **Embed Links** in the panel channel   |
| A private channel cannot be created   | Grant **Manage Channels** in the target category                                      |
| A thread cannot be created or updated | Check thread permissions in the parent channel                                        |
| A reaction cannot be removed          | Grant **Manage Messages** in the target channel                                       |
| A member cannot use a button          | Check channel visibility, role restrictions, and whether the saved panel is published |

## Plans and Limits

Paid features unlock when the server has an active Guild Assignment. When paid access ends, HAF keeps saved configuration but paid-only processing becomes inactive.

Quantity limits are enforced automatically. The dashboard shows the current plan, usage, and feature state. See [Compare Plans](/plans) for the current limits.

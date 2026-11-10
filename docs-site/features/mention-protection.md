---
description: "Configure HAF Bot responses to unwanted staff mentions and mention spam. Understand Free warnings and deletion, paid actions, channel scope and exclusions."
---

# Mention Protection

Mention Protection handles direct-user mention spam that Discord's role and `@everyone` controls do not cover.

It has two independent protections:

- **Admin Mention Protection** — detects direct mentions of members who currently hold a selected protected role, plus mentions of the protected role itself.
- **Mention Spam Protection** — detects too many directly mentioned users in one message or too many mention-containing messages in a short period.

Role mentions, `@everyone`, `@here`, plain-text names, and automatic reply notifications do not count toward Mention Spam Protection.

::: info Availability
Admin Mention Protection is available on every plan with warning and deletion responses. Mention Spam Protection, Discord timeouts, and Timed Role restrictions require Premium or Premium Plus.
:::

## Quick Setup

Open **Admin Dashboard → Mention Protection**. Start with warnings before enabling deletion or member restrictions.

![Mention Protection dashboard with shared scope and thresholds numbered](/images/generated/admin-mention-protection.png)

1. **Channel scope and excluded roles** — shared by both protections.
2. **Protected Admin Roles** — members holding these roles are protected from direct mentions.
3. **Mass Mention users** — distinct users mentioned in one message before it becomes a breach.

To configure it:

1. Choose included or excluded channels.
2. Exclude trusted staff, integration, or member roles where needed.
3. Enable one protection at a time.
4. For Admin Mention Protection, choose the protected roles.
5. For Mention Spam Protection, review the Mass Mention and Mention Burst settings.
6. Configure the initial and repeat responses.
7. Save and test in a private channel with non-admin accounts.

Threads and Forum posts use their parent channel's scope.

## Mention Spam Conditions

### Mass Mention

A single message directly mentions at least the configured number of **distinct users**.

Example: with a threshold of `5`, one message mentioning five different members breaches the rule. Mentioning the same member repeatedly still counts as one distinct user.

### Mention Burst

The same author sends at least the configured number of messages containing one or more direct-user mentions within the configured time window.

Example: with `5 messages / 10 seconds`, the fifth mention-containing message inside that ten-second window breaches the rule. The messages can mention different users.

A message can breach both conditions at once.

## Initial and Repeat Breaches

Each protection has an **initial response** and a **repeat response**.

- The first breach uses the initial response.
- Another breach by the same member within that protection's repeat period uses the repeat response.
- After the repeat period passes without another breach, the next breach is treated as initial again.

The default repeat period is 24 hours, but the saved configuration controls the actual period.

## Responses

A response can:

- reply with a warning;
- delete the triggering message;
- apply a Discord timeout; or
- apply a Timed Role.

Fresh Admin Mention Protection settings warn and delete on both initial and repeat breaches. Paid guilds can choose the timeout preset or configure a restriction explicitly. On Free, presets change warning and deletion actions while preserving any retained paid restrictions; those restrictions stay dormant until the guild upgrades.

When one message breaches both protections, HAF combines the responses:

- sends at most one warning;
- deletes the message at most once;
- applies the longest configured timeout; and
- applies each configured Timed Role once, using the longest requested duration for duplicate roles.

If the member already has a longer timeout or Timed Role expiry, HAF does not shorten it.

Deletion does not require a Guild Audit Log destination. When a message is deleted, HAF attempts to write one deletion audit event containing all conditions that were breached.

## What Is Ignored

Mention Protection ignores:

- messages from bots;
- webhook-authored messages;
- members with an excluded role;
- channels outside the configured scope; and
- role, `@everyone`, and `@here` mentions for Mention Spam counting.

## Paid Access Ending

If paid access ends, Mention Spam Protection and paid restrictions stop. Admin Mention Protection continues using warning and/or deletion.

Restoring paid access affects new messages only. HAF does not reprocess messages sent while paid processing was unavailable.

## Test Safely

Use non-admin test accounts in a private channel. Confirm:

- plain-text names and ordinary role mentions do not count as direct-user mentions;
- protected role or member mentions trigger Admin Mention Protection;
- the Mass Mention and Mention Burst examples match your thresholds;
- initial and repeat responses differ as expected; and
- HAF has permission to reply, delete messages, time out members, and manage selected Timed Roles.

Use **Setup check** after saving to inspect channel scope, roles, response requirements, and permissions. It does not send a warning, delete a message, or apply a restriction.

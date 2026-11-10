---
description: "Configure HAF Bot chat rules, staff moderation commands and private member reports."
---

# Chat Moderation

Chat Moderation adds general chat rules and staff tools alongside Reaction Rules, Image Rules, Mention Protection and Bot Defense. It starts disabled and is available on every plan.

## Chat Rules

Open **Admin Dashboard → Chat Moderation** and add up to 25 rules. Rules can match literal words or phrases, linked domains including subdomains, Discord invites, or a member's message count within a time window. Word matching is substring based and ignores case; it does not execute regular expressions.

Choose optional channels and excluded roles. Empty channel selection applies across the Guild. Bots, webhooks, configured moderators and members holding Administrator roles are excluded. A rule may warn, delete the triggering message, or apply a timeout after the configured number of violations in its window. Start with warnings and inspect real matches before enabling stronger actions.

Timeouts preserve an existing longer timeout. Chat Rules do not change Bot Defense's confirm/dismiss behavior and do not automatically kick or ban accounts. Old queued messages are not processed after five minutes.

## Staff Tools and Reports

Select moderator roles. HAF Guild Admins also have staff-tool access. `/mod warn` records a warning, `/mod history` shows recent history, and `/mod timeout`, `/mod kick`, `/mod ban`, `/mod unban` and `/mod purge` perform the named action. Account actions require the actor's matching Discord permission and a lower target role; HAF's role must also outrank the target. Purge inspects at most 100 recent messages and supports optional member/text filters. Retried purges retain the original selected message IDs.

Account actions retain a request record before contacting Discord. A lost or interrupted result is not automatically repeated: check Discord before issuing a new command. Successful actions also record their outcome.

Choose a private staff text channel for member reports. It must deny View Channel to `@everyone` and let HAF view and send messages. Members can then use **Report Message** in the message Apps menu. Reports contain the reporter, reported member, original message link and a note identifying the message-menu report. Each member can send one report per minute. Reporting does not apply a penalty.

Use **View recent moderation activity** to inspect recorded actions. Ordinary message-rate observations are internal counters and expire after two days. Staff actions and rule violations remain available for the server's moderation history.

For web submissions from banned members, see [Ban Appeals](/features/ban-appeals).

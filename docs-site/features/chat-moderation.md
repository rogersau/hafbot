---
description: "Configure HAF Bot chat rules, staff moderation commands and private member reports."
---

# Chat Moderation

Chat Moderation adds general chat rules and staff tools alongside Reaction Rules, Image Rules, Mention Protection and Bot Defense. It starts disabled and is available on every plan.

## Chat Rules

Open **Admin Dashboard → Chat Moderation** and add up to 25 rules. Rules can match literal words or phrases, linked domains including subdomains, Discord invites, or a member's message count within a time window. Word matching is substring based and ignores case; it does not execute regular expressions.

Choose optional channels and excluded roles. Empty channel selection applies across the Guild. Bots, webhooks, configured moderators and members holding Administrator roles are excluded. A rule may warn, delete the triggering message, or apply a timeout after the configured number of violations in its window. Start with warnings and inspect real matches before enabling stronger actions.

Choose **AI spam detection** to classify eligible Discord message text with the installation's AI provider. To try it in one channel, select that channel and the warning action. Review the matches in **View recent moderation activity** before expanding the rule. If the provider is unavailable or returns an unreadable decision, the AI rule skips that message and the other chat rules still apply.

Each AI spam rule has a minimum spam probability, which defaults to 90%. Rules share the model's score for a message. For example, with a warning rule at 80% and a deletion rule at 98%, a message scored at 92% triggers only the warning. A score equal to the threshold counts as a match.

Installation operators configure one decision provider in the bot's environment.

- For TypeSafe AI's Jev, set `MESSAGE_CLASSIFICATION_PROVIDER=jev` and put your TypeSafe API key in `MESSAGE_CLASSIFICATION_API_KEY`. HAF requests a yes/no probability from Jev. [TypeSafe decision guide](https://docs.typesafe.ai/primitives/noul)
- For OpenAI, set `MESSAGE_CLASSIFICATION_PROVIDER=openai` and supply your OpenAI key in the same variable. HAF uses a predicate question with the Decisions API. A custom service configured with `MESSAGE_CLASSIFICATION_API_BASE_URL` must implement the Decisions endpoint and its predicate response format. [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)

Set `MESSAGE_CLASSIFICATION_MODEL` to override the provider's default model. Restart the bot after changing its environment.

Timeouts preserve an existing longer timeout. Chat Rules do not change Bot Defense's confirm/dismiss behavior and do not automatically kick or ban accounts. Old queued messages are not processed after five minutes.

## Staff Tools and Reports

Select moderator roles. HAF Guild Admins also have staff-tool access. `/mod warn` records a warning, `/mod history` shows recent history, and `/mod timeout`, `/mod kick`, `/mod ban`, `/mod unban` and `/mod purge` perform the named action. Account actions require the actor's matching Discord permission and a lower target role; HAF's role must also outrank the target. Purge inspects at most 100 recent messages and supports optional member/text filters. Retried purges retain the original selected message IDs.

Account actions retain a request record before contacting Discord. A lost or interrupted result is not automatically repeated: check Discord before issuing a new command. Successful actions also record their outcome.

Choose a private staff text channel for member reports. It must deny View Channel to `@everyone` and let HAF view and send messages. Members can then use **Report Message** in the message Apps menu. Reports contain the reporter, reported member, original message link and a note identifying the message-menu report. Each member can send one report per minute. Reporting does not apply a penalty.

Use **View recent moderation activity** to inspect recorded actions. Ordinary message-rate observations are internal counters and expire after two days. Staff actions and rule violations remain available for the server's moderation history.

For web submissions from banned members, see [Ban Appeals](/features/ban-appeals).

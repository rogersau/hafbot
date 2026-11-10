---
description: "Collect structured Discord suggestions with questions, duplicate warnings, discussion, private voting and written staff outcomes. Available on every HAF plan."
---

# Suggestions

Suggestions helps a Discord community discuss and decide changes without turning the process into a popularity leaderboard. It combines structured proposals, private Support/Oppose voting, Considered Replies, visible revisions, and staff-authored outcomes in one Discord Forum.

::: info Available on every plan
The complete Suggestions workflow is free. Suggestions messages carry standard `hafbot.xyz` branding unless the Guild uses the existing global white-label behaviour.
:::

## Setup

Open **Admin Dashboard → Suggestions** for the intended server.

1. Select one Discord Forum as the **Suggestion Channel**.
2. Select a channel for the permanent **Suggestion Panel**.
3. Select a **Suggestions Mod Queue** channel.
4. Configure Suggestion Mod Role(s), or leave them empty to use Guild administrators.
5. Review the proposal prompts and optional Suggestion Categories.
6. Configure voting eligibility, abuse limits, and the optional Suggestion Digest.
7. Save, then select **Publish or repair Panel & tags**.
8. Enable Suggestions after the readiness checks pass.

Publishing is idempotent: HAF updates the existing Panel when possible and creates missing lifecycle tags without duplicating healthy ones.

Discord Forums allow 20 tags. Suggestions reserves six for lifecycle status, so the dashboard permits at most 14 optional categories and reports missing or unmanageable resources as degraded.

## Submitting and refining

Members use the permanent Suggestion Panel. There is no `/suggest` command. The modal always asks for a title and one to four Guild-configured proposal prompts. HAF warns about likely active duplicates but lets the member explicitly submit anyway.

Each submission creates one Forum thread with a bot-owned starter containing the author, structured answers, timestamps, status, category, aggregate votes, outcome, and participation controls.

Authors may edit while Gathering Feedback or Needs Work. Each edit preserves a durable Suggestion Revision.

## Voting and privacy

Eligible members can select **Support**, **Oppose**, or **Remove Vote**. Public surfaces show Support, Oppose, and participation totals but never voter identities.

Eligibility checks current Guild membership, the configured voter role, and minimum continuous Guild tenure. Leaving removes active votes from current totals. Vote totals never automatically accept or reject a Suggestion.

Submission, edit, vote, reply, flag, staff-transition, and moderation actions also use application-level rate limits. Provider failures are returned separately from eligibility and authority errors.

## Considered Replies

Members use **Add Considered Reply** instead of ordinary thread chatter. The form records a Support, Oppose, Mixed, or Question perspective, reasoning, and an optional improvement.

HAF posts the reply with clear Discord-user attribution and suppressed mentions. Direct messages from the Suggestion author and Suggestion Mods remain available; ordinary member messages are removed with a structured-reply reminder.

## Community flags and collapse

Eligible members may add or remove one 🚩 flag. Authors cannot flag their own reply. At the configured threshold, HAF replaces the visible reply with a neutral stub, preserves the original in D1, and creates one Suggestions Mod Queue item.

Flag identities stay private. Removing flags later does not auto-restore content.

| Mod Queue action   | Result                                    |
| ------------------ | ----------------------------------------- |
| **Keep Collapsed** | Keeps the stub and closes review          |
| **Restore Reply**  | Restores the preserved content            |
| **Hard Delete**    | Deletes the message and requires a reason |

## Lifecycle and outcomes

Suggestion Status has six values: Gathering Feedback, Needs Work, Under Review, Planned, Implemented, and Rejected.

Authors may switch only between Gathering Feedback and Needs Work. Suggestion Mods control all other transitions. Planned, Implemented, and Rejected require a written Suggestion Outcome and lock the thread by default. Reopening requires a staff reason.

There is no Withdrawn status. Staff record an author's retraction as Rejected with an explanation.

## Suggestion Digest

The optional weekly digest balances new Suggestions, active Suggestions needing feedback, and recently decided Suggestions. It is not a highest-score leaderboard and is published idempotently per Guild and period.

## Repair and safety

D1 is authoritative. Discord threads, tags, starter messages, Panel messages, replies, Mod Queue items, and digests are projections. The dashboard reports missing resources as degraded; **Publish or repair Panel & tags** reconciles the managed Panel and lifecycle tags. A manually deleted Suggestion thread is not silently recreated.

Material changes appear in the configurable **Suggestion Events** Guild Audit Log group: configuration and Panel publication, creation and revision, status and outcome, collapse and terminal moderation decisions, and explicit repair. Ordinary votes, flags, and replies are intentionally excluded.

HAF suppresses unsafe mentions and keeps voters and flaggers off public surfaces. Community collapse never warns, times out, kicks, bans, or changes roles.
The managed Considered Reply webhook token is encrypted in HAF's credential vault; Suggestions configuration and Admin responses retain only its credential reference.

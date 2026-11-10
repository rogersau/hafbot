---
title: Set up a WARDOGS Discord community with HAF Bot
description: "Start a WARDOGS Discord community with HAF Bot's current player-link, support and group workflows, plus an honest boundary around game-server integrations."
---

# Set up a WARDOGS Discord community with HAF Bot

HAF Bot can make the Discord side of a WARDOGS community useful before every game-server
integration is ready. Start with one member workflow, test it with a real non-admin account, and
add another feature only when the community has a reason for it.

This is a HAF Bot community guide, not an official WARDOGS or host announcement. HAF does not
host game servers. The page does not claim live WARDOGS RCON, ban control, reserved access, queue
priority, guaranteed entry, or Server XP.

## A Discord Guild is not a game server

A **Discord Guild** is the community where HAF stores configuration, publishes panels, and gives
staff their workflows. A **Configured Game Server** is a separate external target. The Discord
features below do not require a WARDOGS RCON connection or game-server credentials.

The Steam-directory provider in [Player Count](/features/player-count) requires a compatible
listed server. WARDOGS integration preparation requires separately approved, validated reads. Generic Steam
status does not establish WARDOGS support. See the dated
[integration-status matrix](#wardogs-integration-status) before planning a game-server workflow.

## Before you start

You need:

- permission to add HAF Bot to the Discord Guild;
- permission to configure the selected HAF feature;
- a place for the member-facing panel and any private staff records; and
- a decision about whether the Guild will stay on Free or use an assigned paid plan.

Keep HAF Bot's role above any role it must assign or remove. Read [Getting Started](/getting-started)
and [Compare Plans](/plans) if the Guild has not used HAF before. Opening this page does not install
HAF, create Discord resources, or enable a feature.

Each feature owns its own setup and **Feature Readiness**. The dashboard's **Setup check** reports
saved resources and permissions; it is not proof that a WARDOGS game-server integration works.
Use the linked feature page for the exact configuration and member-flow test.

## Five-step starting path

Each step has one visible success check. Save and publish are separate actions where a feature page
provides both; do not announce a panel until the member-flow test passes.

### 1. Install HAF and select the right Guild

**Outcome:** HAF Bot is in the intended Discord Guild and the dashboard is looking at that Guild.

**Minimum prerequisites:** You can add an app to the Guild, and you know which staff member will
configure it.

**Open:** [Add HAF Bot](https://hafbot.xyz/install), then [open the dashboard](https://hafbot.xyz/admin)
and follow [the dashboard setup notes](/admin-dashboard).

**Success check:** The bot is visible in the intended Guild, the dashboard shows that Guild, and
the bot's role is high enough for the first feature you will test.

### 2. Link Steam accounts when staff need player identities

**Outcome:** Staff can connect a Discord member to a game-platform identity for a support or
moderation workflow.

**Minimum prerequisites:** A panel channel and a linked-member role that HAF can manage.
Free supports up to **100 links combined across Steam, Xbox, and PlayStation**. Steam and Xbox use
platform sign-in; PlayStation IDs are self-reported and do not prove account control.

**Open:** [Player Link](/features/player-link). Select Steam for this workflow,
choose the panel and role, save, and publish the panel.

**Success check:** A non-admin test member completes the selected flow, receives the expected role
when one is configured, and staff can use the documented lookup flow. Do not treat a link as an
anti-cheat result, proof of WARDOGS ownership, or proof that the member is trustworthy. Staff manual links are administrative records, not proof of Steam sign-in.

### 3. Give reports and appeals a private path

**Outcome:** A member can open a private support Ticket instead of posting a player report in
general chat.

**Minimum prerequisites:** A Ticket panel channel, private Ticket category, transcript destination,
and support role. Free includes **one panel with one Ticket type**, intake questions, support-role
notifications, staff claiming, and ordinary transcripts.

**Open:** [The Ticket setup walkthrough](/guides/discord-ticket-bot), then [the complete Tickets
reference](/features/tickets).

**Success check:** A non-staff test member opens a Ticket, sees only the intended participants,
receives a staff response, and closes it. Confirm that the transcript arrives before announcing the
panel. Paid plans add more types and advanced tools; buying a paid plan does not enable a WARDOGS
game-server integration.

### 4. Organise play with LFG or Events

**Outcome:** Members have one structured way to find a group or sign up for a scheduled activity.

**Minimum prerequisites:** A member-facing channel and a moderator who will close or correct test
content. [LFG](/features/lfg) is included on Free. [Events](/features/events) requires Premium or
Premium Plus; its saved rosters and reminders remain inactive on Free.

**Open:** Configure [LFG](/features/lfg) for an ongoing noticeboard, or configure [Events](/features/events)
for a scheduled roster. Publish only after saving the configuration.

**Success check:** From a non-admin account, a harmless LFG post can be created and closed, or a
member can join the intended Event signup group. HAF coordinates Discord participation; it does
not start a game session or promise a game-server slot.

### 5. Add restricted staff evidence when it is needed

**Outcome:** Staff can preserve one harmless Discord message in a private evidence workflow while
keeping ordinary members out of the record.

**Minimum prerequisites:** A private Evidence Vault audit channel and either configured access
roles or Guild administrators who will use the feature. Free includes up to **30 records** within
the Guild's managed-storage allowance.

**Open:** [Evidence Vault](/features/evidence-vault), configure access, and read its retention and
privacy limitations before storing sensitive content.

**Success check:** An authorised staff tester hides harmless content, the record and audit event
arrive, and an ordinary member cannot view it. This is a deliberate staff action, not automatic
archiving of every Ticket.

## WARDOGS integration status

The following status was checked against public HAF pages and current implementation on
**2026-09-09**. Discord workflows are documented publicly; game-integration preparation in code
is not evidence of production activation. No live WARDOGS target was contacted or tested. HAF maintainers update a row only after actual deployment and recorded
activation evidence; an issue closing, a pull request merging, or a provider advertising a panel
capability is not enough.

| Area                                 | Truthful status                                                                                                                                                                                                                                                                                                                                 | Last verified | Public evidence and owner                                                                                                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord community workflows          | **Available.** Player Link, LFG, Tickets, and Evidence Vault follow their current feature pages. Events is a paid feature.                                                                                                                                                                                                                      | 2026-09-09    | HAF maintainers — [Player Link](/features/player-link), [LFG](/features/lfg), [Tickets](/features/tickets), [Evidence Vault](/features/evidence-vault), [Events](/features/events), and [Plans](/plans) |
| WARDOGS Player Count                 | **Not enabled; in preparation.** Experimental target setup is being prepared; production availability requires deployment and actual target read validation. Steam-directory compatibility is not WARDOGS validation.                                                                                                                           | 2026-09-09    | HAF maintainers — [Player Count](/features/player-count)                                                                                                                                                |
| WARDOGS ban and unban                | **Not enabled.** Ban Cases supports staff report review. Separate WARDOGS action preparation is gated on a live supported contract and explicit mutation approval.                                                                                                                                                                              | 2026-09-09    | HAF maintainers — [Ban Cases](/features/ban-cases)                                                                                                                                                      |
| WARDOGS reserved-access Commerce     | **Not enabled.** Commerce remains a restricted pilot, and no public page confirms WARDOGS reservation semantics. Reserved slots must not be described as queue priority, guaranteed entry, or VIP support.                                                                                                                                      | 2026-09-09    | HAF maintainers — [Commerce](/features/commerce) and [Plans](/plans)                                                                                                                                    |
| WARDOGS Server Levels and attendance | **No WARDOGS XP promise.** Current Server Levels documentation is for paid DayZ attendance through CFTools. Any WARDOGS attendance test is observation-only: it awards no XP and does not backfill retroactive rewards. Observations can never be converted into later awards; earning would require a separate supported contract and release. | 2026-09-09    | HAF maintainers — [Server Levels](/features/server-levels) and [the DayZ community guide](/guides/dayz-discord-bot)                                                                                     |

Do not configure paid access, RCON writes, or an XP-earning feature from this page. Maintainers
keep the validation and pilot runbook separate from this public setup path.

## What to do next

Use the [dashboard](/admin-dashboard) and [Troubleshooting](/admin-dashboard#troubleshooting) for
Discord configuration problems. For a small community, keep the first workflow on Free until a
real member test succeeds. Upgrade only for a documented requirement such as Events, higher
Player Link or Evidence Vault limits, or another paid feature listed in [Compare Plans](/plans).

For product help, use the [HAF support Discord](https://discord.gg/HpRPkdm6dv). Do not post
credentials, private endpoints, or player identifiers in a public support channel.

For game-server integration questions, use the public status above rather than assuming that a
WARDOGS name, a Steam listing, or a provider panel implies HAF support.

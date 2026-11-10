---
description: "Install HAF Bot, choose your Discord server, configure one feature and test it as a member. Learn the difference between saving and publishing."
---

To run your own bot and infrastructure, follow [Self-host with Docker](/self-hosting).
This guide covers installing the hosted HAF service.

# Getting Started

HAF Bot helps gaming Discords manage player identities, groups, events, support tickets, evidence, moderation, and server automation from one dashboard.

## Before You Start

You need:

- permission to add a bot to the Discord server;
- a Discord role that can manage the HAF features you are setting up;
- HAF Bot's role above any roles it needs to assign or remove; and
- the channels, categories, and staff roles your chosen feature will use.

Most feature pages can also create their recommended Discord resources for you.

## Ten-Minute Setup

1. Visit [hafbot.xyz/install](https://hafbot.xyz/install) and add HAF Bot to your Discord server.
2. In Discord, check that HAF Bot's role is above any member, verification, linked-player, or temporary roles it will manage.
3. Sign in at [hafbot.xyz/admin](https://hafbot.xyz/admin).
4. Choose the Discord server you want to configure.
5. Configure one feature rather than enabling everything at once.
6. Save the configuration.
7. Publish the member-facing panel or noticeboard when the page provides a separate **Publish** action.
8. Test the real Discord flow with a non-admin account.
9. Open **Troubleshooting** and fix any permission or resource warnings.

::: tip Save and Publish are different
**Save** stores the configuration in HAF Bot. **Publish** creates or updates the message members use in Discord. Some features do not need a published message.
:::

## Choose a Good First Feature

Start with the problem your server already has:

- **Connect Discord members to game accounts:** [Player Link](/features/player-link)
- **Verify new members:** [Member Verification](/features/member-verification)
- **Help members find groups or trades:** [LFG](/features/lfg) or [Marketplace](/features/marketplace)
- **Create persistent teams:** [Clan Management](/features/clan-management)
- **Run scheduled rosters:** [Events](/features/events)
- **Handle reports, appeals, or support:** [Tickets](/features/tickets)
- **Store staff evidence:** [Evidence Vault](/features/evidence-vault)
- **Reduce reaction, mention, image, or bot spam:** [Reaction Rules](/features/reaction-rules), [Mention Protection](/features/mention-protection), [Image Rules](/features/image-rules), or [Bot Defense](/features/bot-defense)
- **Keep a shared staff record:** [Guild Audit Log](/features/guild-audit-log)

See [Compare Plans](/plans) for the complete feature and limit breakdown.

## Test Before Announcing It

For any member-facing feature:

1. Use an account without Discord Administrator permission.
2. Confirm the member can see and use the intended panel, button, or command.
3. Confirm private channels remain hidden from ordinary members.
4. Confirm HAF Bot can assign roles, create channels, send messages, and manage threads where required.
5. Confirm staff logs and review queues receive the expected result.

A passing **Setup check** confirms saved resources and permissions. It does not replace a real member-flow test.

## Getting Help

Use **Troubleshooting** in the dashboard when a configured feature cannot access a channel, manage a role, or create a Discord resource. For product help, use the official HAF Bot Discord linked from [hafbot.xyz](https://hafbot.xyz).

---
title: A Discord bot for your DayZ community
description: "Use HAF Bot for the Discord side of your DayZ server: player account lookups, private support tickets, LFG and staff evidence workflows. Start free."
---

# A Discord bot for the community around your DayZ server

Help staff connect a Discord member to a game account, handle a player report privately, and keep community activity organised. HAF Bot brings those Discord workflows into one dashboard.

**Start with the problem your staff already have.** You can try player linking or one support Ticket type on Free without moving every part of your server to HAF.

[Add HAF Bot to Discord](https://hafbot.xyz/install) · [Compare plans](/plans)

## Know which player you are dealing with

[Player Link](/features/player-link) connects a Discord member to a game-platform identity that staff can look up during a report, appeal or dispute.

| Platform    | Link method                     | Important limit                                                           |
| ----------- | ------------------------------- | ------------------------------------------------------------------------- |
| Steam       | Steam sign-in through OpenID    | Identifies the authenticated Steam account; it is not an anti-cheat check |
| Xbox        | Microsoft/Xbox sign-in flow     | Identifies the account returned by that flow                              |
| PlayStation | Member supplies a PSN Online ID | Self-reported; HAF does not verify control of the PSN account             |

Manual staff links are administrative records, not proof that the member completed platform sign-in. Free supports up to **100 links combined across supported platforms**, not 100 per platform.

For a Steam community, configure the Steam panel, choose the linked-member role, save and publish. Keep HAF Bot's role above the role it assigns. Then test a member link and the staff lookup before making it part of your support process.

## Move player reports out of general chat

Use [Tickets](/features/tickets) for private player reports, game-server appeals or general support. A practical Free starting point is one **Player support** type asking for the game server, relevant player and approximate incident time.

Free includes **one panel and one Ticket type**, intake questions, support-role notifications, staff claiming and ordinary transcripts. Paid plans support separate types and advanced tools such as anonymous staff replies and conditional responses.

Test with a non-staff account so the report goes to the intended staff role and is not visible to unrelated members. Members must still be able to access your Discord server to use its Ticket panel.

[Follow the Ticket setup walkthrough](/guides/discord-ticket-bot)

## Add community tools only when needed

[LFG](/features/lfg) gives members a structured place to find people to play with. [Marketplace](/features/marketplace) organises community trade listings. Both are available on Free; they do not carry out an in-game trade for the players.

For staff who need a separate record of a sensitive Discord message, [Evidence Vault](/features/evidence-vault) can save supported content, remove the original message from public view and record the staff action. Free includes up to **30 records**, within the server's managed storage allowance.

Evidence Vault is a separate staff action, not an automatic archive of every Ticket. Records do not automatically expire, and its customer workflow does not include record deletion or bulk export. Read its access and privacy-request limitations before using it for sensitive records; test only with harmless content.

## Recognise players who help populate the server

[Server Levels](/features/server-levels) is a paid beta for DayZ communities using CFTools Hephaistos. It awards Server XP for confirmed attendance and gives higher scoring rates during quieter occupancy periods. It requires Steam Player Link and supports up to five configured DayZ servers per Discord server.

This is not generic Discord chat XP or a guarantee of increased player numbers. Read the provider requirements, scoring limits and no-backfill behaviour before enabling it.

## What this setup does not do

This guide covers Discord community administration. It does not set up a killfeed, remote game-server administration, in-game ban synchronisation or anti-cheat detection. Keep existing specialist tools for those requirements unless you have separately verified a supported HAF integration for your exact setup.

Account linking is not a guarantee that a player is trustworthy. PlayStation IDs and manual links have the assurance limits described above.

## Start small; upgrade for a specific need

A Free pilot can combine 100 platform links, one support panel and one Ticket type. It also includes LFG and Marketplace, with a shared **100 MB managed-storage allowance per Discord server**. Paid plans raise the storage allowance to **1 GB per assigned Discord server** and remove the relevant Free quantity limits.

Premium covers **one Discord server**. Premium Plus covers **up to three Discord servers** and can use **one shared white-label bot identity** across the assigned servers. These are Discord-server assignments, not a promise about how many DayZ game servers an integration supports.

Prices and Founder Pricing availability can change. Use [Compare Plans](/plans) and the [current HAF website](https://hafbot.xyz/) when choosing a subscription.

**First milestone:** one player completes the chosen workflow, and staff can use the result. Prove that before enabling more features.

[Add HAF Bot](https://hafbot.xyz/install) · [Getting Started](/getting-started) · [Player Link setup](/features/player-link)

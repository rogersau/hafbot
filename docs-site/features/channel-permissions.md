---
description: "Preview and copy Discord channel permission overwrites with HAF Bot. Choose role-only or exact copy and review access removals before applying changes."
---

# Copy channel permissions

The **Channel permissions** admin tool copies Discord permission overwrites from one existing Guild channel to another. It preserves the target channel itself: its messages, name, type, topic, category, and other settings are not copied.

## Choose a mode

- **Role permissions only** replaces the target's role overwrites, including `@everyone`, with the source role overwrites. Existing member-specific overwrites on the target are retained. This is the recommended mode.
- **Exact copy** replaces every target overwrite with the source channel's role and member overwrites. Member access can be removed, so the preview calls out those removals and requires the target channel name before applying.

Both modes preserve HAF Bot's minimum recovery access. If the copied result would lock the bot out, the preview shows an added or changed HAF Bot member overwrite granting only **View Channel**, **Manage Channels**, and **Manage Permissions**. Exact copy therefore means the exact source overwrite set plus this explicit safety overwrite when required.

The tool applies to categories, text, announcement, voice, stage, Forum, and media channels. Threads cannot own independent channel overwrites and are not available in the selectors.

## Preview first

Select different source and target channels, choose a mode, and select **Preview changes**. The preview lists every overwrite that will be added, removed, changed, or retained and decodes the affected permissions into names.

A preview can become stale when either channel moves category, changes type, or has its overwrites edited. HAF Bot rechecks Discord immediately before applying and asks you to preview again instead of overwriting newer changes.

Changing the source, target, or mode also invalidates the current preview.

## Categories

Copying to a channel that currently matches its category can make that channel unsynchronised. The preview warns before this happens. Copying to a category changes only the category; Discord's normal synchronisation rules determine what happens to child channels, and HAF Bot does not patch each child directly.

## Required permissions

The administrator must have HAF dashboard access for the server and currently be the Discord server owner or have **Administrator** or **Manage Channels**.

HAF Bot must have enough current Discord access to manage the target and its referenced roles. The preview blocks the copy when a role is missing, managed, above the bot in the role hierarchy, or when HAF Bot cannot safely apply its recovery overwrite. Move HAF Bot's role higher or correct its Guild permissions, then generate a new preview.

## Audit history

Discord records the channel update in its native audit log with the source channel and acting administrator. A successful Discord response is the commit point. If the dashboard cannot refresh afterward, use **Retry refresh**; do not repeat the copy.

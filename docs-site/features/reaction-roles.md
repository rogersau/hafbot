---
description: "Let Discord members choose game roles and channel access by reacting to a HAF Bot welcome message."
---

# Reaction Roles

Reaction Roles lets members choose game access, regions, platforms, or notifications from role panels. Reacting adds the matching role; removing the reaction removes that role. Each panel can allow several roles or one role at a time.

Reaction Roles is available on every plan, with up to 10 independently managed panels per server and up to 20 emoji-to-role choices per panel. It does not require Discord Community Onboarding. Existing panels keep their message and emoji mappings when the additional panel controls become available.

## Set Up Game Access

1. In Discord, create an ordinary role for each game, such as **DayZ** and **Rust**.
2. On each game's category, deny **View Channel** for `@everyone` and allow it for that game's role. Check that another member role does not already grant access.
3. Move HAF Bot's highest role above the game roles and give it **Manage Roles**.
4. In the welcome channel, allow HAF **View Channel**, **Send Messages**, **Add Reactions**, and **Read Message History**. Members need to be able to view that message and use its reactions.
5. Open **Admin Dashboard → Access Control → Reaction Roles**.
6. Choose **New panel**, select its channel, enter a title and message, and add one emoji, existing role, and display name per choice. Unicode and custom emoji are supported. Existing panels can be selected with their **Edit** buttons.
7. Review the message preview and choose **Save and publish**.
8. Use **View in Discord** to test from a non-admin member account. Select two games, then remove one reaction and confirm only its role is removed.

HAF publishes the message and adds the initial emoji reactions. It assigns existing roles; it does not create game roles, channels, or category permissions.

## Selection and Eligibility

- **Multiple roles** lets members keep several choices from this panel.
- **One role at a time** replaces the member's previous choice when they select another. HAF removes the old reaction and role before granting the new role. This mode also needs **Manage Messages** in the panel channel so HAF can clear the member's previous reaction.
- **Required roles** means the member must hold every selected eligibility role before a new role can be granted.
- **Blocked roles** prevents a new grant when the member holds any selected blocked role.

Leave both eligibility lists empty to allow everyone. Eligibility is checked from the member's current roles when a reaction is processed. Changing eligibility or losing a prerequisite does not retroactively revoke existing roles; the member can still remove their reaction to remove the selected role.

Eligibility roles must be separate from selectable roles, and the same role cannot be both required and blocked. A selectable role can belong to only one panel, so removing a selection from one panel cannot undo another panel's role choice.

## Role Safety

Selectable roles must be below HAF Bot in Discord's hierarchy. `@everyone`, integration-managed roles, and roles with staff or management permissions are rejected. HAF also rejects roles used for its staff, verification, linked-account, Clan, ticket, timed-role, or paid-role workflows. Chat Moderation moderator roles are protected even when they have no Discord permission bits. Previously configured panels and rewards are checked against the current moderator roles before granting access.

Use dedicated game roles.

HAF checks these restrictions again when processing selections. A role that becomes privileged after publication cannot be newly self-assigned through the panel.

Reaction Roles also respects a member's active Timed Role suspension. Selecting a game cannot restore a role that the timed assignment is currently suspending.

## Save, Publish, and Retry

**Save draft** saves the configuration and pauses processing until it is published. **Save and publish** applies the message and seeds its reactions.

If Discord fails partway through publishing, correct the reported channel, role, emoji, or permission problem and choose **Save and publish** again. HAF reuses its recorded message and retries adding the reactions.

After publication, the channel and existing emoji-to-role mappings stay fixed so members' reactions keep their meaning. You can edit the message and display names or append new choices. To replace existing mappings or move the message, delete the panel and create another.

Appended choices saved only as a draft remain editable until HAF writes them to the Discord message. Saving a draft does not lock those new choices.

## Pause and Delete

**Pause** stops processing selections for the selected panel. Existing member roles and other panels are retained. Publish the panel again to resume. Selections changed while processing was paused or unavailable are not backfilled; members should remove and re-add the relevant reaction afterward.

**Delete panel** removes the Discord message and configuration. It leaves existing member roles in place. Remove those roles separately if access should be revoked.

After switching between the standard bot and a White-Label Bot, use **Delete panel** to reset a panel owned by the previous identity, then publish a replacement. HAF removes the saved configuration; delete the previous bot's Discord message manually. Existing member roles remain in place.

Bulk clearing reactions does not remove existing member roles. Use individual reaction removal or manage affected roles separately. Reaction Roles is an opt-in convenience, not a membership or payment verification system.

## Reaction Rules and Limits

[Reaction Rules](/features/reaction-rules) still applies to the welcome channel. Exclude this channel from reaction limits or choose suitable limits, and avoid blocked emoji. A reaction removed by moderation does not count as an active selection.

## Troubleshooting

- **Roles are not being added:** check that the panel is Active, HAF can read the message, its role is above the selected roles, and it still has Manage Roles.
- **A custom emoji cannot be seeded:** check that the emoji still exists and the bot can use it in this channel.
- **A single-choice panel cannot be published:** grant HAF Manage Messages in its channel, in addition to the standard panel permissions.
- **An eligible-looking selection grants no role:** check all required roles, any blocked role, and active Timed Role suspensions. Remove and re-add the reaction after correcting eligibility.
- **The message was deleted outside HAF:** delete the stale panel configuration and create a new panel.
- **A role is already present:** HAF makes no extra role change. Removing the matching reaction removes that role even if staff originally assigned it.
- **Updates are delayed:** Gateway events are queued. HAF checks the member's current reactions when processing each event so delayed add/remove events converge on the current selection.

Implementation follows Discord's [reaction events](https://docs.discord.com/developers/events/gateway-events#message-reaction-add) and [reaction lookup API](https://docs.discord.com/developers/resources/message#get-reactions).

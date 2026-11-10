---
description: "Remove selected emoji reactions with HAF Bot's Discord blocklist. Configure included or excluded channels, staff logs and up to ten blocked emoji on Free."
---

# Blocklist

The blocklist is the free part of [Reaction Rules](/features/reaction-rules). It removes specific emoji reactions as soon as members add them.

## Commands

| Command                     | Description                        |
| --------------------------- | ---------------------------------- |
| `/blocklist add <emoji>`    | Add an emoji to the blocklist      |
| `/blocklist remove <emoji>` | Remove an emoji from the blocklist |
| `/blocklist list`           | List all blocked emojis            |

## How It Works

When a user reacts to a message with a blocked emoji:

1. HAF Bot receives the reaction event.
2. It checks the emoji against the server blocklist.
3. If the emoji is blocked, the bot removes the reaction.
4. If a log channel is configured, the bot reports what it removed.

## Channel Filtering

You can configure which channels the blocklist applies to:

- **All channels** — Blocklist enforced everywhere
- **Include mode** — Only block in specified channels
- **Exclude mode** — Block everywhere except specified channels

Open **Admin Dashboard** -> **Reaction Rules** to:

- Add or remove emojis from the blocklist
- Pick emojis from the server emoji picker
- Set a moderation log channel
- Choose include or exclude channel filtering

## Limits

| Tier         | Max Blocked Emojis |
| ------------ | ------------------ |
| Free         | 10                 |
| Premium      | No plan limit      |
| Premium Plus | No plan limit      |

Discord limits and abuse safeguards still apply. See [Compare Plans](/plans).

## Setup check

After saving, use **Setup check** to evaluate the saved Blocklist channels and permissions with
read-only diagnostics. It does not add a reaction or delete a message; confirm enforcement with a
harmless blocked reaction from a non-admin account.

## Pause the Blocklist

Open **More actions (⋯)** beside the Blocklist heading and select **Disable Blocklist**. Confirm to stop enforcement while retaining blocked emojis, channel filters, and logging settings. Select **Enable Blocklist** from the same menu to resume for new reactions. Reaction Limits has its own independent control.

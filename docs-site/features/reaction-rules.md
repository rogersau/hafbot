---
description: "Control Discord emoji reactions with HAF Bot blocklists and per-member limits. Configure channel scope, notifications and temporary breach roles."
---

# Reaction Rules

Reaction Rules control unwanted emoji use without deleting the underlying Discord message.

It has two independent parts:

- **[Blocklist](/features/blocklist)** — removes selected emoji reactions.
- **[Reaction Limits](/features/reaction-limits)** — removes reactions above message or member limits and can apply a breach role.

## Quick Setup

Open **Admin Dashboard → Reaction Rules** and confirm **Current Guild** is the server you intend to change.

![Reaction Rules dashboard with the main setup areas numbered](/images/generated/admin-reaction-rules.png)

1. **Blocklist** — add emoji HAF should remove.
2. **Emoji picker** — choose a Unicode or server emoji.
3. **Moderation log channel** — optional destination for enforcement and role-assignment events.
4. **Setup check** — tests the saved channels and permissions.

To finish setup:

1. Add at least one blocked emoji, enable Reaction Limits, or configure both.
2. Leave the channel list empty to apply the rule everywhere, or choose include/exclude filtering.
3. Choose an optional moderation log channel.
4. Save the configuration.
5. Test from a non-admin account in a suitable channel.

## Channel Filtering

Both features can use channel scope:

- **All channels** — applies everywhere HAF can manage reactions.
- **Include mode** — applies only in the selected channels.
- **Exclude mode** — applies everywhere except the selected channels.

Threads and Forum posts follow the behaviour of their parent channel where supported by the saved filter.

## What Members See

When a rule is breached, HAF removes the newly added reaction. It does not delete the message.

Reaction Limits can also DM the member or assign a role after repeated personal-limit breaches. See [Reaction Limits](/features/reaction-limits) for exact counter behaviour and a worked example.

## Availability

- Blocklist is available on every plan. Free supports up to 10 blocked emoji; paid plans have no HAF plan limit.
- Reaction Limits are available on every plan.

## Troubleshooting

If a reaction remains:

1. Confirm the rule is enabled and saved.
2. Check the channel include/exclude setting.
3. Confirm HAF Bot can view the channel and use **Manage Messages**.
4. Run **Setup check** or open **Troubleshooting**.

Setup checks do not add a reaction or delete a message. Always confirm enforcement with a harmless test reaction.

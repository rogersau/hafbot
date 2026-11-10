---
description: "Use the HAF Bot web dashboard to configure Discord workflows, publish panels, check permissions and troubleshoot your community's setup."
---

# Admin Dashboard

Use the admin dashboard to configure HAF Bot for each Discord server. Sign in with Discord at [hafbot.xyz/admin](https://hafbot.xyz/admin), then choose the server you want to manage.

Server owners, Discord Administrators, and members with the nominated **HAF admin role** can configure their server. **Manage Server** also grants access by default; the server owner can change that setting in **Guild Settings**.

## Quick Tour

![HAF Bot admin overview showing configuration status and recommended next steps](/images/generated/admin-overview.png)

1. **Current Guild** — the Discord server you are configuring.
2. **Action queue** — setup problems and useful next actions for that server.

Always confirm **Current Guild** before editing. Most HAF settings are stored separately for each Discord server.

The overview prioritises incomplete or broken setup. Healthy features stay out of the way. When nothing needs attention, it suggests one useful improvement.

## Saving and Publishing

Most configuration pages use a pinned action bar:

- **Save** stores the current configuration.
- **Discard changes** restores the last saved configuration.
- A disabled **Save** button means nothing has changed.

Some features also have **Publish**, **Publish panel**, or **Publish noticeboard**. Saving does not publish unless the feature page explicitly says it does. Complete both actions when setting up a new member-facing panel.

## Setup Checks

A **Setup check** appears when saved configuration needs attention or is still being checked. It tests the saved channels, roles, resources, and Discord permissions without changing anything.

Setup checks do not:

- save unsaved edits;
- publish a panel;
- send a test message;
- create a member post; or
- trigger the live feature.

Save first, then select **Recheck setup** after changing Discord permissions, channels, or role ordering.

## Troubleshooting

Open **Troubleshooting** when a configured feature cannot create, read, update, or delete the Discord resources it needs.

![Troubleshooting dashboard with diagnostics and example feature results numbered](/images/generated/admin-troubleshooting.png)

1. **Discord diagnostics** — permission and resource checks for supported features.
2. **Feature result** — whether the saved setup is healthy.
3. **Warning or error** — the channel, role, permission, or setting that needs attention.

A warning may identify incomplete optional setup. An error normally blocks part of the workflow. Fix the named resource or permission in Discord, then run the check again.

## Guild Settings

Guild Settings contains options shared by several HAF features.

![Guild Settings dashboard with the HAF administrator role controls numbered](/images/generated/admin-guild-settings.png)

The **HAF admin role** grants members access to configure Guild features in the dashboard. Choose a staff role rather than a role held by ordinary members.

Server owners and Discord Administrators retain HAF access. Manage Server grants HAF access by default; only the server owner can turn that automatic grant off or on in Guild Settings. The nominated HAF role is independent of this setting. Only the server owner or a Discord Administrator can nominate, change or clear that role. Nominated-role admins cannot delegate access.

This setting grants HAF dashboard access only. It does not change the member's Discord permissions. After saving, test access with one member who has the role and one who does not.

## Profile

Open the account menu and select **Profile** to manage your own dashboard preferences.

![Profile dashboard with identity, Guild list, and appearance settings numbered](/images/generated/admin-profile.png)

You can choose a default Guild, hide Guilds from your personal switcher, and select the dashboard theme. Hiding a Guild does not remove HAF Bot or change anyone else's access.

## Billing

Use **Billing** to compare plans, manage the subscription, and assign paid capacity to Discord servers.

![Billing dashboard with current plan, plan comparison, and frequency controls numbered](/images/generated/admin-billing.png)

Checkout, invoices, payment methods, and cancellation are handled through Stripe. After subscribing, confirm the intended Discord server has an active Guild Assignment before configuring paid features.

See [Compare Plans](/plans) and [Billing and Guild Assignments](/features/premium-entitlements) for details.

## Stale Channels or Roles

The dashboard caches Discord names, channels, roles, and member counts. Gateway events normally keep this current.

When a channel or role is missing or looks outdated, use the dashboard refresh control or open **Troubleshooting** before changing feature settings.

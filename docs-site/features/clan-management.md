---
description: "Manage persistent Discord clans with HAF Bot's beta workflow: staff-reviewed requests, private channels, roles, recruitment and plan-based membership limits."
---

# Clan Management

Clan Management gives a Discord server persistent member teams with a managed role, private text channel, and private voice channel.

Members request a Clan from a public panel. Staff review the request in a private channel, and approval creates the Clan's Discord resources.

::: warning Beta feature
Clan Management is in beta. Report workflow problems through the [HAF Bot Discord](https://discord.gg/HpRPkdm6dv).
:::

::: info Available on every plan
Free supports up to 5 active Clans, 25 members per Clan, and 5 officers per Clan. Paid plans support up to 25 active Clans, have no HAF plan limit on members per Clan, and keep the 5-officer limit.
:::

## What HAF Creates

Clan Management uses:

- one shared category for approved Clan channels;
- one Discord role per Clan;
- one private text channel and voice channel per Clan;
- one private review channel per creation request; and
- an optional public Clan Board entry.

HAF must manage each approved Clan's role and private channels so membership changes stay in sync. The public panel channel, review category, reviewer role, and staff-access roles can be created by HAF or reused from existing Discord resources.

## Quick Setup

Open **Admin Dashboard → Clan Management** for the intended Discord server.

1. Under **Feature resource setup**, create or reuse the Clan category, panel channel, review category, and first reviewer role.
2. Review the proposed names and channel visibility, then confirm the setup plan.
3. Add any additional reviewer, staff-access, or applicant eligibility roles.
4. Configure optional local limits below the plan maximum.
5. Set account age, server tenure, request cooldown, invitation expiry, and application expiry.
6. Enable Clan Management and save.
7. Customize and publish the request panel.
8. Test a full request and review with non-admin accounts.

Saving stores the feature configuration. **Publish panel** creates or updates the public member message.

## Request and Review Flow

A member selects the panel button or uses `/clan request`, then enters:

- Clan name;
- short tag;
- description;
- game or platform focus; and
- initial recruitment state.

Before accepting the request, HAF checks:

- required or blocked roles;
- Discord account age;
- time in the server;
- request cooldown;
- existing Clan membership or pending request; and
- the active-Clan plan limit.

HAF creates a private review channel visible to the requester, configured reviewers, and HAF Bot.

Reviewers can:

| Action              | Result                                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| **Approve**         | Creates the Clan role and channels, makes the requester Owner, and closes the review |
| **Request changes** | Keeps the review open and lets the requester revise the form                         |
| **Reject**          | Records the reason and closes the review                                             |

If the requester submits a new revision while a reviewer has an older version open, HAF refuses the outdated decision.

When Discord fails during setup, the saved request remains available. Staff can resume the incomplete setup rather than asking the member to submit again.

## Clan Ranks

| Rank        | Access                                                                               |
| ----------- | ------------------------------------------------------------------------------------ |
| **Owner**   | Full Clan leadership, including officer appointments and ownership-sensitive actions |
| **Officer** | Routine recruitment and member management                                            |
| **Member**  | Clan role and private channel access                                                 |

A Discord member can belong to only one Clan in the same server.

Clan leadership does not receive general Discord **Manage Roles** or **Manage Channels** permission. HAF performs approved membership changes on their behalf.

## Invitations

Owners and Officers can invite eligible members. Only the Owner can invite someone directly as an Officer.

HAF DMs the invited member, who responds through `/clan manage`. Invitations expire after the configured number of days.

Accepting an invitation:

- creates the membership;
- grants the Clan role; and
- gives access to the Clan channels.

A member who already belongs to another Clan cannot accept.

## Applications

When recruitment is **Applications open**, eligible members can apply with:

- an application message;
- optional experience;
- optional availability; and
- optional play style.

Owners or Officers accept or reject the application. Acceptance grants ordinary Member rank and the Clan role. Applications expire after the configured number of days.

A rejected applicant can be temporarily blocked from immediately attempting to join the same Clan again when the workflow applies a membership block.

## Recruitment States

- **Applications open** — members may submit applications.
- **Invite only** — members join through invitations.
- **Closed** — new applications and invitations are blocked.

Use `/clan manage` to view the current Clan, rank, recruitment state, and pending invitations. Active members can also create a Clan-only LFG from that response.

## Leaving and Leadership

Members and Officers can leave their Clan. HAF removes the Clan role and private-channel access.

The Owner must transfer ownership before leaving. This prevents an active Clan from having no accountable owner.

Only the Owner can appoint Officers or perform ownership-sensitive changes such as ownership transfer, rename, and deletion requests. The exact member-facing controls for every leadership action are still being expanded during the beta.

## Clan Board and LFG

The optional Clan Board publishes one directory entry for each active Clan. It is a public summary, not the source used for membership permissions.

When public LFG attribution is enabled, public posts can show the author's Clan tag.

Clan-only LFG posts:

- are started from `/clan manage`;
- appear in the Clan's private text channel; and
- use the Clan's persistent voice channel.

## Inactivity and Archive

Inactivity automation is disabled by default. When enabled, the default lifecycle is:

- warning after 60 days without tracked activity; and
- archive after 90 days.

HAF stores the latest activity time and broad activity type. It does not store message or voice content for inactivity tracking.

Archiving closes recruitment, removes ordinary member access, removes the public Board entry, and keeps the Clan record and Discord resources available for staff review.

## Deletion

Approved deletion enters a seven-day recovery period before permanent cleanup.

During recovery, recruitment closes and ordinary member access is removed. Permanent deletion then removes active memberships, the Clan role, and its private text and voice channels.

Discord failures can leave cleanup incomplete. Staff should review the dashboard state and retry rather than manually deleting unrelated resources.

## Missing or Damaged Resources

If a managed Clan role or channel is deleted or changed unexpectedly, HAF marks the Clan as needing repair and can temporarily block sensitive management actions.

Use **Review repair plan** to recreate or reconnect the expected resources. HAF does not silently adopt an unrelated role or channel as a Clan resource.

## Troubleshooting

When a panel, review channel, or Clan is not created, confirm:

- Clan Management is enabled;
- the server is below the active-Clan limit;
- a panel channel, review category, and reviewer role are configured;
- HAF can view and create channels in the selected categories;
- HAF has **Manage Roles** and is above the roles it manages; and
- the applicant passes every eligibility rule.

The dashboard's **Creation requests** table shows the saved request state when the Discord review channel is missing or incomplete.

---
description: "Create private Discord support tickets with HAF Bot. Configure intake questions, staff claiming and transcripts, with one panel and type on Free."
---

# Tickets

Tickets create private Discord channels for appeals, reports, questions, and staff support workflows.

::: info Available on every plan
Free includes one panel with one Ticket type and intake questions. Paid plans remove those quantity limits and add advanced automation and controls.
:::

## Set Up Your First Panel

Open **Admin Dashboard → Tickets**. The setup flow can create or reuse the panel channel, private Ticket category, transcript channel, and support role.

![Tickets dashboard with its navigation, panel settings, and publish action numbered](/images/generated/admin-tickets.png)

1. **Ticket settings tabs** — Setup Check, Panel, Types, Rules, and Closed Tickets.
2. **Panel Settings** — member panel, private category, and transcript destination.
3. **Publish Panel** — posts the saved panel or updates its existing message.

For a first working panel:

1. On **Panel**, choose or create the panel channel, Ticket category, and transcript channel.
2. Customize the member-facing title and description.
3. On **Types**, add at least one Ticket type, such as `General support`.
4. Choose the Discord support role for that type.
5. Add intake questions only when staff need the answer before responding.
6. On **Rules**, choose claiming and per-member creation behaviour.
7. Select **Save Changes**, then **Publish Panel**.
8. Resolve warnings or errors under **Setup Check**.

Saving stores the panel configuration. Publishing creates or updates the member-facing Discord message.

## Member Flow

1. A member selects a Ticket type from the published panel.
2. HAF asks the configured intake questions.
3. HAF creates a private channel visible to the member, the selected support role, and HAF Bot.
4. Members and staff discuss the request in that channel.
5. A member or staff member closes the Ticket, or requests closure for confirmation.
6. HAF generates the transcript.
7. After the transcript is saved successfully, HAF deletes the private staff thread and Ticket channel.

If transcript creation fails, HAF leaves the Ticket open so staff can retry. If later cleanup fails after the transcript was saved, HAF records the Ticket as closed and queues or exposes recovery work for the remaining Discord resources.

Test with a non-staff account. Confirm the new channel is private, the correct support role can see it, and closing it creates a transcript in the configured destination before the Ticket channel disappears.

## Ticket Types

Each Ticket type can configure:

- label, internal ID, channel prefix, emoji, and button style;
- support role;
- intake questions, including optional SteamID64 validation;
- optional creator-role restrictions;
- auto-reply or conditional reply behaviour; and
- anonymous support.

Free includes one Ticket type. Creator-role restrictions, auto-replies, conditional replies, anonymous support, AI transcript summaries, and advanced creation-limit controls require a paid plan.

## Creation Limits

A panel can limit how many open Tickets one member may have. Ticket types can also be excluded from that limit where appropriate.

When a member reaches the limit, HAF rejects the new Ticket and shows the configured rejection message. Closing an existing Ticket reduces their open count.

## Staff Commands

| Command                 | Result                                      |
| ----------------------- | ------------------------------------------- |
| `/ticket close`         | Closes the current Ticket                   |
| `/ticket request-close` | Asks the opener to confirm closure          |
| `/ticket claim`         | Assigns responsibility to a staff member    |
| `/ticket history`       | Shows a member's previous Tickets           |
| `/ticket reply`         | Previews and sends a saved Message Template |
| `/ticket add-user`      | Adds a Guild member as a participant        |
| `/ticket remove-user`   | Removes an added participant                |

These commands run inside an active Ticket channel. See [Discord Commands](/commands#tickets) for parameters.

## Ticket Participants

Enable **Allow staff to add participants** on a Ticket type to let its support role and Guild administrators manage access. Added participants can read the existing Ticket history and attachments, see the opener, and send new messages. Participants are not anonymous to each other.

HAF posts only a neutral participant-added or participant-removed message in the Ticket. It does not identify the staff member who ran the command, including when anonymous support is enabled. HAF retains the real staff actor and access history for authorised audit and transcript use.

HAF grants only `View Channel`, `Send Messages`, and `Read Message History` through a member-specific overwrite. It needs Discord permission to edit the Ticket channel. Bots, former Guild members, and the Ticket opener cannot be added or removed through these commands.

## Anonymous Support

When anonymous support is enabled for a Ticket type, HAF creates a private staff thread linked to the Ticket.

Members with the Ticket type's support role and Guild administrators send an anonymous reply by
writing:

```text
!send Your reply to the member
```

HAF posts the content into the member's Ticket channel as the bot rather than exposing the individual moderator's Discord identity. Supported attachments are copied with the reply.

Editing or deleting the original `!send` message updates or removes the matching bot message. Ordinary staff-thread messages without `!send` remain private to staff.

Anonymous support hides the replying moderator from the Ticket member. It does not hide staff activity from HAF's internal Ticket records or authorised staff.

## Transcripts and Closed Tickets

Closing a Ticket produces:

- a text transcript uploaded to the configured transcript channel;
- an HTML transcript link when transcript storage is available;
- a summary embed; and
- an optional AI summary on paid plans when enabled.
- staff-only participant access history in the text transcript.

Staff can find closed records and transcript links under **Closed Tickets** and in the configured transcript channel.

Closed Tickets cannot currently be reopened. The original Ticket channel is deleted after a successful close, so continued discussion requires a new Ticket.

New HTML transcript links have a 30-day access period. Managed transcript archives and attachments have a 365-day retention period and are removed by scheduled cleanup after expiry; a failed cleanup can require a retry. Copies posted to Discord are separate and remain subject to your staff's channel-retention practices. The dashboard does not currently expose self-service transcript deletion or a retention setting. Keep the transcript channel private and use the [privacy support route](https://hafbot.xyz/privacy) for data requests.

## Limits

| Tier         | Panels        | Ticket types per panel |
| ------------ | ------------- | ---------------------- |
| Free         | 1             | 1                      |
| Premium      | No plan limit | No plan limit          |
| Premium Plus | No plan limit | No plan limit          |

Free also includes Ticket claiming, support-role notifications, intake questions, and ordinary transcripts.

## Setup Check

The page-header **Setup check** reads the last saved configuration. The Tickets **Setup Check** tab also contains feature-specific test actions and explains what each action changes.

Neither view includes unsaved edits. Save first. A passing check confirms resources and permissions, but a non-staff member test remains the final proof that privacy and transcripts work as expected.

## Disable ticket entry points

Use the panel menu’s **Unpublish** action to stop new tickets while retaining the panel configuration and existing tickets. Forms opened before unpublishing are rejected when submitted. Publish the panel again to resume. For an individual Ticket Type, use its **More actions (⋯)** menu to disable or enable it, then save. Disabled types retain their settings and existing tickets; their buttons are omitted from the published panel and stale forms cannot create tickets.

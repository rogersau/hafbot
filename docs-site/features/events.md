---
description: "Run Discord event signups with HAF Bot's paid Events feature. Configure rosters, capacity, waitlists, optional roles, threads and reminders."
---

# Events

Events are scheduled community activities with Discord signups. Use Signup Groups for squads, raid roles, teams, volunteer shifts, vendor slots, or any other roster shape.

::: warning Paid feature
Events require Premium or Premium Plus. Saved Events, templates, signups, and reminder settings remain stored but inactive if the server returns to Free.
:::

## Create an Event

Create or choose the Discord channel where the Event will be posted, then open **Admin Dashboard → Events**.

![Events dashboard with event details and scheduling areas numbered](/images/generated/admin-events.png)

1. **Create an event** — enter new details or start from a saved template.
2. **Event title** — the name members see in Discord.
3. **Schedule and signups** — start, end, signup cutoff, and Signup Groups.
4. **Create event** — saves the Event when the required fields are valid.

To create your first Event:

1. Enter the title, description, publish channel, and start time.
2. Add an optional end time and signup cutoff.
3. Add at least one Signup Group, such as `Attending`.
4. Add a capacity only when the group should be limited.
5. Configure an optional thread and reminders.
6. Review the Discord preview.
7. Save the draft or publish it when ready.

Discord displays Event timestamps in each member's local timezone.

## Templates

An Event Template preloads reusable details such as Signup Groups and reminders. Applying a template copies those settings into the Event draft. Editing the template later does not silently change an existing Event.

## Publishing and Editing

Publishing creates the Discord Event message. Publishing an already published Event updates the existing message rather than creating a second one.

You can edit a Draft, Scheduled, or Live Event. Saving changes to a published Event refreshes its Discord message. Ended, Cancelled, and Archived Events cannot be edited.

Changing the publish channel after an Event already has a message may require a replacement workflow; confirm the resulting Discord message before announcing the change.

## Signup Groups

Each Signup Group can have:

- a label and optional emoji;
- an optional capacity;
- an optional waitlist;
- allowed and blocked Discord roles; and
- an optional role granted to confirmed members.

In **single choice** mode, joining another group removes the member from their previous group. In **multi-choice** mode, a member can join more than one group.

Members can join or change signups while the Event is Scheduled or Live and before the signup cutoff. After the cutoff, HAF rejects new signup changes.

## Waitlists

When a capped group is full:

- new members join its waitlist when waitlisting is enabled; or
- HAF reports that the group is full when waitlisting is disabled.

When a confirmed member leaves or is removed, HAF promotes the next waitlisted signup. Promotion updates the Event message and applies the confirmed member's role and thread access.

HAF does not currently send a separate DM for waitlist promotion.

## Event Threads

An Event can create a Discord thread from its published message.

Confirmed members are added to the thread. Waitlisted members are added only when **Waitlisted members join thread** is enabled.

Leaving a group removes the member from the thread when they no longer have a confirmed signup that requires access.

## Granted Roles

A Signup Group can grant a Discord role to confirmed members. HAF Bot's highest role must be above that role.

HAF removes the granted role when:

- the member leaves the group;
- an organizer removes or changes the signup;
- the Event is cancelled; or
- the Event reaches its configured end time.

Archiving is only available after an Event has ended or been cancelled, so role cleanup has already occurred.

## Reminders

Reminders are sent to the Event channel, or to the Event thread when one exists. HAF does not send Event reminders by DM.

A reminder can target:

- a public channel or thread reminder without member mentions;
- confirmed signups;
- waitlisted members;
- confirmed members in selected Signup Groups; or
- the **Not signed up** audience.

Confirmed, waitlisted, and selected-group reminders directly mention the matching members. Public reminders do not mention anyone.

The current **Not signed up** option also posts an unmentioned public reminder. It does not calculate or mention every server member who has not signed up.

Reminder timing is set as a number of minutes before the Event start. Each configured reminder is sent once.

## Recurring Events

Select a saved, published Event with a valid end time, then use **Recurring Events** to choose **Every day** or **Every week**. Optionally set a final start time. Leave it empty to continue until staff stop the series.

The series copies that Event's saved title, description, channel, Signup Groups, team settings, and reminders by value. Each occurrence receives a new Event identity and starts with empty signups, teams, memberships, and reminder history. A template or individual Event edited later does not change the series.

HAF publishes the next occurrence after the preceding Event has ended and completed its role and thread cleanup. Each Event's duration must be shorter than the repeat interval. This prevents the previous occurrence from removing signup access that belongs to the next one. The existing Events lifecycle and signup rules apply to every occurrence.

Before preparing the next occurrence, HAF confirms removal of the preceding Event's signup roles and thread membership. Confirmed member departure or already-absent roles and thread membership count as completed cleanup. Permission, ownership, network or unrecognised provider failures block the series as **Needs review**, even if the preceding Event is already ended, cancelled or archived. Inspect and resolve the old access before starting a new series from a reviewed published Event.

The repeat interval is a fixed UTC day or week. Discord displays local timestamps, but a local start time can shift when daylight-saving offsets change. The final start time is inclusive: no occurrence with a later start is created.

**Stop series** prevents future occurrence creation. Events already created, their signups, and their lifecycle remain unchanged. Cancelling one occurrence does not stop the series; use the separate series control. To change the cadence or frozen settings, stop the old series and start from a new published Event.

While paid access is inactive, HAF retains the series and stops creating occurrences. On recovery it skips missed starts and creates only a future occurrence. It does not replay old signups or reminders.

If publication has an ambiguous result, the series becomes **Needs review** and HAF does not automatically post again. Inspect the generated Event and its Discord channel, resolve any partial publication, then start a new series from a reviewed published Event. Existing occurrence records are retained for staff review.

## Lifecycle

| State         | Meaning                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| **Draft**     | Saved in the dashboard but not published                                          |
| **Scheduled** | Published and waiting for the start time                                          |
| **Live**      | The start time has passed                                                         |
| **Ended**     | The end time has passed and confirmed role/thread access has been cleaned up      |
| **Cancelled** | Closed early by an organizer and confirmed role/thread access has been cleaned up |
| **Archived**  | Hidden from active organizer workflows after ending or cancellation               |

Events without an end time remain Live until an organizer cancels them.

## Current Limitations

- Recurrence supports fixed daily and weekly UTC intervals. Custom calendars and automatic daylight-saving adjustments are not supported.
- Proxy signup is not part of the member flow. Captain-managed Event Team controls are listed in the [command reference](/commands#events-and-event-teams).
- The **Not signed up** reminder currently behaves like an unmentioned public reminder rather than identifying non-signups.

Use **Setup check** after saving to inspect saved publish channels and optional thread permissions. It does not publish an Event or submit a signup.

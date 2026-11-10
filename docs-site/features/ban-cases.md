---
description: "Turn incoming game-server ban reports into HAF Bot staff Forum cases. Configure identifier extraction, secret source URLs and the paid review workflow."
---

# Ban Cases

Ban Cases turn game-server ban webhook messages into one staff Forum thread per player identifier.

::: warning Paid feature
Ban Cases require Premium or Premium Plus.
:::

## What It Does

For each enabled source, HAF:

1. receives a text body at the generated source URL;
2. extracts a player identifier, optional display name, and optional reason with a regex;
3. creates a new staff Forum thread when that player has no existing Ban Case; or
4. appends the new report to the existing thread for that platform and identifier.

Staff can mark a new case **Completed**. Completion updates the first message, disables the completion button, changes the Forum tag when configured, and writes an audit event.

Completed cases cannot currently be reopened through the Ban Cases workflow. A later report for the same player appends to the existing thread without changing its completed status.

## Configure Ban Cases

Create or choose a staff-only Discord Forum and moderator roles, then open **Admin Dashboard → Ban Cases**.

![Ban Cases dashboard with source, extraction, and forum settings numbered](/images/generated/admin-ban-cases.png)

1. **Ban Case Sources** — inbound source URLs for this Discord server.
2. **Source Editor** — source name, platform label, regex, and capture-group names.
3. **Forum Channel** — the private Forum where HAF creates cases.

To configure it safely:

1. Select the private Forum and moderator roles.
2. Enable Ban Cases.
3. Create a source and give it a recognisable name.
4. Choose the platform represented by the extracted identifier.
5. Enter the regex and named capture-group fields.
6. Use **Test configuration** with fictional data.
7. Save the source and review **Setup check**.
8. Copy its generated URL into the game-server tool.
9. Send a harmless live test before connecting production bans.

## Regex Example

Example body:

```text
KXWR.xyz 76561199304898090 got banned on COLDASFK: Cheater
```

Pattern:

```regex
^(?<username>.+?) (?<subjectId>\d{17}) got banned on .+?: (?<reason>.+)$
```

Source fields:

```text
Platform: Steam
Subject ID group: subjectId
Name group: username
Reason group: reason
```

Extracted result:

```text
Player ID: 76561199304898090
Display name: KXWR.xyz
Reason: Cheater
```

The subject group is required. When the optional name or reason group is missing, HAF uses `Unknown` or `No reason provided`.

![Ban Cases local extraction tester with its sample and run action numbered](/images/generated/admin-ban-cases-test.png)

The local tester evaluates the current unsaved pattern. It does not save the source, accept an inbound request, or create a Forum thread.

## Platform Meaning

The selected platform tells HAF how to label and group the extracted identifier. It does not authenticate the sender or verify that the identifier exists on Steam, Xbox, PlayStation, or another platform.

A Ban Case is deduplicated by Discord server, selected platform, and extracted subject ID. Two sources reporting the same platform and ID use the same thread.

## Existing Case Updates

When another report arrives for an existing subject, HAF adds a message containing:

- source name;
- extracted display name;
- platform and player identifier; and
- extracted reason.

The current case status is not changed automatically.

## Source URL Security

Treat each generated source URL as a secret. Anyone with the URL can submit a body while the source is enabled and the server has paid access.

The current Ban Cases endpoint does not validate signature headers, bearer tokens, or a separate shared secret. To revoke an exposed URL, delete the source and create a replacement, then update the game-server sender.

## Response and Failure Behaviour

HAF returns HTTP `204 No Content` for Ban Case POST requests, including bodies that do not match the regex or requests that cannot create a case. This prevents game-server tools from repeatedly retrying a malformed ban event.

As a result, the sender's successful HTTP response confirms only that HAF received the request. It does not confirm extraction or Forum-thread creation.

Use the local tester before enabling the source, then inspect the Forum and audit destination after a live test. Discord creation failures are logged internally but are not currently exposed as a source delivery log or automatic replay queue.

## Completion

Configured moderator roles can select **Mark Completed**.

Completion:

- changes the saved status from New to Completed;
- updates the starter message with the moderator and completion time;
- disables the completion button;
- replaces the New Forum tag with Completed when available; and
- writes a status-change audit event.

It does not delete or archive the Forum thread.

## Current Limits and Gaps

::: warning Authentication and recovery
The generated URL is currently the only inbound authentication. A documented payload-size limit, signature verification, failed-delivery queue, source delivery history, and reopen action are not currently exposed as product features.
:::

## Setup Check

After saving, use **Setup check** to inspect the Forum, moderator roles, required permissions, and enabled sources. It does not accept a webhook or create a Ban Case.

## Experimental WARDOGS server actions

Server actions are separate from Mark Completed. Staff can explicitly request a ban or unban for
one configured target, review the exact SteamID64 from the report, supply a reason, and confirm.
The subject's ownership is not verified by the incoming report. Completed cases can still have
explicit server actions without reopening the case.

This is disabled preparation. A Guild Admin target opt-in and separate HAF operator contract
approval are required; saving a password does not enable enforcement. Acknowledged requests are
pending until server state is verified. Unknown outcomes show **needs-attention** and block
contradictory actions. Staff can cancel only undispatched pending work. HAF never blindly repeats a
command after a lost response, and unsent requests expire after 15 minutes.

---
description: "Configure HAF Bot custom replies and recurring Discord announcements."
---

# Custom Replies and Schedules

Open **Admin Dashboard → Custom Replies and Schedules**. The feature starts disabled and is available on every plan, with up to 50 replies and 10 recurring messages per Guild.

## Custom Replies

Add a reply, choose a unique lowercase command name, enter the message trigger and response, and choose **Exact message**, **Starts with** or **Contains**. Matching ignores case and normalizes Unicode presentation. A response may use `{user}` for the requesting member's mention; responses never send automatic mentions.

Members can also invoke a configured reply with `/custom name:<command-name>`. Set optional allowed channels and required roles. When several required roles are selected, any one is sufficient. The persisted cooldown applies per member and command, across both message and slash invocation.

Replies do not execute scripts or call arbitrary APIs. Use Webhooks for inbound integration and Content Feeds for supported subscriptions.

## Recurring Messages

Choose a destination, message, repeat interval and first publication time in **UTC**. Intervals range from 15 minutes to 30 days. An interval of 10080 minutes repeats weekly at the same UTC time; local daylight-saving time may change.

Selected notification roles are mentioned only for a newly delivered occurrence. Without notification roles, the message cannot notify users, roles or everyone automatically. Missed intervals are skipped. Saving configuration cancels queued deliveries from the prior configuration and does not backfill old occurrences.

Each occurrence has one durable identity. Delivery retries reuse the same Discord nonce and stop after three attempts or four minutes, rather than replaying uncertain old announcements. Recent delivery status appears on the feature page. Correct a destination or permissions error before the next occurrence.

Enabling the feature does not create roles or channels. Existing destinations must belong to the selected Guild and allow HAF to view and send messages. Pausing or removing a schedule does not delete already posted Discord messages.

---
description: "Limit reactions per Discord message and member with HAF Bot. Learn breach counters, notifications, temporary roles and how to test enforcement safely."
---

# Reaction Limits

Reaction Limits are available on every plan as part of [Reaction Rules](/features/reaction-rules). They remove reactions when a message or member exceeds the configured limits.

## The Two Limits

### Maximum reactions per message

Counts every reaction added to the same message by all members.

When the total goes above the limit, HAF removes the newly added reaction. This limit controls crowded messages but does not increase a member's breach count by itself.

### Maximum reactions per user per message

Counts reactions added by one member to the same message.

When that member goes above the limit, HAF removes the newly added reaction and records a breach for that member.

## Worked Example

Configuration:

- Maximum reactions per message: `20`
- Maximum reactions per user per message: `3`
- Breach threshold: `2`
- Breach role: `Reaction Timeout`
- Breach role duration: **10 minutes**

Result:

1. A member's first three reactions on a message remain.
2. Their fourth reaction is removed and their breach count becomes `1`.
3. A later over-limit reaction, on the same or another message, is removed and raises their breach count to `2`.
4. HAF assigns the `Reaction Timeout` role for 10 minutes and resets that member's breach count.
5. Separately, any reaction that takes a message above 20 total reactions is removed, even when that member has not exceeded their personal limit.

## Configure Reaction Limits

Open **Admin Dashboard → Reaction Rules → Limits**.

You can configure:

- channel include or exclude scope;
- maximum reactions per message;
- maximum reactions per user per message;
- the number of personal-limit breaches before a role is assigned;
- the breach role and optional duration;
- a DM sent on each personal-limit breach; and
- controls for resetting stored counters.

The duration picker accepts minutes, hours, days, or permanent. HAF Bot's highest Discord role must be above the breach role.

## Counter Behaviour

Reaction counters are stored rather than using a rolling time window.

- Message and member/message counts continue until the relevant counters are reset.
- Removing an over-limit reaction does not subtract the recorded attempt.
- The member's breach count increases only when they exceed the per-user limit.
- After HAF assigns the configured breach role, that member's breach count resets to zero.

Use the dashboard reset controls when changing limits or when old counts should no longer affect enforcement.

## DMs and Role Assignment

When breach DM text is configured, HAF attempts to DM the member on every personal-limit breach. The reaction is still removed when the member has DMs disabled.

The breach role is assigned only when all of these are configured and reached:

- a breach threshold;
- a breach role; and
- enough personal-limit breaches.

Selecting a duration makes the breach role expire automatically. Selecting permanent leaves it in place until staff or another workflow removes it.

## Test Safely

Use a private test channel and a non-admin account. Confirm:

- reactions within each limit remain;
- the first reaction above a limit is removed;
- personal breaches increase the breach counter;
- the DM is sent when configured; and
- the breach role is assigned and later removed when a duration is set.

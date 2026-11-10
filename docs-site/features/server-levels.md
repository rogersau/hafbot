---
description: "Award Server XP for confirmed DayZ attendance through CFTools with HAF Bot's paid beta. Configure Steam linking, low-population scoring and leaderboards."
---

# Server Levels

Server Levels awards Discord-server progression from verified attendance on configured DayZ servers.

::: warning Paid beta
Server Levels requires Premium or Premium Plus and currently supports up to five CFTools Hephaistos-connected DayZ servers per Discord server.
:::

## Before You Start

You need:

- Steam configured under **Player Link**;
- a paid Guild Assignment;
- access to CFTools Hephaistos for each DayZ server; and
- permission to manage the Discord server in HAF.

Open **Admin Dashboard → Server Levels (Beta)**. Enable the feature and add a Configured Game Server. HAF then gives that server a unique webhook URL.

## CFTools Webhook Setup

For each Configured Game Server, open that CFTools Cloud server's **Manage → Integrations** page and create a webhook with:

- the webhook URL shown by HAF;
- payload format **CFTools Cloud (Hephaistos v1)**; and
- the `user.join`, `user.leave`, `server.restart`, and `server.shutdown` events.

After CFTools deploys the webhook, copy the provider-issued **Secret** into the matching server card in HAF. HAF encrypts the secret and never returns it. Hephaistos delivery IDs and signatures are verified before a provider fact is accepted.

Once all four event subscriptions are selected in CFTools, choose **Confirm required events configured** on the server card. Subscription readiness starts unverified for every new server; HAF does not assume the events were selected merely because the endpoint was created.

HAF marks the endpoint verified after the first accepted webhook. Native Hephaistos signatures authenticate the delivery ID. HAF also stores a SHA-256 digest of the exact bounded request body, so replaying the same signed delivery ID with changed facts is rejected. Events are held briefly so normal out-of-order delivery can be processed in event-time order. Requests with an invalid secret, unsupported event, oversized body, invalid JSON, or mismatched server identity are rejected.

If CFTools rotates its secret, paste the replacement into HAF. Saving it invalidates the prior value immediately.

## Optional Data API Reconciliation

You can also connect a CFTools Data API application on each server card. This is optional: signed webhooks remain the source of XP facts. The API connection helps recover a safe current roster after a missed lifecycle event without awarding the unknown gap.

Create a CFTools application, grant it read access to only the matching server, then paste its application ID and secret into HAF. HAF encrypts both values and its short-lived access token. The integration has a fixed read-only allowlist:

- server information;
- the Game Server Manager current-player list; and
- public server status for population, queue, and slot capacity.

HAF does not call CFTools mutation routes. Roster and public population must agree before a snapshot is accepted. A provider outage or inconsistent response leaves attendance and progression unchanged. Reconciliation establishes a new checkpoint at the observation time, so it never backfills uncertain attendance. Capacity changes appear as admin proposals and do not change scoring until an admin accepts them.

## Who Earns Server XP

A player earns only while all of these remain true:

- Server Levels is enabled and the Discord server has paid access;
- the Steam account is actively linked through the canonical Steam Platform Link;
- the linked Discord user is a current member of this Discord server; and
- the attendance is confirmed by accepted provider events.

There is no backfill. Enabling the feature, restoring paid access, joining Discord, or linking Steam starts eligibility only for future confirmed attendance. If Steam is linked during trusted current presence, earning begins at the link timestamp. Leaving Discord, unlinking, disabling or removing the feature, losing paid access, removing a server, or a server restart/shutdown closes affected earning sessions.

If one member has overlapping sessions across multiple linked Steam accounts or configured servers, only their highest current earning rate applies. Overlap does not stack.

## Scoring

HAF awards one base XP per minute using fixed-point accounting, then applies the highest occupancy band active during that interval:

| Occupancy                         | Multiplier |
| --------------------------------- | ---------- |
| More than 0% through 25%          | 4×         |
| More than 25% through 50%         | 3×         |
| More than 50% through 75%         | 2×         |
| More than 75%                     | 1×         |
| Any trusted non-empty login queue | 1×         |

Occupancy uses the configured maximum slots. If CFTools reports a different capacity, the dashboard flags a proposal for admin review instead of silently changing scoring.

An open session without a later trusted confirmation stops earning after 12 hours. A maximum of 12 unique qualifying hours in any rolling 24-hour window also limits provider noise or missed leave events. Server restart and shutdown events close every open session for that server.

Level thresholds follow a quadratic curve: level `L` requires `100 × (L − 1)²` total Server XP. Level-up announcements are optional and are delivered through a retry-safe outbox.

## Member Commands

| Command                    | Result                                     |
| -------------------------- | ------------------------------------------ |
| `/serverlevel profile`     | Shows Server XP, level, and progress       |
| `/serverlevel leaderboard` | Shows current-member leaders for the Guild |

`/serverlevel profile` accepts an optional current member. Replies are public but aggregate all eligible configured servers and linked Steam accounts without exposing raw Steam IDs, provider payloads, or per-server attendance history.

## Disabling, Removal, and Privacy

Disabling closes open earning sessions and preserves configuration and progress. A paid-plan lapse makes processing dormant; restoring access resumes only future activity.

Removing Server Levels closes sessions immediately and schedules the Guild's Server Levels data for deletion after 30 days. Raw interval awards are compacted into daily summaries after 90 days while totals remain unchanged. Personal erasure removes that member's progression, awards, sessions, and pending announcements without exposing another member's data.

Provider webhook payloads and operational identifiers are restricted to internal processing. Public profile and leaderboard views contain only aggregate progression for current members.

## Troubleshooting

- **Awaiting webhook:** confirm the URL, Hephaistos v1 payload format, provider-issued Secret, and required subscriptions in CFTools, then generate a new join/leave event.
- **No XP:** confirm paid access, Steam Platform Link setup, current Discord membership, and that trusted attendance occurred after the link timestamp.
- **Capacity warning:** compare the observed value with the real playable slot limit before updating the configured capacity.
- **API pending:** confirm the CFTools application has read access to this server. Disconnecting the optional API does not stop signed webhook processing.
- **Secret changed:** copy the current provider-issued Secret from CFTools into HAF; HAF cannot reveal the prior plaintext value.

See the [CFTools developer overview](https://cftools.com/developers) for provider-side integration resources.

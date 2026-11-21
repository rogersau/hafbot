# WARDOGS player stats and Gold Exchange data

Checked on 21 November 2026. WARDOGS Tracker documents a public player-stats API and a separate
player-authorized sync. WARDOGS Server List documents a keyed API for the daily cash price of one
gold bar. Both are community services. [Tracker developer docs](https://wardogstracker.gg/developers)
· [Server List API](https://wardogserverlist.com/api)

## How trackers get player stats

1. **Steam verifies the player’s identity.** Standard Steam OpenID returns a verified SteamID64.
   HAF Bot already implements this in Player Link. The SteamID is enough to join a Discord member to
   an existing public tracker profile. [Valve authentication docs](https://partner.steamgames.com/doc/features/auth#website)
   · [HAF Bot Steam OpenID code](../src/services/steam-openid.ts)
2. **The tracker reads progression through a WARDOGS game session.** WD Stats says the game’s login
   service verifies Steam’s signed proof and starts a game session. WARDOGS Tracker says it reads the
   player’s progression from WARDOGS game servers and keeps the session encrypted for about three
   hours, refreshing roughly every 15 minutes. Both tell players to close the game before syncing.
   The exact proof format and game endpoints are undisclosed in those docs. No official public
   Bulkhead developer API for career progression was found. [WD Stats sign-in](https://wdstats.co.uk/signin)
   · [Tracker privacy policy](https://wardogstracker.gg/privacy) · [Tracker Connect docs](https://wardogstracker.gg/developers/connect)
3. **Bots can serve the resulting snapshots.** WARDOGS Tracker publishes level, career XP, role
   progression, unlocks and any visible cash and gold holdings. Its public endpoints look up a
   previously synced profile by SteamID64 or by the Discord account the player linked with the
   tracker. Private or missing profiles can return `404` and an unsynced profile can have `stats: null`.
   WarBot exposes career stats in Discord. Its community-server K/D and other match stats come from
   connected servers. [Tracker Stats API](https://wardogstracker.gg/developers/stats)
   · [WarBot](https://wardogstracker.gg/warbot)

Vinitive’s public tracker repository illustrates the flow. It independently verifies account ownership
via Steam OpenID and reads public career data from WARDOGS Tracker. WD Stats and FOBDROP also expose
APIs for profiles previously shared through their respective services. [Vinitive source](https://github.com/Vinitive/Wardogs-Tracker#steam-account-linking)
· [WD Stats API](https://wdstats.co.uk/developers) · [FOBDROP API](https://fobdrop.com/developers/)

## How trackers get gold prices

The Gold Exchange has one game-wide rate in in-game cash per gold bar. The rate rolls over at 00:00
UTC. Bulkhead describes the exchange in its Early Access devlog. WARDOGS Server List says it reads
the rate from the game backend hourly, checking every five minutes in the first UTC hour until it
has the new day’s price. Wardogs.tools also says it reads the live game. WARDOGS Tracker publishes
its own daily observations and WarBot posts them in Discord. Its developer API omits the rate.
[Bulkhead devlog at 2:33](https://www.youtube.com/watch?v=PQvtvAvl-78&t=153s)
· [Server List gold history](https://wardogserverlist.com/gold-bars) · [Wardogs.tools gold history](https://wardogs.tools/gold)
· [Tracker gold history](https://wardogstracker.gg/database/gold-price) · [Tracker API scope](https://wardogstracker.gg/developers)

WARDOGS Server List explicitly offers the data for reuse via `GET /api/gold-bars`. It documents
`latest.ts` as the UTC day in epoch milliseconds, `latest.price` as the cash price, `checkedAt` as
when the operator last checked, and `points` as the historical day-price pairs. A free key from the
operator’s account page goes in `X-API-Key`. The API terms require visible attribution for the
collected statistics. No official Bulkhead price feed was found. [Gold history and reuse](https://wardogserverlist.com/gold-bars)
· [OpenAPI schema](https://wardogserverlist.com/openapi.json) · [API terms](https://wardogserverlist.com/terms)

The `gold` field in player stats counts bars the player owns. Shop feeds such as itemshop.gg expose
cosmetic prices in bars. The rate feed supplies the cash cost of acquiring one bar. [Tracker Stats API](https://wardogstracker.gg/developers/stats)
· [itemshop.gg shop API](https://itemshop.gg/wardogs/api) · [Server List gold API schema](https://wardogserverlist.com/openapi.json)

## Implications for HAF Bot

- **Public career stats.** Use the linked SteamID64 with WARDOGS Tracker’s keyless
  `GET /api/v1/players/{steamId}`. Credit the tracker, show `syncedAt`, and handle profiles that are
  unavailable, private or still awaiting their first sync. HAF Bot’s existing WARDOGS game-server read
  contract covers server capabilities, status and roster. [Tracker Stats API](https://wardogstracker.gg/developers/stats)
  · [HAF Bot game-server contract](../src/wardogs/model.ts)
- **Opt-in game sync.** If players need to start a sync from HAF Bot, Tracker Connect documents a
  registered callback and one-time code exchange. The Connect API can return fields the player hides
  on their public tracker profile, so those results need separate handling from public command output.
  The saved snapshot stays available after the session expires. It refreshes while the session lasts
  and after a new sign-in.
  [Tracker Connect docs](https://wardogstracker.gg/developers/connect)
- **Gold price.** A shared fetch from WARDOGS Server List can serve all guilds. Display the UTC price
  date with the amount so a delay after rollover is visible. Player account linking is unnecessary
  for this feed. [Server List API](https://wardogserverlist.com/api) · [Gold API schema](https://wardogserverlist.com/openapi.json)

Read-only checks returned HTTP 200 for WARDOGS Tracker’s OpenAPI document and public leaderboard.
WARDOGS Server List’s OpenAPI document returned HTTP 200 and the gold endpoint returned
`401 api_key_required` without credentials. The authenticated gold JSON and player sign-in flows
remain untested. [Tracker OpenAPI](https://wardogstracker.gg/api/v1/openapi.json)
· [Server List OpenAPI](https://wardogserverlist.com/openapi.json)

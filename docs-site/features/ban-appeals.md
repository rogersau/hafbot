---
description: "Accept private Discord ban appeals through HAF Bot, verify the appellant's Discord account and current ban, and review requests with explicit reject or unban actions."
---

# Discord Ban Appeals

Discord Ban Appeals lets banned members request staff review without rejoining the server. It is separate from game-server Ban Cases and Tickets.

Appeals start disabled. Open **Admin Dashboard → Chat Moderation → Discord ban appeals**, configure the public title and instructions, then enable and save. HAF needs **Ban Members** to verify bans and remove an approved ban.

Use **Open public appeal page** to get the server's `/ban-appeals/<server-id>` link. Share that link through the community's existing rules, website or ban-notification process. HAF does not post submissions or decisions to public Discord channels.

## Member flow

1. Open the server's public appeal page.
2. Select **Sign in with Discord** and use the banned account.
3. Submit 20–4000 characters explaining why staff should review the ban.
4. Return to the same page to view the appeal's status.

The form uses the Discord identity from the signed-in session. It does not accept a typed user ID or require current server membership. HAF verifies that the signed-in account is currently banned before recording a new appeal.

Only one appeal per account and server can remain open. Repeated submission of the same request does not create another appeal. The configurable cooldown is one hour to 30 days and starts when an appeal is submitted; rejecting an appeal does not reset it. The default is seven days.

The appellant can see their own latest submission and the final outcome. Original Discord ban reasons, reviewer identities and staff decision notes remain private.

## Staff review

Open the private **Appeal review queue**, select a member and read the submission. Add a private staff reason before choosing:

- **Approve and unban** — explicitly removes the Discord ban. The member still needs an invitation to rejoin.
- **Keep ban and reject** — closes the appeal while retaining the current ban.

The dashboard's existing Guild authorization applies to all appeal configuration, list, detail and review routes. Reviewers must also currently belong to the Discord server. Unbanning requires the reviewer's current Discord **Ban Members** permission or server ownership; rejection requires **Manage Server**, **Ban Members** or server ownership. HAF checks its own current **Ban Members** permission before either decision.

Saving stale settings or reviewing a changed appeal is rejected rather than replacing another staff member's changes. Decisions and unban attempt identities are retained.

## Uncertain unban results

If Discord removed the ban but the response or final storage update was interrupted, **Check unban result** verifies the current ban and completes the original recorded outcome. It does not send a second removal.

If the ban remains after an uncertain request, HAF does not automatically repeat it: a later ban could be a separate staff decision. Inspect Discord, then explicitly reject the still-banned appeal or finish the intended unban in Discord and check the result again. A confirmed Discord rejection, such as missing permissions, returns the appeal to Awaiting review so staff can correct the problem and submit a new explicit action. Prior operation records remain intact.

Disabling new appeals preserves submitted requests and still allows authorised staff to finish their reviews. A service suspension stops appeal submission and moderation effects.

The implementation follows Discord's [Get Guild Ban](https://docs.discord.com/developers/resources/guild#get-guild-ban) and [Remove Guild Ban](https://docs.discord.com/developers/resources/guild#remove-guild-ban) APIs.

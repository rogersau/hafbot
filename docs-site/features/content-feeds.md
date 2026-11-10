---
description: "Share new Twitch streams, YouTube videos, Reddit posts and RSS updates in Discord with HAF Bot."
---

# Content Feeds

Open **Admin Dashboard → Content Feeds**. The feature starts disabled and supports up to ten subscriptions per Guild on every plan.

For each subscription choose a destination, an optional notification role, and a source:

- **RSS or Atom:** a public HTTPS syndication URL.
- **YouTube:** the channel's `UC…` channel ID.
- **Reddit:** the subreddit name without `r/`.
- **Twitch:** the channel's login name. This provider is available only after the HAF operator configures its Twitch application credentials.

Sources are checked about every five minutes. A new or changed subscription first records the current content without posting historical items. Later checks post at most three new items, with a persistent identity preventing repeated notifications. Provider failures preserve the last successful state. Pausing or editing subscriptions does not delete existing announcements.

Public feed requests require HTTPS on port 443, bounded responses, deadlines and public IPv4 DNS results pinned to the actual TLS connection. Private addresses and unsafe redirects are rejected. Some publishers block automated syndication requests; HAF cannot guarantee a publisher's availability.

Notification roles are opt in. Other message mentions are suppressed. Discord delivery is bounded and stale queued announcements are not replayed. Recent delivery status is shown on the feature page.

## Operator Setup for Twitch

Provision `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` manually in the VPS's private environment file or the existing private environment loader. Both must contain 20–128 letters or digits. Empty values leave Twitch unavailable; a partial or malformed pair fails at the runtime boundary without logging its values. Never place these credentials in Guild settings, source code or release evidence.

Restart the verified application image with the updated private environment. Validate provider availability by credential names only. Do not enable subscriptions for a Guild without its administrator choosing the channel and source.

The implementation uses the [Twitch app-token flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow) and [Get Streams API](https://dev.twitch.tv/docs/api/reference/#get-streams). It requests no broadcaster account permissions.

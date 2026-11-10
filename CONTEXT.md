# HAF Bot

HAF Bot, short for Helpful as F\*\*K, is a Discord community management system. It combines Moderation, Community Management, Access Control, identity integrations, staff evidence, audit, billing, and seller-scoped Commerce through one bot.

`CONTEXT.md` defines the product vocabulary and stable cross-feature rules. Feature behavior belongs in the owning feature documentation; architecture and release decisions belong in ADRs and runbooks.

## Onboarding vocabulary

**Onboarding Orchestrator:**
A cross-feature Guild-admin workflow that recommends and sequences feature-owned setup from an administrator's Onboarding Goal. It reads canonical eligibility and Feature Readiness, launches feature-owned setup, and records no feature configuration itself.
_Avoid:_ "central setup wizard" (implies ownership of feature rules), "provisioner" (Feature Resource Setup owns Discord resource work), using "onboarding" for Member Verification

**Onboarding Goal:**
The administrator-selected community outcome used to rank relevant HAF features, such as protecting the community or running member support. A goal is recommendation context rather than saved Guild configuration.
_Avoid:_ "feature category" (one feature may serve several goals), "setup template" (a goal does not own defaults)

**Feature Readiness:**
A feature-owned diagnostic result describing whether its saved configuration and required Discord resources are ready to operate. It is authoritative for the feature's readiness criteria; the Onboarding Orchestrator only reads and presents it.

**Feature Onboarding Contract:**
A feature-owned declaration of its Onboarding Goal relevance, availability posture, setup entry, expected effort, defaults posture, Feature Readiness source, and Onboarding Verification. The declaration exposes orchestration metadata without transferring feature rules to the Onboarding Orchestrator.
_Avoid:_ "onboarding config" (not Guild configuration), "wizard definition" (guided UI is optional), "feature manifest" without qualification

**Onboarding Verification:**
A feature-owned safe test or observable Discord artifact that demonstrates the configured feature can deliver its intended outcome. Verification is evidence of a first success, not a replacement for Feature Readiness or ongoing diagnostics.
_Avoid:_ "setup check" (readiness diagnostics may pass without exercising an outcome), "health check" (ongoing operational meaning), "activation" (a distinct feature lifecycle action)

**Feature Resource Setup:**
A Guild-admin workflow in which a feature declares the Discord resources it needs and the administrator explicitly chooses to reuse an existing resource or have HAF create a recommended one. Feature Resource Setup is executed through a durable Setup Run and reports readiness separately from whether the feature is enabled.
_Avoid:_ "onboarding wizard" for the feature-owned workflow (the future onboarding wizard only orchestrates these workflows), "resource wizard" (loses feature ownership), "auto setup" (creation requires explicit choices and confirmation)

**Setup Run:**
The durable, resumable execution of one feature's confirmed resource plan for one Guild. A Setup Run records ordered dependency choices, successful resource resolutions, partial failures, provenance, and terminal status; successful resources are retained rather than automatically rolled back.
_Avoid:_ "setup transaction" (Discord cannot make the operations atomic), "provisioning job" (a Setup Run includes reuse and administrator decisions), "wizard session" (the UI is not authoritative)

**Resource Relationship:**
The lifecycle contract between HAF and a Discord resource resolved by Feature Resource Setup. Exactly one of **Referenced** (administrator-owned existing resource), **HAF-configured** (created or explicitly repaired by HAF but administrator-owned afterward), or **HAF-managed** (feature-owned projection reconciled through HAF).
_Avoid:_ treating "created by HAF" as synonymous with HAF-managed, "ownership flag" (the relationship carries behavioural rules)

## Language

**Self-hosted Installation:**
An independently operated HAF deployment whose operator supplies the Discord application, data
storage, infrastructure and optional provider services. Core feature access does not require a HAF
hosted subscription; existing resource, provider and safety limits still apply.
_Avoid:_ "White-Label Bot" (a distinct hosted subscription capability), "Free plan" for self-hosting

**Custom Reply:**
A Guild-owned response invoked by a configured member-message trigger or by the Custom command. Channel eligibility, required roles and the member's command cooldown apply to either invocation.

**Reaction Roles:**
A Guild-owned set of self-service Discord role panels. Members select roles through the published panel's choices, subject to the panel's eligibility conditions and HAF's role-safety rules.

**Reaction Role Panel:**
One published or draft message offering a dedicated set of roles. A panel allows either independent multiple selection or one choice at a time; separate panels do not offer the same role.

**Recurring Message:**
A Guild-owned announcement published at a fixed interval from a chosen start time. Each occurrence is distinct; missed occurrences are skipped rather than replayed.

**Chat Rule:**
A Guild-owned automated rule for ordinary message content or message rate. Its configured warning, deletion and violation-window timeout policy is independent of Reaction Rules, Image Rules, Mention Protection and Bot Defense.

**Staff Moderation Case:**
A private Guild record of a staff Discord moderation action, a Chat Rule violation or a member report. A member report is an allegation, not a confirmed violation or automatic penalty.

**Content Feed:**
A Guild-owned subscription that announces new items from a supported external content source to a selected Discord channel. Creating or changing a subscription establishes a new baseline rather than announcing historical content.

**Reputation:**
Guild-scoped recognition awarded by one current member to another for helpful contributions. Reputation is separate from attendance-derived Server XP.

**Reputation Award:**
One member's recorded thanks to another, subject to eligibility and a giver cooldown. Repeated delivery of the same request never awards additional points.

**Reputation Reward:**
A dedicated Discord role granted when a current member reaches a Guild-configured Reputation threshold. Reputation does not grant privileged roles or roles owned by another HAF feature.

**Ban Appeal:**
A banned Discord account's authenticated request for Guild staff to review its ban. Submitting an appeal never grants access or removes a ban; staff make an explicit decision.

**Event Series:**
A recurring schedule that creates independent Event occurrences from a saved configuration. Each occurrence owns its own signups, teams and reminders. Stopping the series leaves existing occurrences intact.

**Moderation:**
Automated rule enforcement within a Guild. In this system, the umbrella of **Reaction Rules**, **Image Rules**, **Bot Defense**, **Mention Protection**, and **Chat Rules** — the rule-enforcement features the bot applies automatically to Discord content. Manual staff action (Evidence Vault hide, Suggestions adjudication) is not **Moderation**.
_Avoid:_ Using "moderation" to describe LFG, Marketplace, Tickets, or Timed Roles. Use **Reaction Rules** for the umbrella, not Blocklist.

**Reaction Rules:**
The umbrella feature for controlling emoji and reaction behaviour in a Guild. It comprises the **Blocklist** (which emojis are forbidden) and the **Reaction Limit** (how many reactions a member may add). A Guild's Reaction Rules config may contain either or both rule types.
_Avoid:_ "blocklist" when referring to the overall feature (use "Reaction Rules"), "emoji control"

**Reaction Rule:**
One rule type under **Reaction Rules**: a **Blocklist** or the **Reaction Limit**. It is not the umbrella feature.

**Image Rules:**
A per-Guild configuration that instructs the bot to inspect image attachments on `MESSAGE_CREATE` in its target channels, classify each image against a configured topic, and act on the **Image Rule Verdict**. A Guild configures zero or one Image Rules; the config comprises the **enabled** toggle, the target channel list, the topic description, the excluded role list, the confidence thresholds, the **Image Rules Mod Queue** channel, and the **Image Rules Mod Role(s)**. A peer of **Reaction Rules** under **Moderation**.
_Avoid:_ "image filter" (singular — there is one config, but it can apply to many images), "image moderation" (overlaps with the umbrella), "AI filter" (implementation detail)

**Image Rule Verdict:**
The classifier's per-image outcome under **Image Rules**. In normal mode, **On-Topic** passes, **Off-Topic** deletes the message, and **Uncertain** deletes the message and posts a reviewable item to the **Image Rules Mod Queue**. The verdict is determined by two per-Guild thresholds: an `auto_delete_threshold` (`T_off`, default 0.85) and a `mod_review_threshold` (`T_on`, default 0.65). `off_topic_confidence ≥ T_off` yields **Off-Topic**; `on_topic_confidence ≥ T_on` yields **On-Topic**; everything in between yields **Uncertain**. A dry run may classify and audit without those side effects.
_Avoid_: "result" (overlaps with the API result type), "decision" (sounds human-driven), "classification" (overlaps with the classifier's output)

**Mod Queue:**
A per-Guild, per-feature pattern for staff adjudication of bot actions: a Discord channel where the bot posts a reviewable embed for each item that needs human review, with feature-specific action buttons gated by the feature's mod role(s). Each feature defines its own action set, embed content, triggering events, and terminal states. Distinct from the **Guild Audit Log** and feature-specific audit channels, which are write-only records rather than review surfaces.
_Avoid:_ "mod log", "review channel", "audit channel" (audit channels are write-only), "moderation queue" (collides with the umbrella term)

**Mod Queue Channel:**
The configured Discord channel that hosts one feature's **Mod Queue**. It is a review surface, not a generic audit destination; each feature owns its channel payload and action permissions.

**Clan Management:**
A Guild-scoped community-management feature for persistent member teams. D1 is authoritative for identity, membership, leadership, lifecycle, and ownership of the Discord resources HAF creates.
_Avoid:_ "clan bot", "team management" (loses the product boundary)

**Clan:**
A persistent team belonging to exactly one Guild, with one owner, up to five officers, ordinary members, one HAF-managed Discord role, and private text and voice channels. A member belongs to at most one Clan in a Guild.
_Avoid:_ "group" (LFG groups are temporary), "cross-server clan"

**Clan Request:**
A member-authored proposal for a Clan identity and recruitment posture that must be approved by a Clan Reviewer before provisioning. Requested changes remain the requester's responsibility.
_Avoid:_ "clan application" (a Clan Application is a request to join an existing Clan)

**Clan Request Mod Queue:**
The Clan Management Mod Queue where Clan Reviewers approve, reject with a reason, or request changes to Clan Requests and reviewed lifecycle requests.
_Avoid:_ "clan audit channel", "request log"

**Clan Reviewer Role(s):**
The configured Guild roles allowed to review Clan Requests and sensitive lifecycle changes. **Guild Admins** are the fallback when no reviewer role applies; reviewer authority does not imply access to private Clan channels.
_Avoid:_ "clan mod" (ambiguous), "staff access role" (a separate permission)

**Clan Owner:**
The single accountable leader and active member of a Clan. Owner-only powers include officer changes, identity requests, accepted ownership transfer, and deletion requests.

**Clan Officer:**
An active Clan Member who can handle routine recruitment, ordinary-member removal, recruitment state, and profile settings without Discord role or channel management permissions.

**Clan Member:**
An active Guild member whose membership is recorded by HAF and projected through the Clan Role. Discord role assignment alone never creates Clan membership.

**Clan Role:**
The one HAF-created Discord role used to project ordinary private-channel access for every member of a Clan. Internal owner and officer rank remains in HAF rather than separate Discord roles.

**Clan Board:**
An optional Guild-configured Forum or text-channel projection with one complete, HAF-managed entry per active Clan. Discord channel permissions alone determine Board visibility.

**Clan Application:**
A Guild member's pending request to join an applications-open Clan, decided by its owner or an officer and expiring after the configured period.

**Clan Invitation:**
A Clan leader's invitation that grants no membership or access until the recipient accepts it. Invitations expire after the configured period.

**Clan Membership Block:**
A temporary, Clan-specific prohibition on a member joining, carrying an actor, reason, and expiry. **Guild Admins** may lift it with a reason.

**Clan Degraded State:**
The explicit state or delivery diagnostic recorded when authoritative Clan data and a Discord resource projection drift or an external operation remains incomplete. Ambiguous drift is never silently imported or reversed.

**Clan Archive:**
A reversible, reviewed inactive lifecycle in which recruitment closes, the Board entry is removed, and ordinary text sending and voice access stop while records and managed resources are retained.

**Clan Plan Dormancy:**
The lifecycle applied to Clans beyond a Guild's effective quantity limit. A dormant Clan cannot be used by members, while its authoritative data and managed resources remain retained; reactivation is explicit and cannot silently exceed the current limit.

**Clan Reconciliation:**
Bounded, resumable comparison of D1 authority with Discord projections, triggered by relevant Gateway events and periodically as a safety net. Ambiguous differences create repair choices.

**Clan-only LFG:**
An LFG post created by an authorised Clan Member in the Clan's private text channel that uses its persistent voice channel and the normal LFG lifecycle without creating temporary voice resources.

**Mod Queue Item:**
A single reviewable post in a **Mod Queue Channel**, materialised as a Discord embed carrying the context the mod needs to adjudicate and the **Mod Queue Action**s available for the relevant feature. For **Image Rules**, each item is created on an **Uncertain** verdict and edited in place to a terminal state (Approved / Restored / Restore Failed) when a mod acts; subsequent items are independent.
_Avoid:_ "queue entry" (sounds infra), "review ticket" (overlaps with Tickets), "report" (overlaps with the Discord reporting feature)

**Mod Queue Action:**
A feature-specific staff action taken on a **Mod Queue Item**. Each feature defines its own button set, permissions, terminal states, and delivery behavior. **Image Rules** uses **Approve Deletion** and **Restore Message**; **Bot Defense** uses **Confirm Bot** and **Dismiss**. Actions disable that item's buttons and do not DM the original user.
_Avoid:_ "review action" (vague), "queue operation" (sounds infra), "mod action" (overlaps with general mod workflow)

**Image Rules Mod Queue:**
The specific **Mod Queue** used by **Image Rules**. Posts one reviewable embed per **Uncertain** verdict, each carrying the original image, the original author, the original message link, the verdict + confidence, the timestamp, and the available **Mod Queue Action**s (Approve Deletion, Restore Message). Configured per-Guild by channel ID.
_Avoid:_ "the mod queue" without qualifier when more than one feature has one, "Image Rules review channel"

**Image Rules Mod Role(s):**
The Discord role(s) granted permission to take **Mod Queue Action**s in the **Image Rules Mod Queue**. A Guild can configure zero or more roles in the Image Rules config. If zero are configured, only **Guild Admins** can take Mod Queue Actions. Mirrors the multi-role selection pattern used by **Evidence Vault Access Roles** and **Suggestion Mod Role(s)**.
_Avoid:_ "Image Rules moderator role" (singular implies one role), "Image Rules admin role"

**Bot Defense:**
A per-Guild **Moderation** feature that detects automated accounts by observing member message behaviour and raising a **Bot Flag** for staff review. Comprises the all-plan **Honeypot Detector** and paid-plan **Rate Detector**. A Guild's Bot Defense config is the union of these plus each detector's independent warn/delete response, a shared **Bot Defense Excluded Role(s)** set, the **Bot Defense Mod Role(s)**, and the **Bot Defense Mod Queue** channel. A peer of **Reaction Rules** and **Image Rules** under **Moderation** — the third umbrella. Bot Defense may warn the member and/or delete a detector's triggering message, but a confirmed flag records the decision only and never bans, kicks, times out, or changes the member's roles.
_Avoid:_ "spam filter" (overlaps with future flood detection and with the Blocklist's "spam filter" avoid-term), "anti-bot" (too generic), "bot detection system" (the umbrella name is Bot Defense), "moderation" when referring to Bot Defense specifically (it _is_ Moderation — name the feature)

**Bot Flag:**
The reviewable outcome of a detector firing under **Bot Defense**, materialised as a **Mod Queue Item** in the **Bot Defense Mod Queue** carrying the triggering detector, the flagged member, and the evidence that tripped it. Parallel to an **Uncertain** verdict producing an **Image Rules Mod Queue** item. Each Bot Flag has a per-(Guild, member) state: `open` (awaiting staff action) → `dismissed` (false positive) or `confirmed` (staff agreed the member is a bot). At most one `open` Bot Flag per member per Guild at a time — a detector that fires while an `open` flag exists for that member is suppressed. `confirmed` is terminal: a confirmed member is never re-flagged by either detector. `dismissed` members may be flagged again on a fresh trip. Distinct from a **Mod Queue Action** (which is what staff do _to_ a flag).
_Avoid:_ "bot report" (collides with the Discord reporting feature), "suspicion" (too soft — a flag is a concrete reviewable item, not a vibe), "flagged as a bot" as a verb (use "raised a Bot Flag" — "bot" already means the HAF app in this glossary), "strike"/"warning" (implies punishment; Bot Defense records, it does not punish)

**Bot Defense Detector:**
One of two automated signals under **Bot Defense** that observes member message behaviour and raises a **Bot Flag** when its condition is met. Two values: the **Honeypot Detector** and the **Rate Detector**. Each is independently enabled and independently configures whether every trip warns the member, deletes the triggering message, does both, or only attempts to queue a flag. Both share the umbrella's excluded-role set, mod-role set, and mod queue, and skip `author.bot` messages, webhook-authored messages, and any member holding a **Bot Defense Excluded Role(s)** at the moment of the message. Parallel to how **Blocklist** and **Reaction Limit** are the two rule types under **Reaction Rules**.
_Avoid:_ "rule" (collides with Reaction Rules' rule types), "filter" (overlaps with Image Rules' avoid-term), "check" (too generic), "trigger" (overlaps with Discord interaction terminology)

**Honeypot Detector:**
A **Bot Defense Detector** that raises a **Bot Flag** when an eligible member posts a message in a Guild-designated **Honeypot Channel**. The Guild admin designates the target channel list or asks HAF Bot to set up the recommended channel. Scope includes the designated channels and any threads under them; forum posts do not inherit the scope. An empty target list with the detector enabled results in no work.
_Avoid:_ "honeypot trap" (the detector is not a trap mechanism, it observes), "spam channel" (collides with rate-detector concepts), "decoy channel" (the channel is admin-designated, not bot-created), "canary channel"

**Honeypot Channel:**
A Discord channel designated by a Guild admin in the **Bot Defense** config as a place where no legitimate member should post. The **Honeypot Detector** treats any eligible member message in a Honeypot Channel or a thread under it as a trip. A Guild can select an existing channel or use the dashboard's idempotent setup action to create or repair the recommended `#do-not-post` channel. The recommended channel is visibly warned, writable by `@everyone`, accessible to HAF Bot, and hidden from members holding configured **Bot Defense Excluded Role(s)**. A Guild designates zero or more Honeypot Channels; the bot only watches them.
_Avoid:_ "trap channel" (informal and loses the configured Honeypot Channel meaning), "bait channel" (implies the bot posts bait content), "decoy channel" (loses the detector-specific meaning), "monitored channel" (every channel Bot Defense observes is monitored; this is the no-legitimate-purpose one)

**Rate Detector:**
A **Bot Defense Detector** that raises a **Bot Flag** when an eligible member repeats the same normalized text message or the same complete attachment-only image set in **X** or more distinct channels within a trailing **Y**-second sliding window (defaults: X = 5, Y = 60). It targets repeated-message activity, including compromised accounts distributing crypto scams or phishing links. Text comparison normalizes Unicode width, case, and whitespace. Attachment-only image comparison hashes exact file bytes and ignores ordering, filenames, attachment IDs, and signed URL changes; it does not recognize scam content or modified images. Captions and mentions retain text comparison. Empty messages without supported images do not count. The rate-window store retains a SHA-256 content fingerprint, channel ID, and timestamp rather than message text or image bytes. Each eligible message records its fingerprint and recomputes the distinct-channel count over the trailing window. An open flag suppresses new queue items, while configured warning/deletion actions still run on every trip. A dismissed member may re-trip. Single-channel floods remain outside this detector's scope. Legitimate cross-channel repetition may trip it; trusted-role exclusions and staff review remain necessary. See the feature documentation for download bounds and failure behavior.
_Avoid:_ "spam detector" (overlaps with a future flood detector and with the Blocklist avoid-term), "rate limiter" (implies enforcement — Bot Defense does not limit, it flags), "channel counter" (implementation detail), "anti-flood" (wrong signal — flood is total messages, this is distinct channels)

**Bot Defense Excluded Role(s):**
The Discord role(s) whose holders are skipped by both **Bot Defense Detector**s, shared across the **Bot Defense** umbrella. A Guild configures zero or more excluded roles in the Bot Defense config. ANY-match semantic: a member holding at least one excluded role is not tracked or flagged by either detector. Mirrors the `excludedRoleIds` pattern used by **Image Rules**. Distinct from the **Bot Defense Mod Role(s)** (which gate _acting on_ flags, not being _subject to_ detection).
_Avoid:_ "bot defense allowlist" (allowlist implies permitted content), "ignore roles" (use the canonical name), "whitelist" (loaded term)

**Bot Defense Mod Role(s):**
The Discord role(s) granted permission to take **Mod Queue Action**s in the **Bot Defense Mod Queue**. A Guild can configure zero or more roles in the Bot Defense config; if zero are configured, only **Guild Admins** can take Mod Queue Actions. One set shared across both detectors — there is no per-detector mod-role split. Follows the multi-role selection pattern used by **Image Rules Mod Role(s)**, **Ban Case Mod Role(s)**, and **Suggestion Mod Role(s)**.
_Avoid:_ "Bot Defense moderator role" (singular implies one role), "Bot Defense admin role", generic "moderator role" (collides with **Guild Moderator Role**)

**Bot Defense Mod Queue:**
The specific **Mod Queue** used by **Bot Defense**. Posts one reviewable embed per **Bot Flag**, each carrying the triggering detector, the flagged member (mention + raw Discord ID, per the **Audit Embed** convention), the evidence that tripped it (for a **Honeypot Detector** trip: the Honeypot Channel and the message link; for a **Rate Detector** trip: the repeated-message preview, latest message link, distinct channel list, count, and window), the timestamp, and the available **Mod Queue Action**s (Confirm Bot, Dismiss). Configured per-Guild by channel ID. Distinct from the **Image Rules Mod Queue**.
_Avoid:_ "the mod queue" without qualifier (multiple features now have one), "Bot Defense review channel", "bot queue"

**Rate Detector Dormancy:**
The behaviour of the paid-plan **Rate Detector** while its Guild is **Free**. Rate detection stops and preserves its configuration and Bot Flag history without retroactive scanning when paid entitlement returns; the **Honeypot Detector** remains available and continues operating.
_Avoid:_ "Bot Defense Dormancy" (the all-plan Honeypot Detector is not dormant), "Bot Defense disabled"

**Blocklist:**
A per-guild list of emoji that the bot will automatically remove from reactions. One type of **Reaction Rule**.
_Avoid:_ "blacklist" (loaded term), using "blocklist" to mean the entire feature (that's "Reaction Rules")

**Reaction Limit:**
A per-guild constraint on how many reactions a user can add, enforced by the bot. A type of **Reaction Rule**. Distinct from the blocklist — it controls quantity, not content.
_Avoid:_ "emoji limit" (ambiguous with blocklist size limits), "spam filter"

**Mention Protection:**
A per-Guild **Moderation** feature that detects unwanted Discord mentions and applies Guild-configured responses. It comprises the all-plan **Admin Mention Protection** and paid-plan **Mention Spam Protection**.
_Avoid:_ "mention moderation" (collides with the Moderation umbrella), "anti-ping", "Admin @'ing" (informal and too narrow)

**Discord-Parsed Mention:**
A user, role, or everyone-class mention that Discord reports in a message's structured mention fields. It represents Discord's parsed target, not proof that a recipient received a push notification; plain-text names and channel mentions are not Discord-Parsed Mentions.
_Avoid:_ "ping" (notification delivery is not observable), "mention token" (suggests raw-content parsing)

**Admin Mention Protection:**
A protection under **Mention Protection** that responds when an eligible member's message carries a **Discord-Parsed Mention** of a member holding a **Protected Admin Role(s)** or of a Protected Admin Role itself. Distinct from **Mention Spam Protection**, which responds to mention volume rather than the mentioned member's role.
_Avoid:_ "admin pinging", "admin mention detector" (detection is not the whole concept)

**Mention Spam Protection:**
A protection under **Mention Protection** that responds when either a **Mass Mention** or **Mention Burst** breach occurs. Distinct from **Admin Mention Protection**, which applies immediately based on whom the member mentions.
_Avoid:_ "mass ping protection" (too narrow), "mention rate limiter" (implies messages or mentions are prevented)

**Mass Mention:**
A **Mention Spam Protection** breach in which one message contains at least the Guild-configured number of distinct directly mentioned users. User IDs are deduplicated; role mentions, Discord's `@everyone` / `@here` mentions, and automatic reply notifications are excluded. Mass Mention covers the direct-user gap that Discord's native role and everyone-mention permissions do not close.
_Avoid:_ "mass ping" (informal), "mention count" (loses the single-message threshold semantics)

**Mention Burst:**
A **Mention Spam Protection** breach in which one member sends at least the Guild-configured number of messages containing an explicit direct user mention within the configured time window. Role mentions, Discord's `@everyone` / `@here` mentions, and automatic reply notifications do not feed the burst counter; directly mentioned users may repeat or differ between messages.
_Avoid:_ "mention spam" (the protection umbrella also includes Mass Mention), "mention rate limit" (implies prevention)

**Mention Protection Response Policy:**
The independently configured response for one protection's initial and repeat breaches. A response can warn by replying, delete the triggering message, and optionally restrict the member using either a Discord timeout or a **Timed Role** with a configured duration. The two restriction mechanisms are mutually exclusive within one policy. Repeat responses are selected when the same member breaches that protection again within the configured period.
_Avoid:_ "punishment" (a policy can be warning-only), "global response" (each protection has its own policy)

**Protected Admin Role(s):**
The configurable Discord role(s) whose current holders are protected by **Admin Mention Protection**. Discord permissions and HAF's designated app-admin role do not grant protection unless the corresponding Discord role is selected.
_Avoid:_ "admin roles" (ambiguous with Discord and HAF authorization), "protected users" (protection follows current role membership)

**Mention Protection Channel Scope:**
The channels in which **Mention Protection** observes eligible messages, configured per Guild as either an include list or an exclude list. An empty list in either mode means all channels; threads and Forum posts inherit their parent channel's scope.
_Avoid:_ "monitored channels" (loses include/exclude semantics), "channel allowlist" (does not describe exclude mode)

**Mention Protection Excluded Role(s):**
The Discord role(s) whose holders are not subject to either protection under **Mention Protection**. A member holding any configured excluded role is skipped; bots and webhooks are always ineligible, while other members are not implicitly exempt based on staff or admin status.
_Avoid:_ "trusted roles" (trust is broader than this feature), "ignored roles", "whitelist"

**Community Management:**
Features that help Guild members interact and organise: **Clan Management**, **Events** (scheduled signup rosters), **LFG** matchmaking, **Marketplace** trading, Ticket-based support, and **Suggestions** (member-authored proposals with votes, discussion, and staff-adjudicated outcomes).
_Avoid:_ "social features", "fun features"

**Events:**
A first-class paid-plan **Community Management** feature for scheduled activities in a Guild. An **Event** is created and managed from the admin dashboard, published as one canonical Discord message, and joined by members through Discord components. Events are roster-focused by default but flexible enough for teams, shifts, vendor slots, and other community shapes.
_Avoid:_ "calendar" (too narrow), "Apollo clone" (external product reference), "LFG event" (Events are a separate feature from LFG)

**Event:**
One scheduled activity under **Events**, with its canonical Discord message, signup groups, optional thread, reminders, and participant state.

**Event Template:**
A reusable admin-dashboard preset for creating Events with consistent Signup Groups, reminders, and default options. Templates do not imply recurrence; recurrence is a future capability.
_Avoid:_ "recurring event" for templates, "preset" when referring to the persisted domain object

**Signup Group:**
One selectable roster bucket within an Event. A Signup Group has a label, optional emoji, optional capacity, optional waitlist, optional role eligibility gates, and an optional role granted to confirmed members. Examples include team names, roles, squads, bench, vendors, or attendance categories.
_Avoid:_ "team" as the generic term (some communities do not use teams), "slot" when the group can contain many members

**Event Team:**
An Event-scoped participant roster inside one Signup Group, with one captain, an exact configured size, a unique safe name, and derived readiness. Event Teams are temporary to one Event and are distinct from persistent Guild **Clans** and generic **Signup Groups**.
_Avoid:_ "team" where it could mean a Signup Group, "Clan" for an Event-scoped roster, "party" as the canonical term

**Event Signup:**
A member's self-service registration for one Signup Group on an Event. A Signup is either **confirmed** or **waitlisted**. V1 supports self-signup only; organizer proxy signup is deferred.
_Avoid:_ "RSVP" when status and group membership matter, "registration" as the canonical term

**Event Thread:**
An optional Discord thread created from the canonical Event message. Confirmed members are added automatically; waitlisted members are not added by default.
_Avoid:_ "event channel" when referring to the thread, because the Event also has a publish channel

**Event Reminder:**
A scheduled Event notification sent in the Event channel or Event Thread to a configured audience such as signed-up members, waitlisted members, a Signup Group, or the public channel. Event Reminders are not sent by DM.
_Avoid:_ "DM reminder" for v1, "calendar notification"

**Player Count:**
A paid-plan per-Guild integration that polls configured game servers and presents their current population through Discord channel names and alerts.
_Avoid:_ "server status" (broader than player population), "player tracker" (implies individual identity tracking)

**Suggestions:**
The guild noticeboard where members submit proposals for changes, features, or improvements to the community. Backed by a Discord **Forum channel** (one per Guild) where each **Suggestion** is a native Forum thread. Status is carried by the Forum's tags; the starter message is bot-owned. A peer of **LFG** and **Marketplace** in scope and authorship model — members author Suggestions, staff adjudicate outcomes.
_Avoid:_ "feature requests" (implies dev work rather than community proposals), "ideas" (too informal), "proposals" (overlaps with Discord Forum terminology)

**Suggestion:**
A single Forum thread in a Guild's Suggestions channel, authored by one Guild member via the **Suggestion Panel**. Carries a title, structured answers, a lifecycle status (Forum tag), aggregate vote totals, Considered Replies, and an outcome recorded by staff. Peer of **LFG Post** and **Marketplace Post** in being member-authored, but distinct in that staff decide the outcome rather than the owner.
_Avoid:_ "suggestion post" (redundant with the umbrella term), "feature request"

**Suggestion Channel:**
The Discord Forum channel that hosts a Guild's **Suggestions**. Each Guild configures exactly one Suggestion Channel. The Forum's tag set is the **Suggestion** lifecycle, owned and maintained by the bot.
_Avoid:_ "suggestions forum" (ambiguous with the umbrella feature), "suggestion board"

**Suggestion Panel:**
A bot-posted embed message in a Guild-configured channel that exposes a single button to start a **Suggestion**. Tapping the button opens a modal whose fields are configured by the Guild (mirroring the **Ticket** panel pattern). The Panel is the only entry point for member-authored Suggestions — there is no `/suggest` slash command. The Panel can be re-posted by mods via the admin dashboard; the bot updates the original Panel in place when its button text, embed copy, or modal fields change.
_Avoid:_ "suggestion embed" (loses the button-as-entry-point semantics), "submit message" (ambiguous with the submission flow itself)

**User-Facing Panel:**
A pattern in this system for member-facing features: a persistent bot-posted embed with a button, no slash command. Used by **Tickets**, **Suggestions**, and the **Welcome Panel** of Member Verification. The Panel is the single entry point; the button drives the entire interaction. The Panel's channel, button text, embed copy, and modal fields are all Guild-configurable.
_Avoid:_ "ticket-style embed" when referring to the pattern generically (Suggestions is not a ticket, and the Welcome Panel has no modal)

**Considered Reply:**
A member's reply on a **Suggestion**'s discussion thread, submitted through a modal prompt on the Suggestion post and posted to the thread by the bot via webhook so the bot owns the underlying message. Distinct from mod/author posts (which post directly without the modal) and from reactions (which are not replies). The bot-mediated ownership is what allows the reply to be edited to a stub on **Considered Reply Collapse** and restored on un-collapse.
_Avoid:_ "comment" (overlaps with reaction-style commentary), "feedback message", "thread reply"

**Considered Reply Collapse:**
The state of a **Considered Reply** whose community 🚩 flag count has crossed the per-guild threshold. The bot edits the webhook message in place to a stub, preserving the original content in the database. Mods can un-collapse (restore the original) or hard-delete (remove the message entirely).
_Avoid:_ "soft delete" (technically wrong — the message is edited, not deleted), "auto-mod removal"

**Suggestion Vote:**
A member's binary signal on a **Suggestion**: **Support** (endorsement) or **Oppose** (disapproval). One vote per member per Suggestion; the member can change their vote. Distinct from a **Considered Reply**, which is structured feedback rather than a preference signal.
_Avoid:_ "upvote"/"downvote" (Discord terminology leaks into a feature that uses buttons, not reactions)

**Suggestion Status:**
The lifecycle stage of a **Suggestion**, carried as a Discord Forum tag on the suggestion's thread. The set is owned by the bot and comprises six values: **Gathering Feedback** (default on submit), **Needs Work** (set by author or mod to mark the suggestion as requiring refinement), **Under Review** (set by mod to mark active evaluation), **Planned** (accepted, work scheduled), **Implemented** (work done), **Rejected** (declined). Status transitions are gated by mod action, except Needs Work which the author can self-set and the `Gathering Feedback` ↔ `Needs Work` toggle which the author can perform. The author has no other lifecycle powers — there is no Withdrawn status; if the author wants a Suggestion retracted, a member with **Suggestion Mod Role(s)** rejects it.
_Avoid:_ "state" (ambiguous with Discord thread states), "stage", "withdrawn"

**Suggestions plan posture:**
Suggestions is available on every Guild plan and carries standard `"hafbot.xyz"` branding unless the existing white-label behavior applies.

**Suggestion Mod Role(s):**
The Discord role(s) granted permission to change **Suggestion Status**, mark **Considered Reply Collapse** / un-collapse / hard-delete, and access the mod queue. A Guild can configure zero or more roles in the Suggestions config. If zero are configured, only **Guild Admins** can perform these actions. Multiple roles are supported, following the multi-role selection pattern used by **Evidence Vault Access Roles** and Timed Role configs.
_Avoid:_ "moderator role" (too generic — HAF Bot already has a **Guild Moderator Role** scoped to LFG/audit visibility)

**Suggestion Vote Eligibility:**
A per-Guild setting determining which Guild members may cast a **Suggestion Vote**. Two stacked gates:

1. **Voter role** — a Discord role (default `@everyone`). The member must hold this role at the moment of voting. Mirrors a configurable voter pool.
2. **Guild-tenure threshold** — a per-Guild minimum number of days the member must have been continuously in the Guild (default 0 = off). Computed from the member's `joined_at`. A defense against alts and drive-by sockpuppets.
   Both gates are configurable per Guild; defaults yield the most permissive setup (every Guild member can vote).
   _Avoid:_ "voter permission" (sounds Discord-native but isn't a real permission), "voting requirement"

**Suggestion Category:**
A Guild-defined topic label that a **Suggestion** can carry in addition to its **Suggestion Status**. Each Guild configures its own set of categories (e.g. `UI`, `Bot Features`, `Moderation`, `Events`) in the Suggestions admin dashboard. A Suggestion carries at most one category. The category is presented as an optional dropdown in the **Suggestion Panel**'s submission modal; blank = no category. Categories are a separate tag set from status tags, and a Suggestion's thread is tagged with both.
_Avoid:_ "topic" (too generic), "label" (overlaps with Discord's forum labels feature), "board" (Canny terminology leaks)

**Suggestions Mod Queue:**
The feature-specific **Mod Queue** where a collapsed **Considered Reply** is privately presented to Suggestion Mods with its original content, author, flag information, and the actions Keep Collapsed, Restore Reply, and Hard Delete. A missing queue does not undo a durable collapse; it produces a degraded delivery state for repair.
_Avoid:_ "suggestions review channel" (the configured channel hosts a Mod Queue), "mod log" (the queue is actionable)

**Suggestion Outcome:**
The required staff-authored explanation attached when a **Suggestion** becomes Planned, Implemented, or Rejected. It may include a target, next step, announcement, or change link appropriate to the status and remains part of the durable Suggestion history.
_Avoid:_ "decision" without qualification (the lifecycle status and its explanation are distinct), "resolution" (overlaps with delivery and queue resolution)

**Suggestion Revision:**
The durable snapshot of a **Suggestion** immediately before an author edit. Revisions preserve the title, prompt labels and answers, category, editor, and timestamp so later configuration or refinement cannot rewrite history.
_Avoid:_ "edit log" (a revision preserves content, not only an event), "version" (overlaps with deployment versions)

**Suggestion Digest:**
An optional, idempotently published Guild summary containing bounded sections for new Suggestions, active Suggestions needing more feedback, and recently decided Suggestions. It deliberately does not rank Suggestions only by net votes.
_Avoid:_ "leaderboard" (the Digest balances discovery rather than ranking popularity), "newsletter" (it is a Discord feature projection)

**Access Control:**
Participation and staff-access scaffolding through Reaction Roles, time-limited role assignments, and member verification. **Evidence Vault** is a separate staff-evidence safeguard with its own access policy; neither category is **Moderation**.
_Avoid:_ "moderation" when describing timed roles or verification

**Reaction Roles:**
The Access Control feature that lets Guild members select ordinary roles by adding emoji reactions to a Reaction Role Panel and remove those roles by removing their reactions.
_Avoid:_ "Reaction Rules" (emoji moderation), "Timed Roles" (assignments with expiry)

**Reaction Role Panel:**
A Guild's HAF-owned welcome message that presents the selectable emoji-to-role choices, such as game roles that grant access to game channels.
_Avoid:_ "verification panel" (Member Verification owns that flow), "reaction rule"

**Tickets:**
The Community Management feature that owns **Ticket Panel** entry points, **Ticket Type** flows, private **Ticket** channels, and their lifecycle.

**Timed Roles:**
The Access Control feature that creates and expires **Timed Role Assignment** records for Guild members.

**Evidence Vault:**
An access-control safeguard for sensitive staff evidence in a Guild. Staff can preserve evidence while restricting who may view it and auditing access. It supports staff workflows around bans or misconduct reviews, but does not enforce bans or other penalties.
_Avoid:_ "moderation feature" (it does not enforce rules), "evidence moderation"

**Evidence Vault Record:**
The durable, Guild-scoped record created when HAF hides a supported Discord message. It retains bounded source content, author and location metadata, attachments, audit metadata, optional **Subject Identifiers**, and optional **Evidence Fields**.

**Evidence Vault Config:**
The per-Guild Evidence Vault policy containing its audit channel, access roles, subject setting, and field definitions. It controls capture and access behavior but does not make Evidence Vault records authoritative for Discord permissions.

**Evidence Vault Audit Channel:**
A Guild channel where Evidence Vault hide and view activity is reported. The Evidence Vault requires an audit channel before evidence can be hidden or viewed because auditability is part of the feature's core access-control promise.
_Avoid:_ "optional log channel" when describing Evidence Vault auditing

**Guild Audit Log:**
A Guild-wide audit destination where administrator-selected activity across HAF features and Discord Guild events is reported. Feature-specific audit channels may override this destination when a workflow needs separate visibility or retention.
_Avoid:_ "server log", "mod log" when referring to the cross-feature audit destination

**Audit Destination:**
The Guild channel that receives Guild Audit Log output. In v1, a Guild has one default Audit Destination, while existing feature-specific audit channels may override it.
_Avoid:_ "per-event channel" for v1 audit routing

**Audit Event Group:**
A category of related Guild Audit Log events that can be enabled together while still allowing individual event overrides. Groups keep audit configuration readable without hiding event-level control from Guild admins.
_Avoid:_ "logging section", "event category" when referring to the configurable audit grouping

**Audit Exclusion Policy:**
The Guild-wide Guild Audit Log policy that suppresses eligible **Discord Audit Events** originating from configured channels or members holding configured roles. It never suppresses **HAF Audit Events**.
_Avoid:_ "event filter" (too broad), "ignored channels/users" (loses the channel-or-role policy semantics)

**Discord Audit Event:**
A Guild Audit Log event caused by activity in Discord itself rather than by a HAF workflow. Examples include member joins, message deletion, role changes, channel changes, and invite creation.
_Avoid:_ "HAF event" when the bot only observed the activity

**Message Content Snapshot:**
The bounded message text included in a message update or deletion audit output so Guild admins can understand what changed. It is part of the audit output, not a durable evidence archive.
_Avoid:_ "message archive", "evidence record" when referring to ordinary message audit output

**HAF Audit Event:**
A Guild Audit Log event caused by a HAF workflow or HAF-managed configuration change. Examples include Ticket lifecycle changes, Reaction Rule enforcement, Timed Role expiry, Platform Link changes, and Evidence Vault access activity.
_Avoid:_ "Discord event" when HAF is the actor or workflow owner

**Evidence Vault Placeholder:**
A non-sensitive message posted where evidence was hidden. It replaces the original evidence message with a minimal access point, such as a "See Evidence" button, without revealing evidence content or sensitive metadata.
_Avoid:_ "audit message" (audit messages belong in the Evidence Vault Audit Channel)

**Evidence Vault Access Roles:**
Guild roles that, when configured, let their members hide and view evidence in the **Evidence Vault**. **Guild Admins** have Evidence Vault access automatically even when no Evidence Vault Access Roles are configured. These roles are distinct from general Guild Admin access because evidence access may need to be delegated to trusted staff without granting broader admin controls.
_Avoid:_ "admin role" when referring specifically to Evidence Vault access

**Subject Identifier:**
A typed `{ platform, id }` pair on an **Evidence Vault Record** identifying one external identity that the evidence is about. Supported platforms are Discord, Steam, Xbox, PlayStation, and cftools.
_Avoid:_ "user ID" when the platform is not Discord

**Identity Pattern:**
A global, HAF-managed regex pattern used to recognise identity-link text in evidence bodies and canonicalise Evidence Vault search/amend input.
_Avoid:_ "guild pattern" (patterns are global in v1)

**Evidence Vault Subjects:**
The per-Guild opt-in feature that adds subject inference, subject search, subject amend commands, and a conditional `Subjects` line to Evidence Vault audit/view output. It is off by default and does not backfill old records. An **Evidence Vault Record** may carry one or more **Subject Identifiers**; **Identity Pattern** is global and managed in the **Admin Guild**.
_Avoid:_ "backfill" unless describing manual amend work

**Evidence Field:**
A per-Guild, admin-defined piece of structured metadata captured manually by staff on an **Evidence Vault Record**. The set of fields, their labels, and their constraints are configured per-Guild by Guild admins; staff fill them in after a record is hidden. Distinct from a **Subject Identifier**, which is auto-inferred from **Identity Patterns** rather than manually entered. Both are searchable through one search surface, but their capture mechanisms do not merge. A Guild may configure at most five Evidence Fields.
_Avoid:_ "custom field" (too generic), "metadata field", conflating with Subject Identifier

**Evidence Field Text:**
An **Evidence Field** accepting multi-line free text up to a max length. Search treats it as a case-insensitive substring match.
_Avoid:_ "long text field", "textarea field"

**Evidence Field Short-Text:**
An **Evidence Field** accepting single-line free text up to a max length. Search treats it as a case-insensitive substring match. A manually-entered Discord user ID is captured as a Short-Text field, not cross-referenced with auto-inferred **Subject Identifiers**.
_Avoid:_ "single-line field", "input field"

**Evidence Field Enum:**
An **Evidence Field** constrained to one value from a per-field admin-defined allow-list. The member types free text in the Discord modal; the bot validates the submission against the allow-list and either accepts (normalising to the matched value) or rejects and re-prompts with the allowed values. Native dropdown enforcement is impossible because Discord modals only support free-text inputs. Search treats it as an exact match against the allow-list.
_Avoid:_ "dropdown field" (misleads about the UI), "select field", "list field"

**Evidence Field Key:**
A generated stable identifier on an **Evidence Field** definition, distinct from its human label. Stored values are keyed by the Key, not the label, so renaming a field updates the display everywhere without touching stored values. Deleting a definition does not invalidate keys already stored on records.
_Avoid:_ "field id" when meaning the label, "field name"

**Archived Evidence Field Value:**
An **Evidence Field** value stored on a record whose definition has since changed in a way the value no longer conforms to (the field was deleted, retyped, or its enum allow-list shrank). The value remains in the record's payload but is excluded from structured-field search and from the "See Evidence" view. It is never migrated or destroyed — no admin configuration change destroys stored evidence data. Staff may re-enter a conforming value through the "Add Details" button.
_Avoid:_ "orphaned value", "stale value", "legacy value"

**Guild:**
A Discord community managed by HAF Bot.
_Avoid:_ "server" when referring to the managed community (it is ambiguous with infrastructure and the **Admin Guild**).

**Guild Admin:**
A user authorized to configure one managed Guild in HAF: Discord Administrator or Manage Guild, a configured HAF admin role, or workspace owner/admin access for the dashboard surface. Guild Admin access does not imply workspace billing authority, feature-mod access, or private-channel visibility.
_Avoid:_ "administrator" without saying whether it means Discord permission, HAF Guild Admin access, or HAF global staff.

**Unified D1 Database:**
The single Cloudflare D1 database used by HAF for authentication, workspace, billing, and Guild-feature state. Runtime code receives it through the required `HAF_DB` binding; deployment-only compatibility aliases are release-managed and are not runtime inputs. See the D1 data-layer ADR for the migration boundary.

**Unified Migration History:**
The ordered, append-only SQL history under `migrations/unified`. It is the only active migration input for fresh databases and upgrades; former tracks remain archive provenance.

**HAF Database Capability:**
A request-invariant pair of the `HAF_DB` binding and its cached Drizzle adapter, created once by root runtime assembly and shared by Better Auth and feature stores.

**Timed Role:**
A role assignment with an expiration time. The bot removes the role automatically when the duration elapses.
_Avoid:_ "temporary role", "expiring role"

**Timed Role Assignment:**
One persisted assignment of a Timed Role to one Guild member with an expiry. It is distinct from the permanent **Verified Role** and from seller-scoped **Commerce Role Assignment**.

**Member Verification:**
A per-Guild **Access Control** feature that delivers a configurable embed carrying a **Verify** button to new members and grants the **Verified Role** when a member clicks it. Delivery is selected per-Guild by a `deliveryMode`: the default `"dm"` sends a **Welcome DM** to each new joiner on `GUILD_MEMBER_ADD`, while `"channel"` posts a single persistent **Welcome Panel** in a welcome channel whose Verify button is shared by the Guild (no per-member delivery on join). A peer of **Timed Roles** under **Access Control** — both fire on member-add and touch roles, but Timed Roles is a time-limited assignment while Member Verification is an interactive gate. Distinct from the new-member Timed Role: two separate features in adjacent workflow territory, not one.
_Avoid:_ "onboarding" (over-scoped), "welcome gate", "verify role" when referring to the umbrella

**Welcome DM:**
The bot-sent embed delivered to a new member on `GUILD_MEMBER_ADD` under **Member Verification** when the Guild's `deliveryMode` is `"dm"`, carrying the configurable embed content, an optional rules link, and the **Verify** button. One of two **Member Verification Delivery Surface**s, the other being the **Welcome Panel**. The Welcome DM's Verify button is a one-shot: it is disabled to "Verified ✅" once clicked. Distinct from a **Ticket Response** (an in-channel reply) and from the **Welcome Panel** (a channel-posted, shared surface).
_Avoid:_ "welcome message" (collides with Ticket Response), "onboarding message", "greeting"

**Welcome Panel:**
The bot-posted persistent embed in a Guild-configured welcome channel under **Member Verification** when the Guild's `deliveryMode` is `"channel"`, carrying the configurable embed content, an optional rules link, and a shared **Verify** button. The single delivery surface in channel mode — there is no per-member delivery on `GUILD_MEMBER_ADD`. Staff publish and refresh it via an admin action; it is edited in place when refreshed and recreated if the previous message was deleted (mirroring the **Ticket Panel** publish pattern). Its Verify button is shared by the Guild, so a click does not disable it (other members still need it). Distinct from the **Welcome DM** (a one-shot, per-member surface).
_Avoid:_ "welcome message", "verification panel", "verify panel"

**Member Verification Delivery Surface:**
The means by which a Guild's **Member Verification** presents its Verify button to members, selected per-Guild by `deliveryMode`. Two values: the **Welcome DM** (`"dm"`, per-member, one-shot) and the **Welcome Panel** (`"channel"`, shared, persistent). A Guild may switch between them; the recorded verified state is mode-independent and survives a switch.
_Avoid:_ "delivery mode" when meaning the config field, "verify channel"

**Verify:**
The member action of clicking the button on a **Welcome DM** or **Welcome Panel** under **Member Verification**, which grants the **Verified Role**. Idempotent per member: clicking when the member already holds the Verified Role is a no-op (the role is not re-granted). Sticky across leave/rejoin: a member who has ever Verified in a Guild keeps a recorded verified state, so on rejoin the bot silently re-grants the Verified Role (mirroring `restorePlatformLinkedRoles`) and does not re-deliver. A joiner without a recorded verified state is sent a Welcome DM in `"dm"` mode (in `"channel"` mode the panel is already the surface and nothing is pushed on join). The Welcome DM's button is disabled to "Verified ✅" on click; the shared Welcome Panel's button stays enabled for other members. Distinct from Discord's built-in Membership Screening.
_Avoid:_ "verification click", "accept" (implies terms), "consent", "reset verification"

**Verified Role:**
The per-Guild role granted to a member on **Verify** under **Member Verification**. Configured by the Guild admin; a single role per Guild's Member Verification config. Distinct from the new-member **Timed Role** (which expires) and from the **Guild Moderator Role** (which grants staff visibility).
_Avoid:_ "verify role", "member role", "verified member role"

**LFG (Looking For Group):**
A Guild noticeboard where members post that they're seeking others to play with. Posts auto-expire after a configurable duration and can be renewed. Supports optional notification role pings and a voice channel counter.
_Avoid:_ "group finder"

**LFG Config:**
The per-Guild settings for the LFG noticeboard, including its channel, post limits, expiry duration/action, notification role, and optional voice-channel counter.

**LFG Post:**
A member-owned request to find a group in a Guild. It has one owner, a configured game or activity option, an application lifecycle, and optional private voice access after approval.

**LFG Expiry Action:**
A per-Guild admin setting that determines what happens to an LFG Post when it auto-expires: delete the post message, close it in-place (disable buttons, mark as closed), or do nothing.
_Avoid:_ "expiry behavior" when referring to the admin setting

**LFG Notification Role:**
A Guild role that the bot pings in new LFG Post embeds. Members self-assign via a button on the noticeboard and can leave at any time. The role is Guild-scoped.
_Avoid:_ "ping role", "notification ping"

**LFG Post Auto-Expiry:**
The automatic deactivation of an LFG Post after a configurable duration (default 24 hours from creation). Distinct from manual close — auto-expiry follows the Guild's configured Expiry Action, while manual close always closes the post in-place.
_Avoid:_ "auto-close" (ambiguous with manual close)

**LFG Post Renewal:**
The act of extending an auto-expiring LFG Post by 24 hours from its current expiry time. Triggered via a Discord DM notification sent to the post owner one hour before expiry. Can be performed unlimited times.
_Avoid:_ "extend", "post extension"

**LFG Voice Channel Counter:**
A designated Discord voice channel whose name the bot updates to reflect the current number of active LFG Posts (e.g., "LFG (3)"). Updates respect Discord's 2-per-10-minutes rate limit by queueing and dropping stale requests in favor of the latest count.
_Avoid:_ "activity channel", "LFG indicator"

**LFG Audit Channel:**
A Guild channel where LFG application and approval activity is reported.
_Avoid:_ "log channel" when referring specifically to LFG audit reporting

**LFG Private Voice Channel:**
A shared voice channel created for an LFG Post after the first approved application.
_Avoid:_ "LFG room", "private room", "voice lobby"

**Guild Moderator Role:**
A Guild role that grants staff visibility into LFG private voice channels and audit logs.
_Avoid:_ "moderator" when referring to rule enforcement; this role is for staff access, not moderation policy

**Marketplace:**
A Guild noticeboard where members post trade offers (have/want).
_Avoid:_ "trading post", "exchange"

**Marketplace Post:**
A member-owned trade offer in a Guild's Marketplace, carrying the configured have/want details and its lifecycle state. It is distinct from an **LFG Post** and a **Ticket Instance**.

**Ticket:**
A support conversation between a Guild member and the support team, represented as a private channel.
_Avoid:_ "support request" (a ticket is the channel/instance, not the request)

**Ticket Type:**
A named support flow under a **Ticket Panel**, with its intake questions, eligibility, limits, and optional automation.

**Ticket Instance:**
One opened **Ticket** belonging to exactly one Guild, channel, opener, and Ticket Type.

**Ticket Lifecycle:**
The feature-owned rules for opening, claiming, closing, transcript delivery, persistence, and partial cleanup of a Ticket Instance.

**Ticket Recovery:**
A durable continuation containing unfinished Ticket Lifecycle work after a partial external or persistence failure.

**Ticket Recovery Queue:**
The at-least-once queue that resumes durable Ticket Recovery work through idempotent lifecycle adapters.

**Ticket Panel:**
A named support entry point that is published as a bot-posted message in a Guild channel, offers one or more ticket-type buttons, and opens Tickets for that panel's configured support flow. The name identifies the panel to admins and is not necessarily shown to members.
_Avoid:_ "ticket category", "support menu"

**Ticket Creation Limit:**
A per-guild constraint on how many open tickets a single member may have simultaneously.
_Avoid:_ "ticket cap", "user ticket quota"

**Ticket Type Limit Exclusion:**
A per-ticket-type flag indicating that tickets of this type do not count toward the Ticket Creation Limit.
_Avoid:_ "unlimited ticket type", "bypass limit"

**Ticket Claim:**
The designation of a support staff member as the handler of an open Ticket. Recorded on the Ticket Instance and visible in the ticket channel. Does not restrict access for other support staff.
_Avoid:_ "ticket assignment" (ambiguous with role assignment), "ticket lock"

**AI Transcript Summary:**
A short, neutral, admin-facing description of a closed Ticket's conversation and/or a few searchable keywords. It is shown with the Ticket transcript so staff can identify old Tickets without reading the full transcript.
_Avoid:_ "ticket summary" (ambiguous with the existing transcript embed), "AI transcript" (the transcript itself is not AI-generated)

**Ticket Response Rule:**
A per-**Ticket Type** rule comprising an AND-combined list of role-based conditions and a message. Evaluated once at ticket open against the opener's current Discord roles. Multiple matching rules all fire, each producing a separate **Ticket Response**, in rule order. A rule with empty conditions is the match-all case and always fires. Replaces the previous single per-type auto-reply field; legacy auto-reply configuration is normalised into a one-rule list on read.
_Avoid:_ "auto-reply rule" (no reply happens), "conditional welcome" (rules need not be welcomes)

**Ticket Response:**
A bot-posted message in a ticket channel, produced by a matching **Ticket Response Rule** at ticket open. Posted with `allowed_mentions: { parse: [] }` so mentions in the text are displayed but no users or roles are pinged. Supports the same template variables as the previous auto-reply (`{{who}}`, `{{when}}`, `{{answer.questionId}}`).
_Avoid:_ "auto-reply" (legacy term being replaced), "welcome message" (rules need not be welcomes)

**Ticket Template Reply:**
A staff-initiated, bot-authored **User-Facing Message** copied from a **Message Template** into an open Ticket. It is independent of the Message Template after sending and identifies the initiating staff member internally without exposing that identity to the member.
_Avoid:_ "saved reply" (describes storage rather than the sent message), "canned reply", "Ticket Response" (automatic at ticket open)

**Action Warning:**
An admin-authored warning shown to a Guild member before a specific LFG or Marketplace action.
_Avoid:_ "tooltip", "helper text", "generic notice"

**Admin Guild:**
The internal HAF Bot Discord Guild where HAF global staff operate and receive private projections such as the **Billing Audit Channel**. It is distinct from managed Guilds and is not a source of paid entitlement.
_Avoid:_ "the server" (ambiguous), "guild" without qualifier (already means managed guild)

**Admin Dashboard:**
The Guild-scoped admin interface used by Guild Admins to inspect and manage a Guild's configuration at a glance.
_Avoid:_ using it to mean workspace-wide or HAF-global admin views

**Plan Owner:**
The signed-in Discord user who purchases and controls a HAF **Subscription**. A Plan Owner may assign slots only to Guilds they manage; the plan is not shared between unrelated customers.
_Avoid:_ "claimer", "subscriber role holder", "seat owner"

**Subscription:**
A Stripe-backed purchase owned by one **Plan Owner** on either the **Premium** or **Premium Plus** plan. It remains separate from the Guilds receiving its benefits.
_Avoid:_ "Donor Claim", "license" (when referring to the billing relationship)

**Founder Place:**
Membership in the nominal first-50 **Subscription** launch cohort, awarded only after Stripe confirms a successful non-zero first payment for a live-mode Subscription started on an approved Founder Price. Admission closes on a best-effort basis after 50 awards have been observed, so concurrent successful payments may extend the cohort; an awarded place remains permanently consumed even if that Subscription later cancels or loses Founder Pricing.
_Avoid:_ "founder slot" (suggests reusable capacity), "available founder place" after award

**Founder Pricing:**
The launch price entitlement attached to a **Subscription** with a **Founder Place**. It persists with that same non-terminal Subscription through temporary payment failure, **Grace Period**, payment recovery, plan changes, and billing-frequency changes, and is permanently forfeited when the Subscription becomes terminal.
_Avoid:_ "founder discount" (the founder offer is its own enduring price entitlement), treating `past_due` or Grace as forfeiture

**Founder Counter:**
The public historical count of awarded **Founder Place**s, capped visually at 50. It increases only after successful initial payment, never decreases after cancellation, and becomes a fully-claimed state once HAF has observed at least 50 awards.
_Avoid:_ "active founders" count, showing concurrency overshoot above 50

**GST Registration Posture:**
HAF's current launch posture while it is not registered for Australian GST: customer prices contain no GST collection, Stripe Tax stays disabled, and current and projected GST turnover are monitored for a separate registration and tax-enablement decision.
_Avoid:_ "GST exempt" (non-registration is not an exemption), "tax-inclusive price" while no GST is collected

**Stripe Customer Binding:**
The one-to-one link between a **Plan Owner** and the Stripe Customer representing that owner's billing identity. It is established before Checkout and is a correlation identity only; it does not itself grant paid access.
_Avoid:_ "Stripe account", "customer subscription"

**Guild Assignment:**
The allocation of one slot from a **Subscription** to a Guild the **Plan Owner** manages. Assignments may be moved between eligible Guilds without transferring ownership of the Subscription.
_Avoid:_ "claim", "shared seat", "Guild subscription"

**Free:**
The default unpaid Guild plan.
_Avoid:_ "non-donor", "basic donor"

**No Plan Limit:**
The absence of a subscription-plan quantity ceiling for a capability. Discord constraints, abuse safeguards, validation bounds, storage allowances, and external-provider limits still apply.
_Avoid:_ "unlimited" when it could imply the absence of technical or safety bounds

**Premium:**
A paid plan with one assignable Guild slot and paid feature access for its assigned Guild.
_Avoid:_ "Donor", "Single"

**Premium Plus:**
A paid plan with three assignable Guild slots and one **White-Label Bot** identity. Each assigned Guild receives paid feature access, and the same White-Label Bot identity may be installed into any or all of them under one shared name and brand.
_Avoid:_ "Donor+", "family plan", "shared plan"

**White-Label Bot:**
A manually-created Discord bot application provisioned by HAF staff for exactly one **Premium Plus** Subscription and installable into any or all of its assigned Guilds under one shared Discord identity and brand. App data stores only bot metadata and the Cloudflare Secrets Store reference for the bot token; the raw Discord bot token is never stored in D1. Replacement is staged: the current bot stays active while one distinct replacement is installed and health-checked, only one identity may become active, failed activation rolls back to the prior bot, and the old identity is decommissioned only after successful cutover. Irreversible removal passes through a retryable `decommissioning` state and becomes `decommissioned` only after its Gateway is stopped and its token secret is revoked/deleted; partial cleanup never masquerades as terminal completion.
_Avoid:_ "custom bot" (too vague), "customer token" (implies user-owned secret handling), "branded workspace bot"

**White-Label Bot Installation:**
The Plan Owner's explicit choice to use a Subscription's **White-Label Bot** in one assigned Guild. Multiple installations share the same Discord application, bot user, name, avatar, and token; assigning a Guild does not install the bot, and an installation is not another White-Label Bot.
_Avoid:_ "Guild White-Label Bot", treating each installed Guild as a separate bot identity

**Grace Period:**
The window beginning with a **Subscription**'s first failed renewal and carrying a fixed seven-day expiry deadline, during which its assigned Guilds retain paid access while Stripe retries payment. Ordinary Guild feature configuration remains writable, while plan/frequency changes, promotion-code changes, and new White-Label Bot provisioning are blocked; payment recovery, cancellation controls, and Guild Assignment moves/unassignments remain available. At or after the deadline HAF must successfully re-read current Stripe state before expiring Grace; a Stripe or HAF sync outage temporarily preserves access rather than causing a clock-only downgrade. Verified expiry returns assigned Guilds to **Free** while preserving dormant assignments and paid configuration, and later payment recovery restores them automatically. Exhausted retries leave the Subscription unpaid rather than automatically cancelling it; only voluntary or explicit cancellation permanently ends the assignments.
_Avoid:_ "cooldown", "buffer"

**Billing Lifecycle Event:**
A customer-visible transition in the HAF projection of a Plan Owner's **Subscription**, **Guild Assignment**, or **White-Label Bot** eligibility/lifecycle. Plan Owner DMs cover activation, Grace Period entry, recovery, cancellation, plan changes, expiry, assignment changes, and White-Label eligibility changes; raw Stripe events, sync attempts, retries, reconciliation runs, unchanged syncs, and routine payment noise are not Billing Lifecycle Events, and duplicate observations do not create another event.
_Avoid:_ "Stripe event" (when referring to a customer notification), "billing webhook"

**Billing Notification Privacy Boundary:**
Billing notifications are private to the **Plan Owner** through Discord DMs and the Billing dashboard. If the Plan Owner cannot be reached after the **Billing Delivery Retry Policy** is exhausted, HAF may send a separate privacy-safe **Guild Billing Escalation**; billing remains outside the Guild Audit Log feature.
_Avoid:_ copying a billing DM into a Guild Audit Log alert, "billing audit log" as a product feature

**Plan Owner Billing DM:**
The Discord DM used to deliver the minimum actionable **Billing Lifecycle Event** details to the **Plan Owner**: event summary, resulting access state, effective date, required next action, and Billing dashboard link. It is HAF's primary billing notification channel at launch; HAF does not send billing email or push notifications, while Stripe may send its own receipts, invoices, payment-authentication links, and failed-payment recovery messages to the Stripe Customer's billing email. Payment-ledger detail stays in Billing.
_Avoid:_ "billing email", "account notification" when referring to the Discord delivery

**Billing Delivery Retry Policy:**
Transient billing notification failures receive at most three queued attempts at approximately one minute, five minutes, and thirty minutes, respecting Discord's `Retry-After` within a bounded ceiling. Permanent failures stop immediately and do not retry.
_Avoid:_ "retry forever", "best-effort notification" when a durable failure signal is required

**Billing Delivery Escalation:**
A durable internal support signal created when a **Plan Owner Billing DM** reaches terminal failure, carrying the owner, **Billing Lifecycle Event**, attempts, and failure reason. A **Guild Billing Escalation** may accompany it only after the owner cannot be reached.
_Avoid:_ "DM failure notice" (could imply a second user-facing notification), "billing spam"

**Guild Billing Escalation:**
A separate, privacy-safe Guild-channel alert used only after a Plan Owner cannot be reached through the **Plan Owner Billing DM**. Its fixed meaning is “Billing attention required; the Plan Owner could not be reached by Discord DM; ask them to open Billing.” It is not a **HAF Audit Event**, contains no private billing details or owner mention, and does not create a Guild billing control surface.
_Avoid:_ "billing audit event", "Guild billing inbox"

**Billing Audit Channel:**
A dedicated private Discord channel in the **Admin Guild** where HAF staff can inspect one sanitized embed per accepted **Billing Lifecycle Event** and **Billing Support Operator** operation, including terminal delivery failures. It is a human-facing projection, not the authoritative billing record and not a customer Guild's **Guild Audit Log**; raw webhooks, no-op syncs, retries, and payment payloads are excluded.
_Avoid:_ "Guild billing log", "customer audit channel"

**Billing Operations Ledger:**
The indefinitely retained, append-only D1 record of billing observations, lifecycle transitions, support operations, and delivery outcomes. It is the authoritative internal history behind the Billing dashboard and **Billing Audit Channel**; Discord messages and telemetry logs are projections or diagnostics only.
_Avoid:_ "billing Discord log", "Stripe webhook history" when referring to the HAF record

**Billing Support Case:**
The restricted HAF-global workflow created for a terminal billing delivery or recovery problem. Its current status is mutable, but every status change, retry, replay, and resolution is appended to the **Billing Operations Ledger**; it is not a customer **Ticket Instance** and is resolved only by successful recovery or explicit staff action.
_Avoid:_ "billing ticket" (collides with Guild support Tickets), "Guild billing case"

**Billing Support Operator:**
An HAF global staff member holding the dedicated Billing Support role in the **Admin Guild**, authorized to perform restricted billing recovery operations. Authorization is rechecked against current Admin Guild membership and role ownership for every request; the broader HAF admin role does not imply Billing Support access. Guild admins and customer workspace owners/admins are not Billing Support Operators and cannot change Stripe-backed billing state or Guild Assignments through support tools.
_Avoid:_ "billing admin" (could mean the Plan Owner), "Guild billing admin"

**Billing Assignment Override:**
A corrective support operation that moves or repairs an existing **Guild Assignment** within the same Plan Owner's already-valid Subscription. It cannot create capacity, alter Stripe state, transfer ownership, or grant a permanent paid tier.
_Avoid:_ "manual entitlement", "complimentary assignment" when no Stripe-backed Subscription exists

**Stripe Promotion Code:**
A Stripe-managed customer-facing code that applies a configured discount to a valid Stripe Checkout or subscription flow. It is the only supported path for complimentary or tester access; redeeming one still creates a normal Stripe-backed **Subscription** and HAF entitlement projection.
_Avoid:_ "free entitlement code", "manual comp"

**Connected Seller:**
A Guild's seller identity backed by one Stripe Connect account. Stripe is the source of truth for its payment capabilities; HAF keeps a seller-scoped Commerce projection for administration, reconciliation, audit, and Discord delivery. Its lifecycle is onboarding incomplete, pending HAF review, active, restricted, repair required, offboarding, disconnected, or HAF-suspended. It never grants a HAF paid plan.
_Avoid:_ "Billing account", "Plan Owner", using an unscoped Stripe object ID

**Commerce Offering:**
A Connected Seller's purchasable mapping to one Discord role. It supports either a **Commerce Subscription** or a one-time purchase and is archived rather than deleted after financial activity.
_Avoid:_ "Timed Role", "HAF plan", using Stripe Product as the HAF configuration authority

**Commerce Price:**
An immutable, seller-scoped correlation to a Stripe Price, with an explicit AUD or USD integer minor-unit amount. It is monthly, yearly, or one-time; changing any economic field creates a new Commerce Price.
_Avoid:_ mutating a Price amount or currency, floating-point money

**Commerce Buyer:**
A Discord user purchasing from a Connected Seller. The buyer has one seller-scoped Stripe Customer per Connected Seller and may purchase multiple Commerce Offerings.
_Avoid:_ "Plan Owner", treating a Stripe Customer ID as globally scoped

**Commerce Subscription:**
A Stripe-backed recurring purchase of one Commerce Offering by one Commerce Buyer. A buyer may have only one non-terminal Commerce Subscription for the same Offering; it is separate from HAF's Premium/Premium Plus **Subscription**.
_Avoid:_ unqualified "Subscription" in Commerce code, storing it in `billing_*`

**Commerce Entitlement:**
HAF's seller-scoped projection that a Commerce Buyer currently has access to a Commerce Offering. Discord delivery is represented separately by a **Commerce Role Assignment**.
_Avoid:_ Guild plan entitlement, Timed Role Assignment, deriving access from Discord role presence

**Commerce Role Assignment:**
The mutable Discord delivery projection for one Commerce Entitlement, user, Guild, and role. It is not the entitlement authority and is not an ordinary **Timed Role Assignment**.
_Avoid:_ storing paid roles in `timed_roles`, treating role presence as payment truth

**Platform Link:**
An association between a Discord user and a gaming platform account (Steam, Xbox, etc.) within a specific Guild. Each link stores the platform name and platform-specific user ID, plus optional JSON metadata. Links are pooled under a single entitlement limit (`platformLinkMaxLinks`). Platform Link is the sole runtime persistence and workflow boundary for every provider; provider adapters own identity verification, enrichment, and presentation differences.
_Avoid:_ "account link" (ambiguous with Discord account linking)

**Play Link:**
The umbrella term for the `/playlink` command (replaces `/steamlink`), admin page, and feature. Displays all linked **Platform Links** for a user in a single whois view.
_Avoid:_ using platform-specific names for the unified feature

**User Display Name:**
The resolved display name for a Discord user, derived from a single shared fallback chain: guild-specific `nick` (when available) → `global_name` → `username` → user `id`. All display-name resolution in the codebase uses this chain via a shared helper. The OAuth profile name is a special case — it omits `nick` (no guild context) and uses `"Discord user"` as terminal fallback instead of `id`.
_Avoid:_ per-site ad-hoc fallback chains

**Audit Embed:**
A staff-facing embed posted to an audit or notification channel. Follows a consistent structure: `title` (with optional feature-specific emoji), `fields` (all `inline: false`), `footer` text `"hafbot.xyz"`, and an ISO `timestamp`. User references include raw Discord IDs (e.g., `<@userId>\nID: userId`) for traceability even when the referenced user leaves the Guild. Distinct from a **User-Facing Message**, which omits raw IDs.
_Avoid:_ "log message" (ambiguously includes the prior plain-text format)

**User-Facing Message:**
A member-visible message posted to a noticeboard, ticket, or DM channel. User references use hoverable Discord mentions (`<@userId>`) without raw ID lines. Distinct from an **Audit Embed**, which includes raw IDs for staff traceability.
_Avoid:_ using raw Discord IDs in member-visible messages

**Message Template:**
A Guild-scoped, reusable definition of one or more static embeds for a **User-Facing Message**. Using one copies its content into a new independent message, so later edits to the Message Template do not alter messages already sent or published; reusable plain-text messages are not Message Templates.
_Avoid:_ "Managed Message Draft" (single-use pre-publication state), "Ticket template" (needlessly feature-scoped), "embed template" (presentation-specific)

**Managed Message:**
A Guild-admin-authored **User-Facing Message** that HAF Bot owns as one uniquely managed Discord message in one channel and has a required Guild-unique internal name that members never see. Its content is an ordered set of embeds, each with an optional title, required description, optional colour, image, thumbnail, and footer, and up to 25 named fields, plus an optional structured announcement mention line above the embeds and up to five URL-only link buttons; it is not a reusable template or a set of published copies.
_Avoid:_ "generic embed" (describes presentation rather than identity), "embed template" (implies reuse), "announcement" (too narrow)

**Managed Message Draft:**
A Guild-admin-authored, persisted message definition that exists only in HAF until it is explicitly published as a **Managed Message**. Saving a Managed Message Draft never creates or updates a Discord message.
_Avoid:_ "draft message" (could mean a Discord client draft), "Unpublished Managed Message" (that retains an earlier publication identity)

**Managed Message Draft Status:**
The lifecycle of a **Managed Message Draft**: **Draft** while saved without a publication time, **Scheduled** while awaiting its one-time **Scheduled Publish**, or **Failed** after publication exhausts automatic retries. A Failed draft retains its content and failure reason for correction and rescheduling.
_Avoid:_ "Managed Message Status" (that describes an already-published Discord message), "pending" (does not distinguish an unscheduled draft from a scheduled one)

**Scheduled Publish:**
A one-time future action that publishes the latest saved content of a **Managed Message Draft** at a specific instant. It may be rescheduled, cancelled, or replaced by an immediate Publish before it runs; it is not a recurring schedule.
_Avoid:_ "scheduled message" (could imply a separate Discord message type), "recurring publish" (outside the one-canonical-message lifecycle)

**Managed Message Status:**
The availability of a **Managed Message**'s canonical Discord message: **Published** while it exists in Discord, **Missing** after HAF observes its deletion, **Unpublishing** while an administrator-requested removal awaits confirmation, or **Unpublished** after an administrator intentionally removes its publication while retaining its identity and saved content. An Unpublished Managed Message is restored by an explicit Publish; a Missing Managed Message is repaired by an explicit Save.
_Avoid:_ "draft" (a **Managed Message Draft** is a separate pre-publication concept), "deleted" for retained Unpublished content

**Steam Link:**
A **Platform Link** where the platform is `steam`. Uses OpenID 2.0 for authentication. Supports optional game ownership checking and custom profile links.
When selected as the **Member Verification** method, it requires a persisted Guild Steam Platform Link configuration; linked roles, logging, panels, and game filters remain optional. If the prerequisite is missing, the admin flow guides the administrator through **Play Link** setup and returns with the original Member Verification draft intact rather than silently creating policy defaults.
_Avoid:_ referring to it as the generic linking feature

**Xbox Link:**
A **Platform Link** where the platform is `xbox`. Uses Microsoft Identity Platform (MSAL/OAuth 2.0) for authentication. No game ownership check (platform limitation).
_Avoid:_ "Microsoft Link" (the linked identity is the Xbox/Microsoft account)

**PlayStation Link:**
A **Platform Link** where the platform is `playstation`. Members self-report their **PSN Online ID** through a Discord modal — no authentication is performed (Sony does not provide a public OAuth flow). The link is stored as a self-attested identity, in contrast to Steam and Xbox which are externally verified. Admins can also force-link a user via the `/playstationlink manual-link` slash command.
_Avoid:_ "PSN Link" (PSN refers to the network, not the platform), "Sony Link"

**PSN Online ID:**
The changeable display name a member uses on PlayStation Network (e.g. `CoolGamer123`). The identifier stored on a **PlayStation Link**. Not unique historically and not verified by the bot — members self-report it.
_Avoid:_ "PSN ID" (too close to "PSN" the network), "gamertag" (Xbox-specific), "username" (ambiguous)

**Platform Link Routes:**
A shared route factory (`/auth/:platform/start` and `/auth/:platform/callback`) that accepts a platform config object (`buildAuthUrl`, `verifyAssertion`, platform metadata). Handles pending validation, TTL checks, save, role assignment, and success HTML. Protocol-specific logic lives in per-platform auth modules.
The historical `/auth/steam` start URL is a compatibility alias served by the same route factory.

**Ban Case:**
A staff-worked container opened automatically when the bot receives a ban webhook from a game server, materialised as a bot-owned **Ban Case Thread** in a Guild-configured forum channel. Its subject is a **Subject Identifier** — the same concept the **Evidence Vault** uses — so a Ban Case and an Evidence Vault Record about the same person share an identity, but v1 builds no formal cross-feature link between them. Distinct from an **Evidence Vault Record**, which preserves a single piece of evidence; a Ban Case is a _container_, not a piece of evidence itself. v1 is narrow to ban-webhook triggers; a future generalisation to other triggers/actions is anticipated but not built.
_Avoid:_ "ban post" (names the Discord artifact, not the concept), "ban record" (collides with Evidence Vault Record), "ban thread" when referring to the concept (the thread is the manifestation), "ban report" (collides with the Steam Ban Lookup notification payload), "ban ticket" (collides with Ticket)

**Ban Case Thread:**
The Discord forum-thread manifestation of a **Ban Case** — a bot-owned starter message in the Guild's configured Ban Case forum channel, carrying the ban's identifying details (the banned subject and ban reason) extracted from the originating webhook. Distinct from the **Ban Case** concept it manifests and from **Evidence Vault Records** that may later be associated with it.
_Avoid:_ "forum post" (generic — use when distinguishing from the concept), "case post"

**Ban Case Forum:**
The Discord **Forum channel** that hosts a Guild's **Ban Cases**. Each Guild configures exactly one Ban Case Forum; the Forum's tag set is the **Ban Case Status** lifecycle, owned and maintained by the bot. Mirrors the one-Forum-per-feature pattern used by **Suggestions**.
_Avoid:_ "ban forum" (generic), "case channel", "evidence forum"

**Ban Case Status:**
The lifecycle stage of a **Ban Case**, carried as a Discord Forum tag on the **Ban Case Thread**. The set is owned by the bot and comprises two values: **NEW** (default on creation; the ban has not yet been reviewed) and **COMPLETED** (set manually by a member with **Ban Case Mod Role(s)** once the ban has been reviewed and evidence captured). Transitions are gated by mod action only. Distinct from **Suggestion Status**, which is a peer concept under a different feature.
_Avoid:_ "state", "ban state", "stage", "open"/"closed" (the agreed vocabulary is NEW / COMPLETED)

**Ban Case Server Action:**
An explicit staff request to ban or unban a Ban Case's exact reported subject on one Guild-owned game-server target. It requires a staff reason and confirmation. Its outcome is independent of **Ban Case Status**; neither receiving a report nor completing a case requests enforcement, and the reported identity does not prove account ownership.
_Avoid:_ "case completion action" (completion is separate), "automatic ban" (staff confirmation is required)

**Ban Case Mod Role(s):**
The Discord role(s) granted permission to change a **Ban Case Status** (set **NEW → COMPLETED**) and request a **Ban Case Server Action**. A Guild can configure zero or more roles in the Ban Case config. If zero are configured, only **Guild Admins** can change status. Follows the multi-role selection pattern used by **Evidence Vault Access Roles**, **Suggestion Mod Role(s)**, and **Image Rules Mod Role(s)**.
_Avoid:_ "ban case moderator role" (singular implies one role), "ban admin role", generic "moderator role" (collides with **Guild Moderator Role**)

**Webhook Proxy:**
A paid-plan, Guild-scoped workflow that receives an external webhook, applies the configured admission and content rules, and forwards an allowed request to one or more Discord webhook destinations. It is distinct from a **Ban Case Source**, which consumes a ban feed to create a case and forwards nothing.

**Webhook Proxy Content Replacement:**
A configured transformation that replaces or removes selected text in an allowed Webhook Proxy body before forwarding. It does not parse a body into a Ban Case.

**Ban Case Source:**
A per-Guild, admin-configured webhook endpoint that owns the **Ban Case** intake for one game-server ban feed. Each Ban Case Source has its own webhook URL and carries the **Ban Case Extraction Rule** used to parse ban-webhook bodies into a subject and ban reason. Distinct from a **Webhook Proxy** config: the Webhook Proxy forwards arbitrary webhooks to destinations, whereas a Ban Case Source consumes a webhook to create a **Ban Case Thread** and forwards nothing.
_Avoid:_ "ban webhook" (ambiguous — that's the inbound event, not the config), "ban case webhook config" (the source is the endpoint identity, not just config), "ban case rule" (collides with Extraction Rule)

**Ban Case Extraction Rule:**
A per-**Ban Case Source** text regex with named capture groups that extracts the banned subject and ban reason from the source's ban-webhook body. Text bodies only in v1; JSON-body sources are anticipated but not supported. Distinct from a **Webhook Proxy Content Replacement**, which transforms a body for forwarding — an Extraction Rule parses a body for Ban Case creation and forwards nothing.
_Avoid:_ "parsing rule" (generic), "ban regex", "webhook parser"

**Server Levels:**
A paid, per-Guild beta that derives aggregate **Server XP** from verified attendance on the Guild's **Configured Game Server**s. Eligibility depends on canonical Steam Platform Links and current Guild membership. Missed or previously ineligible attendance is never backfilled.
_Avoid:_ "global levels" (progress is Guild-scoped), "CFTools levels" (CFTools supplies attendance, not progression), "playtime tracker" (the public product exposes aggregate progression rather than raw attendance history)

**Configured Game Server:**
One Guild-owned DayZ server admitted to Server Levels, with an admin-approved capacity and an independently authenticated CFTools Hephaistos webhook endpoint. A Guild may configure at most five.

**Server XP:**
The fixed-point progression unit awarded by Server Levels from qualifying attendance. Overlapping sessions across servers or linked Steam accounts use one highest-rate stream and never stack.
_Avoid:_ "experience" when the specific stored progression unit is meant, "playtime" (multipliers mean Server XP is not elapsed time)

**Server Level:**
A Guild member's level resolved from their complete Guild-scoped Server XP total using the versioned Server Levels curve. It is aggregate progression, not an in-game or global HAF level.

**Attendance Observation:**
A private, point-in-time provider observation collected during an explicitly authorized **Attendance Observation Run**. It preserves source uncertainty and current linked-subject presence without establishing continuous attendance or qualifying Server XP.
_Avoid:_ "attendance event" (a snapshot is not a trusted join or leave), "shadow XP" (observations do not score progression)

**Attendance Observation Run:**
A bounded Guild-admin validation of one game-server target's attendance evidence. Its separate diagnostics award no XP, rewards or access and cannot be converted into retroactive earning.

**Earning Session:**
A bounded, internal Server Levels interval that begins from trusted presence plus eligible Steam identity and ends at a trusted leave, lifecycle, identity, membership, entitlement, kill-switch, or stale-session boundary. It is not public attendance history.

## Cross-feature invariants

This section records only relationships that cross feature boundaries. Feature-specific behavior, field lists, plan limits, and implementation details belong in the owning feature documentation or ADRs.

### Taxonomy

- **Moderation** comprises **Reaction Rules**, **Image Rules**, **Bot Defense**, **Mention Protection**, and **Chat Rules**.
- **Community Management** comprises **Clan Management**, **LFG**, **Marketplace**, **Tickets**, **Events**, **Suggestions**, **Server Levels**, and **Reputation**.
- **Access Control** comprises **Timed Roles**, **Member Verification**, and **Reaction Roles**. **Evidence Vault** is a separate staff-evidence access-control safeguard.
- Identity and Integrations comprises **Platform Link**, **Player Count**, **Content Feeds**, and Webhooks. Audit, Billing, and Commerce are cross-cutting systems. **Custom Replies** and **Recurring Messages** provide configurable Guild communications.

### Authorization and shared policies

- **Guild Admin** access is distinct from **Guild Moderator Role**, feature mod/reviewer/access roles, **Plan Owner**, and **Billing Support Operator** authority.
- A feature role set grants only the actions named by that feature. It does not imply private-channel access, workspace access, billing authority, or access to another feature.
- When a feature documents an empty role list as the Guild Admin fallback, the fallback is evaluated at action time; Discord role presence alone never creates feature membership.
- Role exclusions use the feature's documented match semantics. Do not infer that a staff, administrator, or bot role is excluded unless the feature says so.
- **Audit Embed** is for staff-facing audit or notification destinations; **User-Facing Message** is for members and does not expose raw IDs.

### Plans and dormancy

- A **Self-hosted Installation** has core feature capabilities independently of hosted Billing.
  It does not create a Subscription or Guild Assignment, and does not grant provider credentials
  or seller approval. Hosted plan and dormancy rules below continue to govern the hosted service.

- The current availability and quantity matrix is maintained in [docs-site/plans.md](docs-site/plans.md). This file keeps only the cross-feature rule: a downgrade preserves saved configuration, records, and resources; paid-only processing becomes dormant rather than being silently deleted.
- Restoring paid entitlement resumes processing for new activity. Missed activity is not backfilled unless a feature explicitly says otherwise.
- **No Plan Limit** removes only the HAF subscription quantity ceiling. Discord limits, validation bounds, abuse safeguards, storage allowances, and provider limits still apply.
- **Premium** and **Premium Plus** provide the same per-Guild feature behavior; Premium Plus primarily adds Subscription-level Guild Assignment capacity and one shared **White-Label Bot** identity.

### Resources, queues, and audit

- **Feature Resource Setup** is feature-owned and runs through a resumable **Setup Run**. It may reuse a **Referenced** resource, create or repair a **HAF-configured** resource that remains administrator-owned, or create a **HAF-managed** projection.
- A **Mod Queue** is an actionable review surface. A **Guild Audit Log** and feature-specific audit channel are write-only records of completed or observed events; they are not interchangeable.
- Each feature owns its Mod Queue item shape, actions, permissions, and terminal states. Do not assume the Image Rules or Bot Defense action set applies to Suggestions, Clan Management, or another future queue.
- Missing or ambiguous Discord projections produce a degraded or repairable state. HAF does not silently import external changes as authoritative configuration.

### Feature boundaries

- **Reaction Rules** owns the **Blocklist** and **Reaction Limit** rule types. **Mention Protection**, **Image Rules**, and **Bot Defense** are independent Moderation features.
- **Image Rules** and **Bot Defense** inspect only their eligible message events and apply their own exclusions, response policy, queue, and audit behavior. One feature's configuration never enables or configures the other.
- **Bot Defense** may warn or delete the triggering message, but staff adjudication of a **Bot Flag** never silently bans, kicks, times out, or changes roles.
- **Evidence Vault** records sensitive evidence and protects access to it; it does not enforce bans or other penalties. **Evidence Fields** are manual metadata, while **Subject Identifiers** are inferred or amended identity references.
- **Clan Management** owns persistent Clan identity, membership, leadership, lifecycle, and HAF-created resource projections. **Clan-only LFG** retains the normal LFG lifecycle without creating temporary voice resources.
- **LFG**, **Marketplace**, **Events**, and **Suggestions** are member-facing Community Management workflows. Their posts, signups, applications, votes, and outcomes are feature-owned objects rather than generic Tickets.
- **Tickets** own their panel, type, instance, lifecycle, recovery, and transcript rules. Ticket handlers and admin routes translate typed outcomes; they do not duplicate Ticket product rules.
- **Member Verification** and the new-member **Timed Role** are independent Access Control features. One is an interactive, sticky verification state; the other is a time-limited assignment.
- **Managed Message Draft** publication creates or updates one canonical **Managed Message**; it never creates an uncontrolled set of published copies.
- **Platform Link** is the persistence and workflow boundary for provider identity links. Provider adapters own authentication and enrichment details, while shared routes and role restoration use the canonical Platform Link model.
- Billing subscriptions and Guild Assignments are separate from seller-scoped Commerce subscriptions and entitlements. Commerce role delivery never writes HAF Billing entitlement or ordinary Timed Role state.
- A **Ban Case** and an **Evidence Vault Record** may share a **Subject Identifier**, but they remain separate concepts and v1 creates no formal cross-feature link. A **Ban Case Source** creates cases; it does not forward the webhook like a **Webhook Proxy**.
- The **Onboarding Orchestrator** recommends and launches feature-owned setup from an **Onboarding Goal**. It reads feature-owned readiness and verification metadata but records no feature configuration itself; see docs/onboarding-contract.md.

## Open decisions

- The legacy `moderation_enabled` field still means “Blocklist enabled for this Guild.” Rename or scope it during the Reaction Rules refactor without changing the public **Reaction Rules** vocabulary.
- Disambiguate LFG “close” in code and UI as **manual close** versus **LFG Post Auto-Expiry**. Manual close always closes in place; auto-expiry follows the configured **LFG Expiry Action**.

# HAF Bot

HAF Bot is a Discord community management application. This glossary defines the shared domain language used in its code and documentation.

## Guilds and administration

**Guild:**
A Discord community managed by HAF Bot.
_Avoid:_ "server" where it could mean a game server or infrastructure.

**Guild Admin:**
A user authorized to configure a managed Guild in HAF.

**Guild Moderator Role:**
A Guild role used for staff visibility into LFG private voice channels and audit activity.
_Avoid:_ using it as a synonym for feature-specific moderator roles.

**Admin Dashboard:**
The interface for inspecting and managing a Guild's HAF configuration.

**Admin Guild:**
The Discord Guild used by an installation's operators for internal administration.

**Self-hosted Installation:**
An independently operated HAF deployment using its operator's Discord application and services.
_Avoid:_ "White-Label Bot", which denotes a branded bot identity within an installation.

## Feature setup

**Onboarding Orchestrator:**
The administrator workflow that recommends and sequences feature setup around an Onboarding Goal.
_Avoid:_ using "onboarding" for Member Verification.

**Onboarding Goal:**
An administrator-selected community outcome used to recommend relevant features.

**Feature Readiness:**
A diagnostic assessment of whether a feature's configuration and Discord resources are ready for use.

**Feature Onboarding Contract:**
A feature's declaration of its setup entry point, readiness assessment, verification, and relevance to Onboarding Goals.

**Onboarding Verification:**
A safe test or observable artifact demonstrating a configured feature's intended outcome.

**Feature Resource Setup:**
A feature's administrator workflow for selecting or creating the Discord resources it needs.

**Setup Run:**
One recorded execution of a feature's resource setup plan for a Guild.

**Resource Relationship:**
The relationship between HAF and a Discord resource: **Referenced** for an existing administrator-owned resource, **HAF-configured** for one HAF creates or repairs for administrator ownership, or **HAF-managed** for a resource maintained by the feature.

## Moderation and review

**Moderation:**
Automated Guild rule enforcement through Reaction Rules, Image Rules, Bot Defense, Mention Protection, and Chat Rules.
_Avoid:_ using it for community activities or evidence storage.

**Reaction Rules:**
The feature governing emoji and reaction behaviour through the Blocklist and Reaction Limit.
_Avoid:_ "Blocklist" for the whole feature, "Reaction Roles" for reaction enforcement.

**Reaction Rule:**
One rule type within Reaction Rules: the Blocklist or Reaction Limit.

**Blocklist:**
The set of emojis forbidden by a Guild's Reaction Rules.

**Reaction Limit:**
The Reaction Rules constraint on how many reactions a member may add.

**Image Rules:**
The Moderation feature that assesses image attachments against a Guild-configured topic.

**Image Rule Verdict:**
An image's assessed relationship to the configured topic: **On-Topic**, **Off-Topic**, or **Uncertain**.

**Bot Defense:**
The Moderation feature that detects member behaviour associated with automated accounts and raises Bot Flags for staff review.

**Bot Flag:**
A reviewable record of suspected automated-account behaviour and its supporting evidence.
_Avoid:_ "strike" or "warning", which imply a penalty.

**Bot Defense Detector:**
A behavioural signal used by Bot Defense to raise a Bot Flag.

**Honeypot Detector:**
The Bot Defense detector for member messages in designated Honeypot Channels.

**Honeypot Channel:**
A Guild-designated channel where legitimate members are instructed not to post.

**Rate Detector:**
The Bot Defense detector for repeated matching content across distinct channels within a time window.

**Bot Defense Excluded Role(s):**
Guild roles whose holders are excluded from Bot Defense detection.

**Bot Defense Mod Role(s):**
Guild roles authorized to review Bot Flags.

**Bot Defense Mod Queue:**
The Mod Queue for reviewing Bot Flags.

**Rate Detector Dormancy:**
The retained but inactive condition of a Rate Detector configuration.

**Chat Rule:**
A Guild-defined automated rule for message content or message rate.

**Staff Moderation Case:**
A private Guild record of a staff moderation action, Chat Rule violation, or member report.

**Mention Protection:**
The Moderation feature covering Admin Mention Protection and Mention Spam Protection.

**Discord-Parsed Mention:**
A user mention recognized by Discord in a message, distinct from text that merely resembles a mention.

**Admin Mention Protection:**
Protection against direct mentions of members holding Protected Admin Roles.

**Mention Spam Protection:**
Protection against Mass Mention and Mention Burst activity.

**Mass Mention:**
A single-message breach of a configured threshold for distinct directly mentioned users.

**Mention Burst:**
A breach of a configured threshold for messages containing direct user mentions within a time window.

**Mention Protection Response Policy:**
The configured warning, deletion, or member restriction response to a Mention Protection breach.

**Protected Admin Role(s):**
Guild roles whose holders are protected by Admin Mention Protection.

**Mention Protection Channel Scope:**
The channels included in or excluded from Mention Protection.

**Mention Protection Excluded Role(s):**
Guild roles whose holders are excluded from Mention Protection.

**Mod Queue:**
A feature-specific staff review surface for items requiring adjudication.
_Avoid:_ "audit channel", which records activity rather than requesting review.

**Mod Queue Channel:**
The Discord channel hosting a feature's Mod Queue.

**Mod Queue Item:**
One reviewable item in a feature's Mod Queue.

**Mod Queue Action:**
A feature-specific staff action on a Mod Queue Item.

**Image Rules Mod Queue:**
The Mod Queue for reviewing uncertain Image Rule Verdicts.

**Image Rules Mod Role(s):**
Guild roles authorized to adjudicate Image Rules Mod Queue Items.

## Clans

**Community Management:**
Features that help Guild members interact and organise, including Clans, LFG, Marketplace, Tickets, Events, Suggestions, Server Levels, and Reputation.

**Clan Management:**
The Community Management feature for persistent member teams.

**Clan:**
A persistent Guild team with an owner, officers, members, and dedicated Discord resources.
_Avoid:_ "group" where it could mean a temporary LFG group or Event roster.

**Clan Request:**
A member's proposal to create a Clan.
_Avoid:_ "Clan Application", which is a request to join an existing Clan.

**Clan Request Mod Queue:**
The Mod Queue for Clan Requests and reviewed Clan lifecycle requests.

**Clan Reviewer Role(s):**
Guild roles authorized to review Clan Requests and sensitive lifecycle changes.

**Clan Owner:**
The accountable leader of a Clan.

**Clan Officer:**
A Clan member with delegated recruitment and routine management authority.

**Clan Member:**
A Guild member whose membership in a Clan is recorded by HAF.

**Clan Role:**
The Discord role representing Clan membership and ordinary private-channel access.

**Clan Board:**
A Guild noticeboard presenting Clan profiles and recruitment information.

**Clan Application:**
A member's request to join an existing Clan.

**Clan Invitation:**
An invitation from Clan leadership for a member to join the Clan.

**Clan Membership Block:**
A temporary prohibition on a member joining a particular Clan.

**Clan Degraded State:**
A condition in which Clan records and their Discord resources differ or an operation remains incomplete.

**Clan Archive:**
A retained, inactive Clan lifecycle state.

**Clan Plan Dormancy:**
The inactive condition of a retained Clan outside the Guild's effective plan allowance.

**Clan Reconciliation:**
Comparison of Clan records with their Discord resources to identify differences requiring repair.

**Clan-only LFG:**
An LFG Post for Clan members using the Clan's private text and voice resources.

## LFG and Marketplace

**LFG (Looking For Group):**
A Guild noticeboard where members seek others to play with.

**LFG Config:**
The Guild's settings for its LFG noticeboard and post lifecycle.

**LFG Post:**
A member-owned request to find a group for a game or activity.

**LFG Expiry Action:**
The configured treatment of an LFG Post when it automatically expires.

**LFG Notification Role:**
The Guild role used to notify interested members of new LFG Posts.

**LFG Post Auto-Expiry:**
Automatic deactivation of an LFG Post when its configured lifetime ends.
_Avoid:_ "close" without distinguishing expiry from manual closure.

**LFG Post Renewal:**
An extension of an LFG Post's expiry time.

**LFG Voice Channel Counter:**
A voice-channel name displaying the number of active LFG Posts.

**LFG Audit Channel:**
The Guild channel reporting LFG activity.

**LFG Private Voice Channel:**
A private voice channel associated with an LFG Post's approved participants.

**Marketplace:**
A Guild noticeboard for member-authored trade offers.

**Marketplace Post:**
A member-owned trade offer describing what the member has and wants.

**Action Warning:**
An administrator-authored warning presented before a specific LFG or Marketplace action.

## Events

**Events:**
The Community Management feature for scheduled activities and participant rosters.

**Event:**
One scheduled activity with its own signup groups, participants, reminders, and Discord message.

**Event Template:**
A reusable preset for creating Events.
_Avoid:_ "Event Series", which denotes a recurring schedule.

**Event Series:**
A recurring schedule that creates independent Event occurrences from saved settings.

**Signup Group:**
A selectable roster category within an Event.
_Avoid:_ "team" as a generic synonym; an Event Team is a separate concept.

**Event Team:**
An Event-scoped participant roster within a Signup Group, led by a captain.

**Event Signup:**
A member's confirmed or waitlisted registration in an Event Signup Group.

**Event Thread:**
A Discord discussion thread associated with an Event.

**Event Reminder:**
A scheduled notification about an Event to a selected audience.

## Suggestions

**Suggestions:**
The Guild noticeboard for member proposals, discussion, votes, and staff-recorded outcomes.

**Suggestion:**
One member-authored proposal with a lifecycle status and associated discussion and votes.

**Suggestion Channel:**
The Discord Forum channel hosting a Guild's Suggestions.

**Suggestion Panel:**
The member-facing entry point for submitting Suggestions.

**Considered Reply:**
A structured member reply submitted through HAF to a Suggestion's discussion.

**Considered Reply Collapse:**
The condition in which a Considered Reply is hidden behind a placeholder while its original content is retained.

**Suggestion Vote:**
A member's **Support** or **Oppose** signal on a Suggestion.

**Suggestion Status:**
A Suggestion's lifecycle stage: **Gathering Feedback**, **Needs Work**, **Under Review**, **Planned**, **Implemented**, or **Rejected**.

**Suggestion Mod Role(s):**
Guild roles authorized to adjudicate Suggestions and Considered Replies.

**Suggestion Vote Eligibility:**
The criteria determining which Guild members may vote on Suggestions.

**Suggestion Category:**
A Guild-defined topic label for a Suggestion, distinct from its lifecycle status.

**Suggestions Mod Queue:**
The Mod Queue for staff review of collapsed Considered Replies.

**Suggestion Outcome:**
The staff-authored explanation accompanying a Suggestion's adjudicated status.

**Suggestion Revision:**
A retained snapshot of a Suggestion before an author edit.

**Suggestion Digest:**
A published summary of new, active, and recently decided Suggestions.

## Tickets

**Tickets:**
The Community Management feature for private member-support conversations.

**Ticket:**
A support conversation represented by a private Discord channel.

**Ticket Type:**
A named support flow with its own intake questions and settings.

**Ticket Instance:**
One opened Ticket associated with a Guild, opener, channel, and Ticket Type.

**Ticket Lifecycle:**
The stages and transitions of a Ticket from opening through closure and cleanup.

**Ticket Recovery:**
Recorded unfinished Ticket lifecycle work requiring continuation after a partial failure.

**Ticket Recovery Queue:**
The queue of Ticket Recovery work awaiting continuation.

**Ticket Panel:**
A published member-facing entry point offering Ticket Type choices.

**Ticket Creation Limit:**
A Guild constraint on a member's simultaneous open Tickets.

**Ticket Type Limit Exclusion:**
A Ticket Type setting excluding its Tickets from the Ticket Creation Limit.

**Ticket Claim:**
The designation of a staff member as the handler of an open Ticket.

**AI Transcript Summary:**
An automatically generated description or keywords for a closed Ticket's transcript.

**Ticket Response Rule:**
A role-conditioned rule selecting a message to send when a Ticket opens.

**Ticket Response:**
An automatic message produced by a matching Ticket Response Rule.

**Ticket Template Reply:**
A staff-initiated reply copied from a Message Template into an open Ticket.
_Avoid:_ "Ticket Response", which denotes an automatic opening message.

## Access and verification

**Access Control:**
Features governing member participation through role selection, timed assignments, and verification.

**Reaction Roles:**
The Access Control feature for members to select ordinary Discord roles through published panels.
_Avoid:_ "Reaction Rules", which governs emoji and reaction enforcement.

**Reaction Role Panel:**
A published or draft message presenting selectable role choices.

**Timed Roles:**
The Access Control feature for role assignments with an expiry.

**Timed Role:**
A Discord role assigned for a limited duration.

**Timed Role Assignment:**
One recorded assignment of a Timed Role to a Guild member with an expiry time.

**Member Verification:**
The Access Control feature that grants a Verified Role after a member completes a configured check.
_Avoid:_ "onboarding", which refers to administrator feature setup.

**Welcome DM:**
The member-specific direct message presenting Member Verification.

**Welcome Panel:**
The shared Guild-channel panel presenting Member Verification.

**Member Verification Delivery Surface:**
The Welcome DM or Welcome Panel through which a member starts verification.

**Verify:**
The member action that initiates the configured Member Verification check.

**Verified Role:**
The Guild role granted on successful Member Verification.

**Ban Appeal:**
A banned Discord account's request for Guild staff to review its ban.

## Evidence and audit

**Evidence Vault:**
The feature for preserving sensitive staff evidence with restricted access and access auditing.
_Avoid:_ describing it as ban enforcement.

**Evidence Vault Record:**
One preserved item of evidence, including source content, metadata, and associated identifiers and fields.

**Evidence Vault Config:**
The Guild's evidence capture, access, audit, subject, and field settings.

**Evidence Vault Audit Channel:**
The Guild channel reporting evidence capture and access activity.

**Evidence Vault Placeholder:**
A non-sensitive message marking where evidence was hidden and providing an access entry point.

**Evidence Vault Access Roles:**
Guild roles authorized to capture and view Evidence Vault records.

**Subject Identifier:**
A platform-qualified identity reference identifying whom evidence or a Ban Case concerns.
_Avoid:_ "user ID" without identifying the platform.

**Identity Pattern:**
A recognition pattern for extracting and normalizing Subject Identifiers from text.

**Evidence Vault Subjects:**
The Evidence Vault capability for inferring, amending, and searching Subject Identifiers.

**Evidence Field:**
A Guild-defined piece of structured metadata entered by staff on an Evidence Vault Record.
_Avoid:_ conflating manually entered fields with inferred Subject Identifiers.

**Evidence Field Text:**
An Evidence Field accepting multiline text.

**Evidence Field Short-Text:**
An Evidence Field accepting single-line text.

**Evidence Field Enum:**
An Evidence Field constrained to a defined set of values.

**Evidence Field Key:**
An Evidence Field's stable identifier, distinct from its display label.

**Archived Evidence Field Value:**
A retained value that no longer conforms to its Evidence Field's current definition.

**Guild Audit Log:**
The Guild-wide record of selected HAF activity and observed Discord events.
_Avoid:_ "Mod Queue", which is a review surface.

**Audit Destination:**
The Guild channel receiving audit output.

**Audit Event Group:**
A category of related events used to organize audit configuration.

**Audit Exclusion Policy:**
The Guild's configured criteria for suppressing eligible Discord Audit Events.

**Discord Audit Event:**
An audit event arising from observed Discord activity.

**HAF Audit Event:**
An audit event arising from a HAF workflow or configuration change.

**Message Content Snapshot:**
A captured excerpt of message content included in message-change audit output.
_Avoid:_ "Evidence Vault Record", which denotes separately preserved evidence.

**Audit Embed:**
A staff-facing Discord embed conveying audit or notification information.

## Messages and feeds

**User-Facing Message:**
A member-visible message posted to a channel or direct message conversation.

**User-Facing Panel:**
A persistent member-facing message offering an interaction entry point.

**Custom Reply:**
A Guild-defined response invoked by a configured message trigger or Custom command.

**Recurring Message:**
A Guild announcement published repeatedly on a schedule.

**Content Feed:**
A Guild subscription announcing new items from an external content source.

**Message Template:**
A reusable message definition whose content is copied into independent messages.
_Avoid:_ "Managed Message", which denotes a particular managed publication.

**Managed Message:**
An administrator-authored message with a retained identity and a canonical Discord publication.

**Managed Message Draft:**
A saved message definition awaiting its first publication as a Managed Message.

**Managed Message Draft Status:**
A draft's publication condition: **Draft**, **Scheduled**, or **Failed**.

**Scheduled Publish:**
A one-time scheduled publication of a Managed Message Draft.
_Avoid:_ "Recurring Message", which denotes repeated scheduled announcements.

**Managed Message Status:**
A Managed Message's publication condition: **Published**, **Missing**, **Unpublishing**, or **Unpublished**.

## Player identity and game activity

**Platform Link:**
An association between a Discord user and a platform identity within a Guild.

**Play Link:**
The unified feature and command for managing and viewing Platform Links.

**Steam Link:**
A Platform Link to an authenticated Steam account.

**Xbox Link:**
A Platform Link to an authenticated Xbox account.

**PlayStation Link:**
A Platform Link to a self-attested PlayStation identity.

**PSN Online ID:**
The PlayStation display identifier recorded by a PlayStation Link.
_Avoid:_ "gamertag", which refers to Xbox identity.

**User Display Name:**
The resolved human-readable name used to present a Discord user.

**Player Count:**
The integration presenting game-server population through Discord channel names and alerts.

**Server Levels:**
Guild-scoped progression derived from qualifying game-server attendance.

**Configured Game Server:**
A Guild-owned game-server target configured as an attendance source for Server Levels.

**Server XP:**
The progression unit awarded by Server Levels for qualifying attendance.
_Avoid:_ "playtime", since progression and elapsed time are distinct quantities.

**Server Level:**
A member's progression level derived from their Guild-scoped Server XP total.

**Attendance Observation:**
A point-in-time observation of player presence used for attendance diagnostics.

**Attendance Observation Run:**
A bounded collection of attendance observations for validation.

**Earning Session:**
An interval of eligible attendance used to calculate Server XP.

**Reputation:**
Guild-scoped recognition awarded by members for helpful contributions.
_Avoid:_ "Server XP", which is attendance-derived progression.

**Reputation Award:**
One member's recorded grant of thanks to another.

**Reputation Reward:**
A Discord role associated with reaching a Guild-defined Reputation threshold.

## Ban Cases and webhooks

**Ban Case:**
A staff review record concerning a reported game-server ban and its subject.
_Avoid:_ "Evidence Vault Record", which preserves an individual evidence item.

**Ban Case Thread:**
The Discord Forum thread representing a Ban Case.

**Ban Case Forum:**
The Discord Forum channel hosting a Guild's Ban Cases.

**Ban Case Status:**
A Ban Case's review stage: **NEW** or **COMPLETED**.

**Ban Case Server Action:**
A staff-requested ban or unban of a Ban Case's reported subject on a game-server target.
_Avoid:_ conflating enforcement with case review completion.

**Ban Case Mod Role(s):**
Guild roles authorized to review Ban Cases and request Ban Case Server Actions.

**Ban Case Source:**
A Guild-configured webhook intake source for game-server ban reports.

**Ban Case Extraction Rule:**
The parsing rule that extracts a subject and ban reason from a Ban Case Source's report body.

**Webhook Proxy:**
A Guild-configured workflow that receives external webhooks and forwards allowed content to Discord webhook destinations.
_Avoid:_ "Ban Case Source", which consumes reports to create cases.

**Webhook Proxy Content Replacement:**
A configured transformation of text in a Webhook Proxy body before forwarding.

## Billing and bot identity

**Plan Owner:**
The user who owns and controls a HAF Subscription.

**Subscription:**
A purchase of a HAF service plan, separate from seller-scoped Commerce purchases.
_Avoid:_ unqualified "Subscription" for a Commerce Subscription.

**Stripe Customer Binding:**
The association between a Plan Owner and their Stripe billing customer identity.

**Guild Assignment:**
The allocation of a Subscription's benefits to a managed Guild.

**Free:**
The unpaid HAF service plan.

**Premium:**
A paid HAF service plan.

**Premium Plus:**
A paid HAF service plan with multi-Guild assignment and White-Label Bot capabilities.

**No Plan Limit:**
The absence of a subscription-plan quantity ceiling for a capability.
_Avoid:_ "unlimited" where it could imply the absence of all constraints.

**White-Label Bot:**
A branded Discord bot identity associated with a Subscription.

**White-Label Bot Installation:**
The use of a Subscription's White-Label Bot identity in an assigned Guild.

**Grace Period:**
A limited period of continued paid access following a failed Subscription renewal.

**Billing Lifecycle Event:**
A meaningful change to a Subscription, Guild Assignment, or White-Label Bot lifecycle.

**Plan Owner Billing DM:**
A private Discord message notifying the Plan Owner of a Billing Lifecycle Event.

**Billing Delivery Escalation:**
An internal support signal for an undeliverable billing notification.

**Guild Billing Escalation:**
A Guild-facing request to contact the Plan Owner about unresolved billing attention.

**Billing Audit Channel:**
An internal Discord channel presenting billing lifecycle and support activity.

**Billing Operations Ledger:**
The retained record of billing observations, transitions, support operations, and delivery outcomes.

**Billing Support Case:**
An internal support workflow for a billing delivery or recovery problem.
_Avoid:_ "Ticket", which denotes Guild member support.

**Billing Support Operator:**
An installation operator authorized to perform billing recovery operations.

**Billing Assignment Override:**
A corrective support operation on an existing Guild Assignment.

**Stripe Promotion Code:**
A customer-facing code applying a Stripe-managed discount to a purchase.

## Commerce

**Commerce:**
The seller-scoped system for paid Discord role offerings, separate from HAF service Billing.

**Connected Seller:**
A Guild's seller identity backed by a Stripe Connect account.
_Avoid:_ "Plan Owner", which owns a HAF service Subscription.

**Commerce Offering:**
A seller's purchasable offering mapped to a Discord role.

**Commerce Price:**
A seller-scoped price defining an Offering's amount, currency, and purchase cadence.

**Commerce Buyer:**
A Discord user purchasing a Commerce Offering from a Connected Seller.

**Commerce Subscription:**
A recurring purchase of a Commerce Offering by a Commerce Buyer.

**Commerce Entitlement:**
The seller-scoped record of a Commerce Buyer's access to an Offering.

**Commerce Role Assignment:**
The Discord role delivery associated with a Commerce Entitlement.
_Avoid:_ "Timed Role Assignment" or "Guild Assignment", which belong to separate domains.

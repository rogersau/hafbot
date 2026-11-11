import { rethrowDiscordRateLimit } from "./interaction-rate-limit";
import { normalizeEmoji, parseBlocklistEmojis } from "../blocklist";
import { isRecord } from "../unknown-parse";
import {
  DiscordApiError,
  editOriginalInteractionResponse,
  isDiscordRateLimitError,
  leaveGuild,
} from "../discord";
import { buildEphemeralMessage, extractCommandInvocation } from "../discord-interactions";
import { buildPlayerCountStatusEmbed } from "../services/player-count-service";
import {
  describeTimedRoleAssignmentFailure,
  formatTimedRoleExpiry,
  parseTimedRoleDuration,
} from "../timed-roles";
import {
  handleSteamWhoisCommand,
  handleSteamManualLinkCommand,
  handleSteamUnlinkCommand,
  handleSteamLinkedCountCommand,
  handleSteamRequestCommand,
} from "./steam-link-interaction-handler";
import {
  handleXboxWhoisCommand,
  handleXboxManualLinkCommand,
  handleXboxUnlinkCommand,
  handleXboxLinkedCountCommand,
  handleXboxRequestCommand,
} from "./xbox-link-interaction-handler";
import {
  handlePlayStationLinkedCountCommand,
  handlePlayStationLinkSetupCommand,
  handlePlayStationManualLinkCommand,
  handlePlayStationPanelCommand,
  handlePlayStationRequestCommand,
  handlePlayStationSyncRolesCommand,
  handlePlayStationUnlinkCommand,
  handlePlayStationWhoisCommand,
} from "./playstation-link-interaction-handler";
import { handleTicketSlashCommandInteraction } from "./ticket-interaction-handler";
import { createGuildBrandingResolver } from "./guild-branding";
import type { RuntimeStores } from "./app-types";
import type { DiscordInteraction } from "./app-types";
import type { FeatureFlags } from "./features";
import type { ApplicationCommandServices } from "./handler-services";
import { assertGuildPremiumTier, QuantityLimitError } from "./entitlement-checks";
import {
  hasInteractionAdminAccess,
  INTERACTION_ADMIN_DENIAL_MESSAGE,
} from "./interaction-admin-access";
import { getCachedBotGuilds } from "./admin-discord-cache";
import {
  DISCORD_DEFERRED_CHANNEL_MESSAGE_RESPONSE,
  DISCORD_EPHEMERAL_FLAG,
  DISCORD_CHANNEL_MESSAGE_RESPONSE,
  DISCORD_MODAL_RESPONSE,
} from "../discord/constants";
import type { SubjectIdentifierPlatform } from "../types";
import type { TicketTranscriptBlobStore, TicketTranscriptCapabilityAccess } from "./contracts";
import type { AiTranscriptSummarizerEnv } from "../services/tickets/ai-transcript-summarizer-env";
import type { ComponentIdSigner } from "../security/component-id-signer";
import { fetchGuildMember } from "../discord/members";
import {
  SERVER_LEVEL_XP_UNITS_PER_XP,
  SERVER_LEVEL_SCORING_POLICY_VERSION,
  calculateServerLevelProgress,
} from "../server-levels/policy";
import { postMemberAuditEvent } from "../services/guild-audit-log-service";
import type { SelfHostedSite } from "./self-hosted-site";

const DISCORD_MESSAGE_CONTENT_LIMIT = 2_000;

export interface ApplicationCommandHandlerOptions {
  communityTools?: import("../community-tools/service").CommunityToolsService;
  reputationServiceForGuild?: (
    guildId: string,
  ) => Promise<import("../reputation/service").ReputationService>;
  hafAdminGuildId?: string;
  hafAdminRoleId?: string;
  eraseAttendanceObservationMember?: (guildId: string, userId: string) => Promise<void>;
  services: ApplicationCommandServices;
  waitUntil?: (promise: Promise<unknown>) => void;
  requestOrigin?: string;
  selfHostedSite?: SelfHostedSite;
  ticketTranscriptBlobs?: TicketTranscriptBlobStore;
  ticketTranscriptCapabilities?: TicketTranscriptCapabilityAccess;
  aiTranscriptSummarizerEnv?: AiTranscriptSummarizerEnv;
  componentIdSigner?: ComponentIdSigner;
}

export async function handleApplicationCommand(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  discordBotToken: string,
  features: FeatureFlags,
  options: ApplicationCommandHandlerOptions,
): Promise<Response> {
  if (typeof interaction?.guild_id !== "string" || interaction.guild_id.length === 0) {
    return Response.json(buildEphemeralMessage("This command can only be used inside a server."));
  }

  const invocation = extractCommandInvocation(interaction);
  if (invocation?.commandName === "help") {
    if (options.selfHostedSite) {
      const site = options.selfHostedSite;
      const dashboard = site.publicUrl
        ? `Server admins: open this installation's [dashboard](${new URL("/admin", site.publicUrl).href}).`
        : "Ask this installation's operator for its dashboard address.";
      const support = site.supportUrl
        ? `Operator support: ${site.supportUrl}`
        : `Contact ${site.operatorName} or your server's staff for support.`;
      return Response.json(
        buildEphemeralMessage(
          [
            "**HAF Bot help**",
            "This is an independently operated HAF Bot installation. Members: use your server's published panels.",
            dashboard,
            support,
            "[Command reference](https://docs.hafbot.xyz/commands)",
          ].join("\n\n"),
        ),
      );
    }
    return Response.json(
      buildEphemeralMessage(
        [
          "**HAF Bot help**",
          "Members: use your server's published HAF panels. See the [command reference](https://docs.hafbot.xyz/commands) for member and staff commands.",
          "Server admins: open the [dashboard](https://hafbot.xyz/admin), select your Discord server and configure the tools you need.",
          "Start with one free Player support queue: [first ticket setup guide](https://docs.hafbot.xyz/guides/discord-ticket-bot).",
          "[Documentation and plan limits](https://docs.hafbot.xyz/)",
        ].join("\n\n"),
      ),
    );
  }

  if (options.waitUntil) {
    return deferSlowApplicationCommand(interaction, options.waitUntil, () =>
      handleApplicationCommand(interaction, stores, discordBotToken, features, {
        ...options,
        waitUntil: undefined,
      }),
    );
  }

  if (options.communityTools) {
    const response = await options.communityTools.handleInteraction(interaction);
    if (response) return response;
  }
  if (
    options.reputationServiceForGuild &&
    isRecord(interaction.data) &&
    interaction.data.name === "rep"
  ) {
    const { handleReputationInteraction } = await import("../reputation/interaction");
    return handleReputationInteraction(
      interaction,
      await options.reputationServiceForGuild(interaction.guild_id),
    );
  }
  if (invocation?.commandName === "haf-admin") {
    return handleHafAdminCommand(interaction, invocation, stores, discordBotToken, options);
  }

  if (!invocation) {
    return Response.json(buildEphemeralMessage("Unsupported command."));
  }

  const brandingResolver = createGuildBrandingResolver(stores.whiteLabelBots);

  const services = options.services;

  if (invocation.commandName === "serverlevel") {
    if (features.serverLevels === false || !stores.serverLevels) {
      return Response.json(buildEphemeralMessage("Server Levels is currently disabled."));
    }
    const entitlement = await assertGuildPremiumTier(
      stores.guildEntitlements,
      interaction.guild_id,
    );
    if (!entitlement.ok) {
      return Response.json(buildEphemeralMessage("Server Levels requires a paid plan."));
    }
    const config = await stores.serverLevels.readConfig(interaction.guild_id);
    if (!config?.enabled || config.removedAtMs !== null) {
      return Response.json(buildEphemeralMessage("Server Levels is not enabled in this server."));
    }
    if (invocation.subcommandName === "leaderboard") {
      const profiles = await listCurrentServerLevelLeaderboard(
        stores.serverLevels,
        interaction.guild_id,
        10,
        (userId) => fetchGuildMember(interaction.guild_id!, userId, discordBotToken),
      );
      if (profiles.length === 0) {
        return Response.json(
          buildEphemeralMessage("No current members have earned Server XP yet."),
        );
      }
      const lines = profiles.map((profile, index) => {
        const progress = calculateServerLevelProgress(profile.totalXpUnits);
        return `${index + 1}. <@${profile.userId}> — Level ${progress.level} (${formatServerXp(profile.totalXpUnits)} XP)`;
      });
      return Response.json(
        buildPublicServerLevelMessage(
          ["**Server Levels leaderboard**", ...lines].join("\n"),
          profiles.map((profile) => profile.userId),
        ),
      );
    }
    const userId =
      invocation.userId ?? interaction.member?.user?.id ?? interaction.user?.id ?? null;
    if (!userId || !(await fetchGuildMember(interaction.guild_id, userId, discordBotToken))) {
      return Response.json(
        buildEphemeralMessage("That user is not a current member of this server."),
      );
    }
    const profile = await stores.serverLevels.readProfile(interaction.guild_id, userId);
    const progress = calculateServerLevelProgress(profile?.totalXpUnits ?? 0);
    return Response.json(
      buildPublicServerLevelMessage(
        [
          `**Server Level for <@${userId}>**`,
          `Level **${progress.level}** — ${formatServerXp(progress.totalXpUnits)} XP`,
          `Progress: ${formatServerXp(progress.progressXpUnits)} / ${formatServerXp(progress.requiredXpUnits)} XP`,
        ].join("\n"),
        [userId],
      ),
    );
  }

  if (invocation.commandName === "hide-evidence") {
    if (!features.evidenceVault) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return deferSlowApplicationCommand(interaction, options.waitUntil, async () => {
      const result = await services.evidenceVaultService.hideEvidence({
        interaction,
        sourceMessage: invocation.sourceMessage,
      });
      return Response.json(buildEphemeralMessage(result.message));
    });
  }

  if (invocation.commandName === "evidence-vault") {
    if (!features.evidenceVault) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    const service = services.evidenceVaultService;
    if (invocation.subcommandName === "search") {
      const hasStructuredSearchCriteria = Boolean(
        invocation.sourceText?.trim() || invocation.fieldInputs.some((value) => value.trim()),
      );
      if (hasStructuredSearchCriteria) {
        const result = await service.searchEvidenceFieldForm({
          interaction,
          subjectInput: invocation.userInput,
          sourceText: invocation.sourceText,
          fieldInputs: invocation.fieldInputs,
        });
        return result.message
          ? Response.json({
              type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
              data: { ...result.message, flags: DISCORD_EPHEMERAL_FLAG },
            })
          : Response.json(buildEphemeralMessage(result.content));
      }
      if (!invocation.userInput) {
        const result = await service.buildEvidenceFieldSearchModal({ interaction });
        return Response.json(
          result.ok
            ? { type: DISCORD_MODAL_RESPONSE, data: result.modal }
            : buildEphemeralMessage(result.message),
        );
      }
      const result = await service.searchEvidence({ interaction, userInput: invocation.userInput });
      return result.message
        ? Response.json({
            type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
            data: { ...result.message, flags: DISCORD_EPHEMERAL_FLAG },
          })
        : Response.json(buildEphemeralMessage(result.content));
    }
    const result = await service.amendEvidenceSubjects({
      interaction,
      recordId: invocation.recordId,
      action: invocation.action,
      userInput: invocation.userInput,
    });
    return Response.json(buildEphemeralMessage(result.message));
  }

  if (invocation.commandName === "ticket") {
    if (!features.tickets) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handleTicketSlashCommandInteraction(interaction, {
      stores,
      ticketLifecycle: options.services.ticketLifecycle,
      discordBotToken,
      requestOrigin: options.requestOrigin ?? "https://runtime.example",
      subcommandName: invocation.subcommandName,
      ticketTranscriptBlobs: options.ticketTranscriptBlobs,
      waitUntil: options.waitUntil,
      aiTranscriptSummarizerEnv: options.aiTranscriptSummarizerEnv,
      templateId: invocation.subcommandName === "reply" ? invocation.templateId : undefined,
      participantUserId:
        invocation.subcommandName === "add-user" || invocation.subcommandName === "remove-user"
          ? invocation.userId
          : undefined,
      ticketTranscriptCapabilities: options.ticketTranscriptCapabilities,
      componentIdSigner: options.componentIdSigner,
    });
  }

  if (invocation.commandName === "clan") {
    if (features.clans === false || !services.clanService)
      return Response.json(buildEphemeralMessage("Clan Management is currently unavailable."));
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!userId)
      return Response.json(buildEphemeralMessage("Unable to identify the requesting member."));
    if (invocation.subcommandName === "manage") {
      const membership = await stores.clans?.readActiveMembership(interaction.guild_id, userId);
      if (!membership)
        return Response.json(buildEphemeralMessage("You do not currently belong to a Clan."));
      const clan = await stores.clans?.readClan(interaction.guild_id, membership.clanId);
      const response: ReturnType<typeof buildEphemeralMessage> & {
        data: ReturnType<typeof buildEphemeralMessage>["data"] & { components?: unknown[] };
      } = buildEphemeralMessage(
        clan
          ? `**${clan.name}** [${clan.tag}]\nRank: ${membership.rank}\nRecruitment: ${clan.recruitmentState}`
          : "Your Clan record is unavailable.",
      );
      if (clan?.lifecycleState === "active") {
        response.data.components = [
          {
            type: 1,
            components: [
              {
                type: 2,
                custom_id: "lfg:create-clan",
                label: "Create Clan LFG",
                style: 1,
              },
            ],
          },
        ];
      }
      return Response.json(response);
    }
    try {
      const rawMember = interaction.member as typeof interaction.member & {
        joined_at?: string;
        user?: { bot?: boolean };
      };
      const createdAtMs = Number(BigInt(userId) >> 22n) + 1_420_070_400_000;
      const request = await services.clanService.submitRequest({
        guildId: interaction.guild_id,
        requesterId: userId,
        name: invocation.name,
        tag: invocation.tag,
        description: invocation.description,
        focus: invocation.focus,
        recruitmentState: invocation.recruitmentState,
        eligibility: {
          isBot: rawMember?.user?.bot === true,
          roleIds: Array.isArray(interaction.member?.roles)
            ? interaction.member.roles.filter((id): id is string => typeof id === "string")
            : [],
          accountCreatedAtMs: createdAtMs,
          guildJoinedAtMs: rawMember?.joined_at ? Date.parse(rawMember.joined_at) : createdAtMs,
        },
      });
      return Response.json(
        buildEphemeralMessage(`Clan Request submitted for **${request.name}** [${request.tag}].`),
      );
    } catch (error) {
      rethrowDiscordRateLimit(error);
      return Response.json(
        buildEphemeralMessage(
          error instanceof Error ? error.message : "Unable to submit the Clan Request.",
        ),
      );
    }
  }

  if (invocation.commandName === "event") {
    if (!features.events)
      return Response.json(buildEphemeralMessage("Events are currently disabled."));
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!userId)
      return Response.json(buildEphemeralMessage("Unable to identify the requesting member."));
    const eventService = services.eventsService as typeof services.eventsService &
      Record<string, any>;
    const base = { guildId: interaction.guild_id, eventId: invocation.eventId };
    try {
      switch (invocation.subcommandName) {
        case "manage":
        case "list-teams": {
          if (typeof eventService.getEventTeamManagementView === "function") {
            const view = await eventService.getEventTeamManagementView({ ...base, userId });
            const teams = Array.isArray(view?.teams) ? view.teams : [];
            const proposals = Array.isArray(view?.actionableProposals)
              ? view.actionableProposals
              : [];
            const proposalText = formatActionableEventTeamProposals(
              proposals,
              userId,
              invocation.eventId,
            );
            let content =
              teams.length > 0
                ? teams
                    .map((team: any) => {
                      const readiness = team.readiness?.ready
                        ? "ready"
                        : team.readiness?.reasons?.includes("member_waitlisted")
                          ? "awaiting capacity"
                          : "incomplete";
                      return `• **${team.name}** (${team.id}) · captain <@${team.captainUserId}> · ${team.rosterCount} members · ${team.openPlaces ?? 0} open · ${readiness}${team.openToRequests ? " · requests open" : ""}`;
                    })
                    .join("\n")
                : "No Event Teams have been created.";
            const eligiblePool = Array.isArray(view?.eligibleUnassignedParticipants)
              ? view.eligibleUnassignedParticipants
              : [];
            const recruitmentText =
              eligiblePool.length > 0
                ? `\nEligible unassigned participants: ${eligiblePool
                    .map(
                      (participant: { userId: string; status: string }) =>
                        `<@${participant.userId}> (${participant.status})`,
                    )
                    .join(", ")}`
                : "";
            if (recruitmentText) content = `${recruitmentText}\n\n${content}`;
            return Response.json(
              buildEphemeralMessage(
                boundDiscordContent(
                  `${view.membership ? `Your Event Team: ${view.membership.teamId}` : view.signups?.length ? "You are in the unassigned pool." : "You are not signed up."}\nPending proposals: ${proposals.length}${proposalText}\n\n${content}`,
                ),
              ),
            );
          }
          if (typeof eventService.listEventTeams !== "function")
            return Response.json(
              buildEphemeralMessage(
                "Team listing is not available yet. Please refresh the Event message.",
              ),
            );
          const teams = await eventService.listEventTeams(base);
          const content =
            Array.isArray(teams) && teams.length
              ? teams
                  .map(
                    (team: any) =>
                      `• **${team.name}** (${team.id})${team.openToRequests ? " · requests open" : ""}`,
                  )
                  .join("\n")
              : "No Event Teams have been created.";
          return Response.json(buildEphemeralMessage(content));
        }
        case "view-team": {
          if (typeof eventService.getEventTeamRoster !== "function") {
            return Response.json(buildEphemeralMessage("Event Team roster view is unavailable."));
          }
          const memberUserIds = await eventService.getEventTeamRoster({
            ...base,
            teamId: invocation.teamId!,
          });
          return Response.json(
            buildEphemeralMessage(
              memberUserIds.length > 0
                ? memberUserIds.map((memberUserId: string) => `• <@${memberUserId}>`).join("\n")
                : "This Event Team has no active members.",
            ),
          );
        }
        case "leave":
          await eventService.leaveEvent(baseWithUser(base, userId));
          return Response.json(buildEphemeralMessage("You left this Event."));
        case "leave-team":
          await eventService.leaveEventTeam(baseWithUser(base, userId));
          return Response.json(buildEphemeralMessage("You left the Event Team."));
        case "create-team":
          await eventService.createEventTeam({
            ...base,
            userId,
            groupId: invocation.groupId!,
            name: invocation.name!,
          });
          return Response.json(buildEphemeralMessage("Event Team created."));
        case "rename-team":
          await eventService.renameEventTeam({
            ...base,
            teamId: invocation.teamId!,
            captainUserId: userId,
            name: invocation.name!,
          });
          return Response.json(buildEphemeralMessage("Event Team renamed."));
        case "join-team":
          await eventService.createEventTeamJoinRequest({
            ...base,
            teamId: invocation.teamId!,
            userId,
          });
          return Response.json(buildEphemeralMessage("Event Team join request sent."));
        case "withdraw-request":
          await eventService.withdrawEventTeamJoinRequest({
            ...base,
            proposalId: invocation.proposalId!,
            userId,
          });
          return Response.json(buildEphemeralMessage("Event Team request withdrawn."));
        case "accept":
          await eventService.acceptEventTeamInvitation({
            ...base,
            proposalId: invocation.proposalId!,
            userId,
          });
          return Response.json(buildEphemeralMessage("Event Team invitation accepted."));
        case "decline":
          await eventService.declineEventTeamInvitation({
            ...base,
            proposalId: invocation.proposalId!,
            userId,
          });
          return Response.json(buildEphemeralMessage("Event Team invitation declined."));
        case "open-requests":
        case "close-requests":
          await eventService.setEventTeamRequestsOpen({
            ...base,
            teamId: invocation.teamId!,
            captainUserId: userId,
            open: invocation.subcommandName === "open-requests",
          });
          return Response.json(
            buildEphemeralMessage(
              invocation.subcommandName === "open-requests"
                ? "Join requests opened."
                : "Join requests closed.",
            ),
          );
        case "reject-request":
          await eventService.rejectEventTeamJoinRequest({
            ...base,
            proposalId: invocation.proposalId!,
            captainUserId: userId,
          });
          return Response.json(buildEphemeralMessage("Join request rejected."));
        case "invite":
          if (isResolvedInteractionBot(interaction, invocation.userId!)) {
            return Response.json(buildEphemeralMessage("Bots cannot join Event Teams."));
          }
          await eventService.inviteEventTeamMember({
            ...base,
            teamId: invocation.teamId!,
            captainUserId: userId,
            userId: invocation.userId!,
            targetIsBot: false,
          });
          return Response.json(buildEphemeralMessage("Invitation sent."));
        case "remove-member":
          await eventService.captainRemoveEventTeamMember({
            ...base,
            teamId: invocation.teamId!,
            captainUserId: userId,
            userId: invocation.userId!,
          });
          return Response.json(buildEphemeralMessage("Team member removed."));
        case "transfer-captain":
          await eventService.transferEventTeamCaptain({
            ...base,
            teamId: invocation.teamId!,
            captainUserId: userId,
            newCaptainUserId: invocation.userId!,
          });
          return Response.json(buildEphemeralMessage("Captain transferred."));
        case "disband":
          await eventService.disbandEventTeam({
            ...base,
            teamId: invocation.teamId!,
            captainUserId: userId,
          });
          return Response.json(buildEphemeralMessage("Event Team disbanded."));
      }
    } catch (error) {
      rethrowDiscordRateLimit(error);
      return Response.json(
        buildEphemeralMessage(
          error instanceof Error ? error.message : "Unable to update this Event.",
        ),
      );
    }
  }

  const isSelfUnlinkCommand =
    (invocation.commandName === "steamlink" &&
      invocation.subcommandName === "unlink" &&
      !invocation.userId) ||
    (invocation.commandName === "xboxlink" &&
      invocation.subcommandName === "unlink" &&
      !invocation.userId) ||
    (invocation.commandName === "playstationlink" &&
      invocation.subcommandName === "unlink" &&
      !invocation.userId);

  if (!isSelfUnlinkCommand && !(await hasInteractionAdminAccess(interaction, stores))) {
    return Response.json(buildEphemeralMessage(INTERACTION_ADMIN_DENIAL_MESSAGE));
  }

  const actor = {
    label: "Slash command",
    userId: interaction.member?.user?.id ?? interaction.user?.id,
  };
  const { blocklistService, timedRoleService, playerCountService, platformLinkService } = services;

  if (invocation.commandName === "blocklist" && invocation.subcommandName === "list") {
    if (!features.blocklist) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    try {
      const guildConfig = await blocklistService.getGuildBlocklist(interaction.guild_id);
      const effectiveEmojis = guildConfig.enabled === false ? [] : guildConfig.emojis;
      const content = formatBoundedBulletList(
        "Blocked emojis in this server:",
        "No emojis are blocked in this server.",
        effectiveEmojis,
      );
      return Response.json(buildEphemeralMessage(content));
    } catch (error) {
      rethrowDiscordRateLimit(error);
      console.error("Failed to load moderation config", error);
      return Response.json(buildEphemeralMessage("Failed to load the server blocklist."));
    }
  }

  if (invocation.commandName === "timedrole" && invocation.subcommandName === "list") {
    if (!features.timedRoles) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    const assignments = await timedRoleService.listTimedRoles(interaction.guild_id);
    const content =
      assignments.length === 0
        ? "No timed roles are active in this server."
        : `Active timed roles:\n${assignments
            .map(
              (assignment) =>
                `- <@${assignment.userId}> -> <@&${assignment.roleId}> (${assignment.durationInput}, expires ${formatTimedRoleExpiry(assignment.expiresAtMs)})`,
            )
            .join("\n")}`;
    return Response.json(buildEphemeralMessage(content));
  }

  if (invocation.commandName === "timedrole" && invocation.subcommandName === "add") {
    if (!features.timedRoles) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    const parsedDuration = parseTimedRoleDuration(invocation.duration, Date.now());
    if (!parsedDuration) {
      return Response.json(
        buildEphemeralMessage("Invalid duration. Use values like 1h, 1w, or 1m."),
      );
    }

    try {
      await timedRoleService.assignTimedRole(
        {
          guildId: interaction.guild_id,
          userId: invocation.userId,
          roleId: invocation.roleId,
          targetDisplayName: invocation.targetDisplayName ?? undefined,
          durationInput: parsedDuration.durationInput,
          expiresAtMs: parsedDuration.expiresAtMs,
        },
        actor,
      );
    } catch (error) {
      rethrowDiscordRateLimit(error);
      console.error("Timed role assignment failed", error);
      return Response.json(buildEphemeralMessage(describeTimedRoleAssignmentFailure(error)));
    }

    return Response.json(
      buildEphemeralMessage(
        `Assigned <@&${invocation.roleId}> to <@${invocation.userId}> for ${invocation.duration} (${formatTimedRoleExpiry(parsedDuration.expiresAtMs)}).`,
      ),
    );
  }

  if (invocation.commandName === "timedrole" && invocation.subcommandName === "remove") {
    if (!features.timedRoles) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    const assignments = await timedRoleService.listTimedRoles(interaction.guild_id);
    const activeAssignment = assignments.find(
      (entry) => entry.userId === invocation.userId && entry.roleId === invocation.roleId,
    );
    if (!activeAssignment) {
      return Response.json(
        buildEphemeralMessage(
          `<@&${invocation.roleId}> is not currently active for <@${invocation.userId}>.`,
        ),
      );
    }

    try {
      await timedRoleService.removeTimedRole(
        {
          guildId: interaction.guild_id,
          userId: invocation.userId,
          roleId: invocation.roleId,
          targetDisplayName: invocation.targetDisplayName ?? undefined,
          durationInput: activeAssignment.durationInput,
          expiresAtMs: activeAssignment.expiresAtMs,
          suspendedRoleIds: activeAssignment.suspendedRoleIds,
          pendingSuspensionRoleIds: activeAssignment.pendingSuspensionRoleIds,
          removedRoleIds: activeAssignment.removedRoleIds,
          pendingRestorationRoleIds: activeAssignment.pendingRestorationRoleIds,
          restorationStartedAtMs: activeAssignment.restorationStartedAtMs,
          targetRoleRemovalCompletedAtMs: activeAssignment.targetRoleRemovalCompletedAtMs,
        },
        actor,
      );
    } catch (error) {
      rethrowDiscordRateLimit(error);
      console.error("Timed role removal failed", error);
      return Response.json(buildEphemeralMessage("Failed to remove the timed role."));
    }

    return Response.json(
      buildEphemeralMessage(`Removed <@&${invocation.roleId}> from <@${invocation.userId}>.`),
    );
  }

  if (invocation.commandName === "blocklist" && invocation.subcommandName === "add") {
    if (!features.blocklist) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    const emojis = parseBlocklistEmojis(invocation.emoji);
    if (emojis.length === 0) {
      return Response.json(buildEphemeralMessage("Invalid emoji."));
    }

    try {
      const result = await blocklistService.addEmojis(interaction.guild_id, emojis, actor);
      if (result.added.length === 0) {
        return Response.json(
          buildEphemeralMessage(`${invocation.emoji} is already blocked in this server.`),
        );
      }

      return Response.json(buildEphemeralMessage(`Blocked ${invocation.emoji} in this server.`));
    } catch (error) {
      rethrowDiscordRateLimit(error);
      if (error instanceof QuantityLimitError) {
        return Response.json(buildEphemeralMessage(error.message));
      }
      console.error("Failed to update blocklist", error);
      return Response.json(buildEphemeralMessage("Failed to update the server blocklist."));
    }
  }

  if (invocation.commandName === "blocklist" && invocation.subcommandName === "remove") {
    if (!features.blocklist) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    const normalizedEmoji = normalizeEmoji(invocation.emoji);
    if (!normalizedEmoji) {
      return Response.json(buildEphemeralMessage("Invalid emoji."));
    }

    try {
      const result = await blocklistService.removeEmoji(
        interaction.guild_id,
        normalizedEmoji,
        actor,
      );
      if (!result.wasBlocked) {
        return Response.json(
          buildEphemeralMessage(`${invocation.emoji} is not currently blocked in this server.`),
        );
      }
      return Response.json(buildEphemeralMessage(`Unblocked ${invocation.emoji} in this server.`));
    } catch (error) {
      rethrowDiscordRateLimit(error);
      console.error("Failed to update blocklist", error);
      return Response.json(buildEphemeralMessage("Failed to update the server blocklist."));
    }
  }

  if (invocation.commandName === "playercount") {
    const entitlement = await assertGuildPremiumTier(
      stores.guildEntitlements,
      interaction.guild_id,
    );
    if (!entitlement.ok) {
      return Response.json(buildEphemeralMessage("Player Count requires a paid plan."));
    }
  }

  if (invocation.commandName === "playercount" && invocation.subcommandName === "show") {
    if (!features.playerCount) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    const servers = await playerCountService.listServers(interaction.guild_id);
    if (servers.length === 0) {
      return Response.json(buildEphemeralMessage("No servers are configured for this guild."));
    }
    return Response.json({
      type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
      data: {
        embeds: [buildPlayerCountStatusEmbed(servers)],
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  if (invocation.commandName === "playercount" && invocation.subcommandName === "list") {
    if (!features.playerCount) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    const servers = await playerCountService.listServers(interaction.guild_id);
    if (servers.length === 0) {
      return Response.json(buildEphemeralMessage("No servers are configured for this guild."));
    }
    const lines = servers.map(
      (s) =>
        `- **${s.name}** (${s.provider} \`${s.providerServerId}\`)${s.channelId ? ` -> <#${s.channelId}>` : ""}`,
    );
    return Response.json(buildEphemeralMessage(["Tracked servers:", ...lines].join("\n")));
  }

  if (invocation.commandName === "playercount" && invocation.subcommandName === "add") {
    if (!features.playerCount) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    const result = await playerCountService.addServer({
      guildId: interaction.guild_id,
      name: invocation.name,
      provider: invocation.provider,
      providerServerId: invocation.steamHost,
      channelId: invocation.channelId,
      alertChannelId: invocation.alertChannelId,
      steamHost: invocation.steamHost,
      steamPort: invocation.steamPort,
      refreshIntervalMinutes: invocation.refreshIntervalMinutes,
      failureThreshold: invocation.failureThreshold,
    });
    if (!result.ok) {
      return Response.json(buildEphemeralMessage(result.error));
    }
    return Response.json(
      buildEphemeralMessage(
        `Added server "${result.server.name}" (Steam \`${result.server.steamHost}:${result.server.steamPort ?? 27015}\`).` +
          (result.server.channelId ? ` Voice channel will be renamed automatically.` : ""),
      ),
    );
  }

  if (invocation.commandName === "playercount" && invocation.subcommandName === "remove") {
    if (!features.playerCount) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    const removed = await playerCountService.removeServer(
      interaction.guild_id,
      invocation.name,
      actor.userId ?? "unknown-admin",
    );
    if (!removed) {
      return Response.json(buildEphemeralMessage(`No server named "${invocation.name}" found.`));
    }
    return Response.json(buildEphemeralMessage(`Removed server "${invocation.name}".`));
  }

  if (invocation.commandName === "steamlink" && invocation.subcommandName === "whois") {
    if (!features.steamLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handleSteamWhoisCommand(interaction, platformLinkService);
  }

  if (invocation.commandName === "steamlink" && invocation.subcommandName === "manual-link") {
    if (!features.steamLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handleSteamManualLinkCommand(interaction, platformLinkService);
  }

  if (invocation.commandName === "steamlink" && invocation.subcommandName === "unlink") {
    if (!features.steamLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handleSteamUnlinkCommand(interaction, platformLinkService);
  }

  if (invocation.commandName === "steamlink" && invocation.subcommandName === "linkedcount") {
    if (!features.steamLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handleSteamLinkedCountCommand(interaction, platformLinkService);
  }

  if (invocation.commandName === "steamlink" && invocation.subcommandName === "request") {
    if (!features.steamLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handleSteamRequestCommand(interaction, platformLinkService, discordBotToken);
  }

  if (invocation.commandName === "xboxlink" && invocation.subcommandName === "whois") {
    if (!features.xboxLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handleXboxWhoisCommand(interaction, platformLinkService);
  }

  if (invocation.commandName === "xboxlink" && invocation.subcommandName === "manual-link") {
    if (!features.xboxLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handleXboxManualLinkCommand(interaction, platformLinkService);
  }

  if (invocation.commandName === "xboxlink" && invocation.subcommandName === "unlink") {
    if (!features.xboxLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handleXboxUnlinkCommand(interaction, platformLinkService);
  }

  if (invocation.commandName === "xboxlink" && invocation.subcommandName === "linkedcount") {
    if (!features.xboxLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handleXboxLinkedCountCommand(interaction, platformLinkService);
  }

  if (invocation.commandName === "xboxlink" && invocation.subcommandName === "request") {
    if (!features.xboxLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handleXboxRequestCommand(interaction, platformLinkService, discordBotToken);
  }

  if (invocation.commandName === "playstationlink" && invocation.subcommandName === "setup") {
    if (!features.playstationLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handlePlayStationLinkSetupCommand(interaction, platformLinkService, (guildId) =>
      brandingResolver.resolveBotDisplayName(guildId),
    );
  }

  if (invocation.commandName === "playstationlink" && invocation.subcommandName === "panel") {
    if (!features.playstationLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handlePlayStationPanelCommand(interaction, platformLinkService, discordBotToken);
  }

  if (invocation.commandName === "playstationlink" && invocation.subcommandName === "request") {
    if (!features.playstationLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handlePlayStationRequestCommand(interaction, platformLinkService, discordBotToken);
  }

  if (invocation.commandName === "playstationlink" && invocation.subcommandName === "whois") {
    if (!features.playstationLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handlePlayStationWhoisCommand(interaction, platformLinkService);
  }

  if (invocation.commandName === "playstationlink" && invocation.subcommandName === "manual-link") {
    if (!features.playstationLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handlePlayStationManualLinkCommand(interaction, platformLinkService);
  }

  if (invocation.commandName === "playstationlink" && invocation.subcommandName === "unlink") {
    if (!features.playstationLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handlePlayStationUnlinkCommand(interaction, platformLinkService);
  }

  if (invocation.commandName === "playstationlink" && invocation.subcommandName === "linkedcount") {
    if (!features.playstationLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handlePlayStationLinkedCountCommand(interaction, platformLinkService);
  }

  if (invocation.commandName === "playstationlink" && invocation.subcommandName === "syncroles") {
    if (!features.playstationLink) {
      return Response.json(buildEphemeralMessage("This feature is currently disabled."));
    }
    return handlePlayStationSyncRolesCommand(interaction, platformLinkService);
  }

  return Response.json(buildEphemeralMessage("Unsupported command."));
}

export async function listCurrentServerLevelLeaderboard(
  store: NonNullable<RuntimeStores["serverLevels"]>,
  guildId: string,
  limit: number,
  fetchCurrentMember: (userId: string) => Promise<unknown | null>,
  nowMs = Date.now(),
) {
  const profiles: Awaited<ReturnType<typeof store.listLeaderboard>> = [];
  let after: { totalXpUnits: number; userId: string } | undefined;
  while (profiles.length < limit) {
    const page = await store.listLeaderboard(guildId, 25, after);
    if (page.length === 0) break;
    const memberships = await Promise.all(
      page.map(async (profile) => ({
        profile,
        current: (await fetchCurrentMember(profile.userId)) !== null,
      })),
    );
    await Promise.all(
      memberships
        .filter(({ current }) => !current)
        .map(({ profile }) => store.setCurrentMembership(guildId, profile.userId, false, nowMs)),
    );
    for (const membership of memberships) {
      if (membership.current) profiles.push(membership.profile);
      if (profiles.length === limit) break;
    }
    const last = page.at(-1)!;
    after = { totalXpUnits: last.totalXpUnits, userId: last.userId };
    if (page.length < 25) break;
  }
  return profiles;
}

function formatServerXp(units: number): string {
  const xp = units / SERVER_LEVEL_XP_UNITS_PER_XP;
  return Number.isInteger(xp) ? String(xp) : xp.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function buildPublicServerLevelMessage(content: string, userIds: string[]) {
  return {
    type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
    data: {
      content,
      allowed_mentions: { parse: [], users: [...new Set(userIds)] },
    },
  };
}

function deferSlowApplicationCommand(
  interaction: DiscordInteraction,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  task: () => Promise<Response>,
): Promise<Response> {
  if (!waitUntil) {
    return task();
  }

  waitUntil(
    task()
      .then((response) => updateDeferredApplicationCommand(interaction, response))
      .catch(async (error) => {
        console.error("Deferred application command failed", error);
        await updateDeferredApplicationCommand(
          interaction,
          Response.json(
            buildEphemeralMessage(
              isDiscordRateLimitError(error)
                ? "Discord is temporarily rate limiting this action. Try again shortly."
                : "Failed to complete the command.",
            ),
          ),
        );
      }),
  );
  return Promise.resolve(
    Response.json({
      type: DISCORD_DEFERRED_CHANNEL_MESSAGE_RESPONSE,
      data: { flags: DISCORD_EPHEMERAL_FLAG },
    }),
  );
}

async function updateDeferredApplicationCommand(
  interaction: DiscordInteraction,
  response: Response,
): Promise<void> {
  if (!interaction.application_id || !interaction.token) {
    await response.arrayBuffer();
    return;
  }

  const body = (await response.json()) as { data?: unknown };
  if (isRecord(body.data)) {
    await editOriginalInteractionResponse(interaction.application_id, interaction.token, body.data);
  }
}

async function handleHafAdminCommand(
  interaction: DiscordInteraction,
  invocation: Extract<ReturnType<typeof extractCommandInvocation>, { commandName: "haf-admin" }>,
  stores: RuntimeStores,
  discordBotToken: string,
  options: Pick<
    ApplicationCommandHandlerOptions,
    | "reputationServiceForGuild"
    | "hafAdminGuildId"
    | "hafAdminRoleId"
    | "eraseAttendanceObservationMember"
    | "services"
  >,
): Promise<Response> {
  if (!options.hafAdminGuildId || interaction.guild_id !== options.hafAdminGuildId) {
    return Response.json(
      buildEphemeralMessage("This command can only be used in the HAF admin server."),
    );
  }

  if (!hasHafAdminRole(interaction.member?.roles, options.hafAdminRoleId)) {
    return Response.json(buildEphemeralMessage("You do not have access to use this command."));
  }

  if (
    (invocation.subcommandName === "suspend-guild" ||
      invocation.subcommandName === "leave-guild") &&
    invocation.guildId === options.hafAdminGuildId
  ) {
    return Response.json(buildEphemeralMessage("The HAF admin guild cannot be suspended or left."));
  }

  if (invocation.subcommandName === "repair-verification-panel") {
    const service = options.services.memberVerificationService;
    if (!service) {
      return Response.json(buildEphemeralMessage("Member Verification is unavailable."));
    }
    const result = await service.repairWelcomePanel(invocation.guildId);
    const message =
      result.outcome === "created" || result.outcome === "refreshed"
        ? `Published or repaired the Member Verification panel for guild ${invocation.guildId} (message ${result.panelMessageId}).`
        : result.outcome === "not-eligible"
          ? `Could not repair the Member Verification panel for guild ${invocation.guildId} because its saved configuration is not eligible for channel panel delivery.`
          : `Could not repair the Member Verification panel for guild ${invocation.guildId} because Discord publication failed. Check bot permissions and try again.`;
    return Response.json(buildEphemeralMessage(message));
  }

  if (invocation.subcommandName === "adjust-server-xp") {
    if (!stores.serverLevels) {
      return Response.json(buildEphemeralMessage("Server Levels storage is unavailable."));
    }
    const actorUserId = interaction.member?.user?.id;
    if (!actorUserId) {
      return Response.json(buildEphemeralMessage("The support actor could not be identified."));
    }
    const currentMember =
      (await fetchGuildMember(invocation.guildId, invocation.userId, discordBotToken)) !== null;
    const now = Date.now();
    await stores.serverLevels.setCurrentMembership(
      invocation.guildId,
      invocation.userId,
      currentMember,
      now,
    );
    const result = await stores.serverLevels.appendAward({
      awardId: `server-level-support:${interaction.id}`,
      guildId: invocation.guildId,
      userId: invocation.userId,
      configuredGameServerId: null,
      sourceInboxId: null,
      kind: "support_adjustment",
      intervalStartedAtMs: null,
      intervalEndedAtMs: null,
      qualifyingSeconds: 0,
      multiplier: null,
      xpUnits: invocation.amountXp * SERVER_LEVEL_XP_UNITS_PER_XP,
      scoringPolicyVersion: SERVER_LEVEL_SCORING_POLICY_VERSION,
      actorUserId,
      reason: invocation.reason.slice(0, 500),
      createdAtMs: now,
    });
    const previousLevel = calculateServerLevelProgress(result.previousTotalXpUnits).level;
    const level = calculateServerLevelProgress(result.totalXpUnits).level;
    if (currentMember && level > previousLevel) {
      const config = await stores.serverLevels.readConfig(invocation.guildId);
      if (config?.announcementChannelId) {
        await stores.serverLevels.enqueueLevelAnnouncement({
          announcementId: `server-level:${invocation.guildId}:${invocation.userId}:${level}`,
          guildId: invocation.guildId,
          userId: invocation.userId,
          channelId: config.announcementChannelId,
          level,
          createdAtMs: now,
        });
      }
    }
    await postMemberAuditEvent(
      "server-level.support-adjustment",
      {
        guildId: invocation.guildId,
        user: { id: actorUserId },
        reason: invocation.reason.slice(0, 500),
        context: {
          "Target member": invocation.userId,
          "XP adjustment": invocation.amountXp,
          "Resulting XP": formatServerXp(result.totalXpUnits),
        },
      },
      stores.guildAuditLog,
      discordBotToken,
    );
    return Response.json(
      buildEphemeralMessage(
        `Server XP adjusted by ${formatServerXp(result.totalXpUnits - result.previousTotalXpUnits)} XP; total is ${formatServerXp(result.totalXpUnits)} XP.`,
      ),
    );
  }

  if (invocation.subcommandName === "erase-reputation-data") {
    const actorUserId = interaction.member?.user?.id;
    if (!actorUserId || !options.reputationServiceForGuild)
      return Response.json(buildEphemeralMessage("Reputation storage is unavailable."));
    await (
      await options.reputationServiceForGuild(invocation.guildId)
    ).eraseMember(invocation.guildId, invocation.userId);
    await postMemberAuditEvent(
      "reputation.personal-erasure",
      {
        guildId: invocation.guildId,
        user: { id: actorUserId },
        reason: invocation.reason.slice(0, 500),
        context: { "Erased member": invocation.userId },
      },
      stores.guildAuditLog,
      discordBotToken,
    );
    return Response.json(buildEphemeralMessage("Reputation personal data erased."));
  }
  if (invocation.subcommandName === "erase-server-level-data") {
    if (!stores.serverLevels) {
      return Response.json(buildEphemeralMessage("Server Levels storage is unavailable."));
    }
    const actorUserId = interaction.member?.user?.id;
    if (!actorUserId) {
      return Response.json(buildEphemeralMessage("The support actor could not be identified."));
    }
    await options.eraseAttendanceObservationMember?.(invocation.guildId, invocation.userId);
    await stores.serverLevels.eraseMemberProgression(invocation.guildId, invocation.userId);
    await postMemberAuditEvent(
      "server-level.personal-erasure",
      {
        guildId: invocation.guildId,
        user: { id: actorUserId },
        reason: invocation.reason.slice(0, 500),
        context: { "Erased member": invocation.userId },
      },
      stores.guildAuditLog,
      discordBotToken,
    );
    return Response.json(buildEphemeralMessage("Server Levels personal data erased."));
  }

  if (invocation.subcommandName === "list-guilds") {
    const guilds = await getCachedBotGuilds(discordBotToken, false);
    const lines = await Promise.all(
      [...guilds]
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) || left.guildId.localeCompare(right.guildId),
        )
        .map(async (guild) => {
          const entitlement = await stores.guildEntitlements.readGuildEntitlement(guild.guildId);
          return `${guild.name} (\`${guild.guildId}\`): ${entitlement.tier}`;
        }),
    );
    return Response.json(
      buildEphemeralMessage(
        formatBoundedBulletList("Bot guild plans:", "The bot is not in any guilds.", lines),
      ),
    );
  }

  if (
    invocation.subcommandName === "gateway-status" ||
    invocation.subcommandName === "start-gateway"
  ) {
    const gatewayService = options.services.gatewayService;
    if (!gatewayService) {
      return Response.json(buildEphemeralMessage("Gateway control is unavailable."));
    }
    const result =
      invocation.subcommandName === "gateway-status"
        ? await gatewayService.getStatus()
        : await gatewayService.bootstrap();
    const label =
      invocation.subcommandName === "gateway-status" ? "Gateway status" : "Gateway start";
    return Response.json(
      buildEphemeralMessage(`${label}:\n\`\`\`json\n${formatAdminResult(result)}\n\`\`\``),
    );
  }

  const suspensionStore = stores.guildServiceSuspensions;
  if (invocation.subcommandName === "list-suspensions") {
    if (!suspensionStore) {
      return Response.json(buildEphemeralMessage("Service suspension storage is unavailable."));
    }
    const suspensions = await suspensionStore.listSuspensions({ activeOnly: true });
    const lines = suspensions.map(
      (entry) =>
        `\`${entry.guildId}\` — ${entry.reason} (suspended <t:${Math.floor(entry.createdAtMs / 1000)}:R>)`,
    );
    return Response.json(
      buildEphemeralMessage(
        formatBoundedBulletList("Suspended guilds:", "No guilds are suspended.", lines),
      ),
    );
  }

  if (invocation.subcommandName === "suspend-guild") {
    if (!suspensionStore) {
      return Response.json(buildEphemeralMessage("Service suspension storage is unavailable."));
    }
    const existing = await suspensionStore.readActiveSuspension(invocation.guildId);
    if (existing) {
      return Response.json(
        buildEphemeralMessage(`Guild ${invocation.guildId} is already suspended.`),
      );
    }
    await suspensionStore.suspendGuild({
      guildId: invocation.guildId,
      reason: invocation.reason.trim(),
      actorUserId: interaction.member?.user?.id ?? "unknown-admin",
      occurredAtMs: Date.now(),
    });
    return Response.json(
      buildEphemeralMessage(`Suspended all HAF service for guild ${invocation.guildId}.`),
    );
  }

  if (invocation.subcommandName === "leave-guild") {
    if (!suspensionStore) {
      return Response.json(buildEphemeralMessage("Service suspension storage is unavailable."));
    }
    if (invocation.confirmedGuildId !== invocation.guildId) {
      return Response.json(
        buildEphemeralMessage("The confirmation guild ID does not match. No changes were made."),
      );
    }
    const existing = await suspensionStore.readActiveSuspension(invocation.guildId);
    if (!existing) {
      await suspensionStore.suspendGuild({
        guildId: invocation.guildId,
        reason: invocation.reason,
        actorUserId: interaction.member?.user?.id ?? "unknown-admin",
        occurredAtMs: Date.now(),
      });
    }
    try {
      const result = await leaveGuild(invocation.guildId, discordBotToken);
      return Response.json(
        buildEphemeralMessage(
          result === "left"
            ? `Suspended all HAF service and removed the bot from guild ${invocation.guildId}.`
            : `Suspended all HAF service for guild ${invocation.guildId}; the bot was already absent.`,
        ),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Discord guild removal failed after service suspension",
          guildId: invocation.guildId,
          status: error instanceof DiscordApiError ? error.status : undefined,
        }),
      );
      return Response.json(
        buildEphemeralMessage(
          `Guild ${invocation.guildId} is suspended, but Discord removal failed. Retry the leave-guild command.`,
        ),
      );
    }
  }

  if (invocation.subcommandName === "restore-guild") {
    if (!suspensionStore) {
      return Response.json(buildEphemeralMessage("Service suspension storage is unavailable."));
    }
    const existing = await suspensionStore.readActiveSuspension(invocation.guildId);
    if (!existing) {
      return Response.json(buildEphemeralMessage(`Guild ${invocation.guildId} is not suspended.`));
    }
    await suspensionStore.restoreGuild({
      guildId: invocation.guildId,
      actorUserId: interaction.member?.user?.id ?? "unknown-admin",
      occurredAtMs: Date.now(),
    });
    return Response.json(
      buildEphemeralMessage(`Restored HAF service for guild ${invocation.guildId}.`),
    );
  }

  if (invocation.subcommandName === "identity-patterns") {
    if (invocation.action === "list") {
      const patterns = await stores.evidenceVault.listIdentityPatterns();
      const lines = patterns.map(
        (pattern) =>
          `- ${pattern.id}: ${pattern.disabled ? "disabled " : ""}${pattern.position} ${pattern.platform} /${pattern.pattern}/ group ${pattern.captureGroup}`,
      );
      return Response.json(
        buildEphemeralMessage(
          formatBoundedBulletList(
            "Identity patterns:",
            "No identity patterns are configured.",
            lines,
          ),
        ),
      );
    }

    if (invocation.action === "add") {
      if (!isSubjectIdentifierPlatform(invocation.platform) || !invocation.pattern) {
        return Response.json(
          buildEphemeralMessage("Provide platform and pattern to add an identity pattern."),
        );
      }
      const pattern = await stores.evidenceVault.addIdentityPattern({
        platform: invocation.platform,
        pattern: invocation.pattern,
        captureGroup: invocation.captureGroup ?? 1,
      });
      return Response.json(buildEphemeralMessage(`Added identity pattern ${pattern.id}.`));
    }

    const id = invocation.pattern;
    if (!id) return Response.json(buildEphemeralMessage("Provide the pattern ID to disable."));
    const disabled = await stores.evidenceVault.disableIdentityPattern(id);
    return Response.json(
      buildEphemeralMessage(
        disabled ? `Disabled identity pattern ${id}.` : "Identity pattern not found.",
      ),
    );
  }

  const entitlement = await stores.guildEntitlements.readGuildEntitlement(invocation.guildId);
  return Response.json(
    buildEphemeralMessage(`Guild ${invocation.guildId} effective plan is ${entitlement.tier}.`),
  );
}

function hasHafAdminRole(memberRoles: unknown, configuredRoleId: string | undefined): boolean {
  return (
    typeof configuredRoleId === "string" &&
    configuredRoleId.length > 0 &&
    Array.isArray(memberRoles) &&
    memberRoles.includes(configuredRoleId)
  );
}

function baseWithUser(base: { guildId: string; eventId: string }, userId: string) {
  return { ...base, userId };
}

function isResolvedInteractionBot(interaction: DiscordInteraction, userId: string): boolean {
  if (!isRecord(interaction.data)) return false;
  const resolved = isRecord(interaction.data.resolved) ? interaction.data.resolved : null;
  const users = resolved && isRecord(resolved.users) ? resolved.users : null;
  const user = users && isRecord(users[userId]) ? users[userId] : null;
  return user?.bot === true;
}

function formatActionableEventTeamProposals(
  proposals: any[],
  userId: string,
  eventId: string,
): string {
  if (proposals.length === 0) return "";
  return `\n${proposals
    .map((proposal) => {
      const actions =
        proposal.kind === "join_request"
          ? proposal.requesterUserId === userId
            ? eventProposalCommand("withdraw-request", eventId, proposal.id)
            : `${eventProposalCommand("accept", eventId, proposal.id)} or ${eventProposalCommand("reject-request", eventId, proposal.id)}`
          : proposal.targetUserId === userId
            ? `${eventProposalCommand("accept", eventId, proposal.id)} or ${eventProposalCommand("decline", eventId, proposal.id)}`
            : "awaiting invitee response";
      return `• ${proposal.kind} · Team \`${proposal.teamId}\` · Proposal \`${proposal.id}\` · ${actions}`;
    })
    .join("\n")}`;
}

function eventProposalCommand(action: string, eventId: string, proposalId: string): string {
  return `\`/event ${action} event_id:${eventId} proposal_id:${proposalId}\``;
}

function boundDiscordContent(content: string): string {
  return content.length <= DISCORD_MESSAGE_CONTENT_LIMIT
    ? content
    : `${content.slice(0, DISCORD_MESSAGE_CONTENT_LIMIT - 3)}...`;
}

function isSubjectIdentifierPlatform(value: string | null): value is SubjectIdentifierPlatform {
  return (
    value === "discord" ||
    value === "steam" ||
    value === "xbox" ||
    value === "playstation" ||
    value === "cftools"
  );
}

function formatBoundedBulletList(title: string, emptyMessage: string, items: string[]): string {
  if (items.length === 0) {
    return emptyMessage;
  }

  const lines = [title];

  for (let index = 0; index < items.length; index += 1) {
    const line = `- ${items[index]}`;
    const remainingAfterLine = items.length - index - 1;

    if (remainingAfterLine === 0) {
      return [...lines, line].join("\n");
    }

    const contentWithLine = [...lines, line].join("\n");
    const summaryLine = `...and ${remainingAfterLine} more.`;

    if (`${contentWithLine}\n${summaryLine}`.length <= DISCORD_MESSAGE_CONTENT_LIMIT) {
      lines.push(line);
      continue;
    }

    let omittedCount = items.length - index;
    while (lines.length > 1) {
      const truncatedContent = [...lines, `...and ${omittedCount} more.`].join("\n");
      if (truncatedContent.length <= DISCORD_MESSAGE_CONTENT_LIMIT) {
        return truncatedContent;
      }

      lines.pop();
      omittedCount += 1;
    }

    return `${title}\n...and ${items.length} more.`;
  }

  return lines.join("\n");
}

function formatAdminResult(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2) ?? String(value);
  return serialized.length <= 1_800 ? serialized : `${serialized.slice(0, 1_797)}...`;
}

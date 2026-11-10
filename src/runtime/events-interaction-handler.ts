import { rethrowDiscordRateLimit } from "./interaction-rate-limit";
import { buildEphemeralMessage } from "../discord-interactions";
import { parseEventCustomId } from "../events";
import { isRecord } from "../unknown-parse";
import { EventConfigError } from "../services/events-service";
import type { DiscordInteraction } from "./app-types";
import {
  getInteractionCustomId,
  getInteractionUserId,
  parseInteractionModalFieldValues,
} from "./discord-interaction-parsers";
import type { ServiceFactory } from "./service-factory";
import { DISCORD_MODAL_RESPONSE } from "../discord/constants";

type EventService = ServiceFactory["eventsService"] & Record<string, any>;

const DISCORD_MESSAGE_CONTENT_LIMIT = 2_000;

export async function handleEventsComponentInteraction(
  interaction: DiscordInteraction,
  services: Pick<ServiceFactory, "eventsService">,
): Promise<Response> {
  const customId = getInteractionCustomId(interaction);
  const parsed = customId ? parseEventCustomId(customId) : null;
  const guildId = interaction.guild_id;
  const userId = getInteractionUserId(interaction);
  if (!parsed || typeof guildId !== "string" || !userId) {
    return Response.json(buildEphemeralMessage("Unsupported Event interaction."));
  }
  const service = services.eventsService as EventService;
  try {
    switch (parsed.action) {
      case "leave":
      case "team-leave":
        await (parsed.action === "leave" ? service.leaveEvent : service.leaveEventTeam)({
          guildId,
          eventId: parsed.eventId,
          userId,
        });
        return Response.json(
          buildEphemeralMessage(
            parsed.action === "leave" ? "You left this Event." : "You left the Event Team.",
          ),
        );
      case "manage":
        return Response.json(await renderTeamList(service, guildId, parsed.eventId, userId));
      case "team-create":
        return Response.json({
          type: DISCORD_MODAL_RESPONSE,
          data: buildTeamNameModal(parsed.eventId, parsed.groupId),
        });
      case "team-list":
        return Response.json(await renderTeamList(service, guildId, parsed.eventId, userId));
      case "team-join":
        await service.createEventTeamJoinRequest({
          guildId,
          eventId: parsed.eventId,
          teamId: parsed.teamId,
          userId,
        });
        return Response.json(buildEphemeralMessage("Event Team join request sent."));
      case "team-withdraw":
        await service.withdrawEventTeamJoinRequest({
          guildId,
          eventId: parsed.eventId,
          proposalId: parsed.proposalId,
          userId,
        });
        return Response.json(buildEphemeralMessage("Event Team request withdrawn."));
      case "team-accept":
        await service.acceptEventTeamInvitation({
          guildId,
          eventId: parsed.eventId,
          proposalId: parsed.proposalId,
          userId,
        });
        return Response.json(buildEphemeralMessage("Event Team invitation accepted."));
      case "team-decline":
        await service.declineEventTeamInvitation({
          guildId,
          eventId: parsed.eventId,
          proposalId: parsed.proposalId,
          userId,
        });
        return Response.json(buildEphemeralMessage("Event Team invitation declined."));
      case "team-open":
      case "team-close":
        await service.setEventTeamRequestsOpen({
          guildId,
          eventId: parsed.eventId,
          teamId: parsed.teamId,
          captainUserId: userId,
          open: parsed.action === "team-open",
        });
        return Response.json(
          buildEphemeralMessage(
            parsed.action === "team-open" ? "Join requests opened." : "Join requests closed.",
          ),
        );
      case "team-reject":
        await service.rejectEventTeamJoinRequest({
          guildId,
          eventId: parsed.eventId,
          proposalId: parsed.proposalId,
          captainUserId: userId,
        });
        return Response.json(buildEphemeralMessage("Join request rejected."));
      case "team-remove":
        await service.captainRemoveEventTeamMember({
          guildId,
          eventId: parsed.eventId,
          teamId: parsed.teamId,
          captainUserId: userId,
          userId: parsed.userId,
        });
        return Response.json(buildEphemeralMessage("Team member removed."));
      case "team-transfer":
        await service.transferEventTeamCaptain({
          guildId,
          eventId: parsed.eventId,
          teamId: parsed.teamId,
          captainUserId: userId,
          newCaptainUserId: parsed.userId,
        });
        return Response.json(buildEphemeralMessage("Captain transferred."));
      case "team-disband":
        await service.disbandEventTeam({
          guildId,
          eventId: parsed.eventId,
          teamId: parsed.teamId,
          captainUserId: userId,
        });
        return Response.json(buildEphemeralMessage("Event Team disbanded."));
      case "team-invite":
        await service.inviteEventTeamMember({
          guildId,
          eventId: parsed.eventId,
          teamId: parsed.teamId,
          captainUserId: userId,
          userId: parsed.userId,
        });
        return Response.json(buildEphemeralMessage("Invitation sent."));
      case "signup":
      case "select": {
        const groupId =
          parsed.action === "select" ? readSelectedGroupId(interaction) : parsed.groupId;
        if (!groupId) return Response.json(buildEphemeralMessage("Choose a Signup Group first."));
        const signup = await service.signup({
          guildId,
          eventId: parsed.eventId,
          userId,
          memberRoleIds: readMemberRoleIds(interaction),
          groupId,
        });
        return Response.json(
          buildEphemeralMessage(
            signup.status === "confirmed" ? "You are signed up." : "You are on the waitlist.",
          ),
        );
      }
    }
  } catch (error) {
    rethrowDiscordRateLimit(error);
    return Response.json(
      buildEphemeralMessage(
        error instanceof EventConfigError ? error.message : "Unable to update this Event.",
      ),
    );
  }
}

export async function handleEventsModalSubmitInteraction(
  interaction: DiscordInteraction,
  services: Pick<ServiceFactory, "eventsService">,
): Promise<Response> {
  const customId = getInteractionCustomId(interaction);
  const match = customId?.match(/^event:team-create-modal:([^:]+):(.+)$/);
  const guildId = interaction.guild_id;
  const userId = getInteractionUserId(interaction);
  if (!match || typeof guildId !== "string" || !userId)
    return Response.json(buildEphemeralMessage("Unsupported Event modal."));
  const values = parseInteractionModalFieldValues(interaction);
  const name = values.name?.trim();
  if (!name) return Response.json(buildEphemeralMessage("Enter an Event Team name."));
  try {
    await (services.eventsService as EventService).createEventTeam({
      guildId,
      eventId: match[1],
      groupId: match[2],
      userId,
      name,
    });
    return Response.json(buildEphemeralMessage("Event Team created."));
  } catch (error) {
    rethrowDiscordRateLimit(error);
    return Response.json(
      buildEphemeralMessage(
        error instanceof EventConfigError ? error.message : "Unable to create the Event Team.",
      ),
    );
  }
}

export function isEventComponentInteraction(interaction: DiscordInteraction): boolean {
  const customId = getInteractionCustomId(interaction);
  return typeof customId === "string" && parseEventCustomId(customId) !== null;
}

export function isEventModalSubmitInteraction(interaction: DiscordInteraction): boolean {
  return /^event:team-create-modal:[^:]+:.+/.test(getInteractionCustomId(interaction) ?? "");
}

function buildTeamNameModal(eventId: string, groupId: string) {
  return {
    custom_id: `event:team-create-modal:${eventId}:${groupId}`,
    title: "Create Event Team",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "name",
            label: "Event Team name",
            style: 1,
            min_length: 2,
            max_length: 40,
            required: true,
            placeholder: "e.g. The A-Team",
          },
        ],
      },
    ],
  };
}

async function renderTeamList(
  service: EventService,
  guildId: string,
  eventId: string,
  userId: string,
): Promise<ReturnType<typeof buildEphemeralMessage>> {
  if (typeof service.getEventTeamManagementView === "function") {
    const view = await service.getEventTeamManagementView({ guildId, eventId, userId });
    const teams = Array.isArray(view?.teams) ? view.teams : [];
    const teamText =
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
    const proposals = Array.isArray(view?.actionableProposals) ? view.actionableProposals : [];
    const proposalText = formatActionableProposals(proposals, userId, eventId);
    const ownState = view?.membership
      ? `Your Event Team: ${view.membership.teamId}`
      : view?.signups?.length
        ? "You are in the unassigned pool."
        : "You are not signed up.";
    const eligiblePool = Array.isArray(view?.eligibleUnassignedParticipants)
      ? view.eligibleUnassignedParticipants
      : [];
    const recruitmentText =
      eligiblePool.length > 0
        ? `\nEligible unassigned participants: ${eligiblePool
            .map((participant: any) => `<@${participant.userId}> (${participant.status})`)
            .join(", ")}`
        : "";
    return buildEphemeralMessage(
      boundDiscordContent(
        `${ownState}\nPending proposals: ${proposals.length}${proposalText}${recruitmentText}\n\n${teamText}`,
      ),
    );
  }
  if (typeof service.listEventTeams !== "function")
    return buildEphemeralMessage(
      "Team listing is not available yet. Use `/event manage` after the Event is refreshed.",
    );
  const teams = await service.listEventTeams({ guildId, eventId });
  const text =
    Array.isArray(teams) && teams.length
      ? teams
          .map(
            (team: any) =>
              `• **${team.name}** (${team.id})${team.openToRequests ? " · requests open" : ""}`,
          )
          .join("\n")
      : "No Event Teams have been created.";
  return buildEphemeralMessage(text);
}

function formatActionableProposals(proposals: any[], userId: string, eventId: string): string {
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

function readSelectedGroupId(interaction: DiscordInteraction): string | null {
  if (!isRecord(interaction.data) || !Array.isArray(interaction.data.values)) return null;
  const [value] = interaction.data.values;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readMemberRoleIds(interaction: DiscordInteraction): string[] {
  const roles = interaction.member?.roles;
  return Array.isArray(roles)
    ? roles.filter((role): role is string => typeof role === "string")
    : [];
}

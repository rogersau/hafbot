import { buildEphemeralMessage } from "../discord-interactions";
import type { BanCaseService } from "../services/ban-case-service";
import type { DiscordInteraction, RuntimeStores } from "./app-types";
import { getInteractionCustomId, getInteractionUserId } from "./discord-interaction-parsers";
import { hasInteractionAdminAccess } from "./interaction-admin-access";
import {
  GUILD_BOUND_INTERACTION_DENIAL_MESSAGE,
  isInteractionBoundToGuild,
} from "./interaction-guild-binding";

const COMPLETE_PREFIX = "ban-case:complete:";

export function isBanCaseComponentInteraction(interaction: DiscordInteraction): boolean {
  return parseCompleteCustomId(getInteractionCustomId(interaction)) !== null;
}

export async function handleBanCaseComponentInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  service: BanCaseService,
): Promise<Response> {
  const customId = getInteractionCustomId(interaction);
  const parsed = parseCompleteCustomId(customId);
  if (!parsed) {
    return Response.json(buildEphemeralMessage("Unsupported Ban Case action."));
  }

  const { guildId, caseId } = parsed;
  if (!isInteractionBoundToGuild(interaction, guildId)) {
    return Response.json(buildEphemeralMessage(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE));
  }

  const banCase = await stores.banCases.readBanCase(guildId, caseId);
  if (!banCase) {
    return Response.json(buildEphemeralMessage("This Ban Case was not found."));
  }
  if (!isInteractionBoundToGuild(interaction, guildId, banCase.guildId)) {
    return Response.json(buildEphemeralMessage(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE));
  }

  const config = await stores.banCases.readConfig(banCase.guildId);
  if (!config) {
    return Response.json(buildEphemeralMessage("Ban Case is not configured for this guild."));
  }
  if (banCase.status !== "new") {
    return Response.json(buildEphemeralMessage("This Ban Case has already been handled."));
  }

  const authorized = config.modRoleIds.length
    ? getInteractionMemberRoles(interaction).some((roleId) => config.modRoleIds.includes(roleId))
    : await hasInteractionAdminAccess(interaction, stores);
  if (!authorized) {
    return Response.json(buildEphemeralMessage("Only Ban Case moderators can complete this case."));
  }

  const actorUserId = getInteractionUserId(interaction);
  if (!actorUserId) {
    return Response.json(buildEphemeralMessage("Could not determine your Discord user."));
  }

  const updated = await service.markCompleted(guildId, caseId, actorUserId, config);
  if (!updated) {
    return Response.json(buildEphemeralMessage("This Ban Case has already been handled."));
  }

  return Response.json(buildEphemeralMessage("Ban Case marked completed."));
}

interface ParsedComplete {
  guildId: string;
  caseId: string;
}

function parseCompleteCustomId(customId: string | null): ParsedComplete | null {
  if (!customId?.startsWith(COMPLETE_PREFIX)) {
    return null;
  }
  const remainder = customId.slice(COMPLETE_PREFIX.length);
  const separatorIndex = remainder.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  const guildId = remainder.slice(0, separatorIndex);
  const caseId = remainder.slice(separatorIndex + 1);
  if (!guildId || !caseId) {
    return null;
  }
  return { guildId, caseId };
}

function getInteractionMemberRoles(interaction: DiscordInteraction): string[] {
  const roles = interaction.member?.roles;
  return Array.isArray(roles)
    ? roles.filter((roleId): roleId is string => typeof roleId === "string")
    : [];
}

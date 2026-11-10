import type { DiscordInteraction } from "./app-types";

export const GUILD_BOUND_INTERACTION_DENIAL_MESSAGE =
  "This action is not available in this server.";

export function isInteractionBoundToGuild(
  interaction: DiscordInteraction,
  ...targetGuildIds: string[]
): boolean {
  const interactionGuildId = interaction.guild_id;
  return (
    typeof interactionGuildId === "string" &&
    interactionGuildId.length > 0 &&
    targetGuildIds.length > 0 &&
    targetGuildIds.every((guildId) => guildId === interactionGuildId)
  );
}

import { buildEphemeralMessage } from "../discord-interactions";
import type { DiscordInteraction } from "../runtime/app-types";
import { rethrowDiscordRateLimit } from "../runtime/interaction-rate-limit";
import { getInteractionUserId } from "../runtime/discord-interaction-parsers";
import { isRecord } from "../unknown-parse";
import { z } from "zod";
import type { ReputationService } from "./service";
import { ReputationError } from "./types";

export function isReputationInteraction(interaction: DiscordInteraction) {
  return interaction.type === 2 && isRecord(interaction.data) && interaction.data.name === "rep";
}

export async function handleReputationInteraction(
  interaction: DiscordInteraction,
  service: ReputationService,
): Promise<Response> {
  const guildId = interaction.guild_id;
  const giverId = getInteractionUserId(interaction);
  if (!guildId || !giverId || !isRecord(interaction.data))
    return ephemeral("Use this command inside a server.");
  const subcommand = Array.isArray(interaction.data.options) ? interaction.data.options[0] : null;
  if (!isRecord(subcommand)) return ephemeral("Choose a Reputation command.");
  const options = Array.isArray(subcommand.options) ? subcommand.options : [];
  const option = (name: string) => options.find((entry) => isRecord(entry) && entry.name === name);
  const userOption = option("user");
  const targetId =
    isRecord(userOption) && typeof userOption.value === "string" ? userOption.value : null;
  try {
    if (subcommand.name === "give") {
      if (!interaction.id || !targetId) return ephemeral("Choose a member to thank.");
      const reasonOption = option("reason");
      const reason =
        isRecord(reasonOption) && typeof reasonOption.value === "string"
          ? reasonOption.value
          : undefined;
      const result = await service.give({
        guildId,
        interactionId: interaction.id,
        giverId,
        recipientId: targetId,
        reason,
      });
      return ephemeral(
        `${result.duplicate ? "This thanks was already recorded for" : "Thanks recorded for"} **${publicName(result.displayName)}**. Reputation: **${result.total}**.`,
      );
    }
    if (subcommand.name === "profile") {
      const result = await service.profile(guildId, targetId ?? giverId);
      return publicMessage(
        `**${publicName(result.displayName)}** has **${result.total}** reputation.`,
      );
    }
    if (subcommand.name === "leaderboard") {
      const entries = await service.leaderboard(guildId);
      return publicMessage(
        entries.length
          ? `**Reputation leaders**\n${entries.map((entry, index) => `${index + 1}. ${publicName(entry.displayName)} — **${entry.total}**`).join("\n")}`
          : "No current members have reputation yet. Thank a helpful teammate with `/rep give`.",
      );
    }
    return ephemeral("Unknown Reputation command.");
  } catch (error) {
    rethrowDiscordRateLimit(error);
    if (error instanceof ReputationError) return ephemeral(error.message);
    if (error instanceof z.ZodError)
      return ephemeral("Invalid Reputation request. Check the selected member and try again.");
    throw error;
  }
}

function publicName(value: string) {
  return value
    .replace(/[\r\n]/g, " ")
    .slice(0, 80)
    .replace(/[\\`*_~|<>@]/g, "\\$&");
}
const ephemeral = (content: string) => Response.json(buildEphemeralMessage(content));
const publicMessage = (content: string) =>
  Response.json({ type: 4, data: { content, allowed_mentions: { parse: [] } } });

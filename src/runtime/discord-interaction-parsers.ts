import { isRecord } from "../unknown-parse";
import type { DiscordInteraction } from "./app-types";
import { resolveInteractionDisplayName } from "./discord-user";

export function getInteractionCustomId(interaction: DiscordInteraction): string | null {
  if (!isRecord(interaction.data)) {
    return null;
  }

  return asOptionalString(interaction.data.custom_id);
}

export function getInteractionUserId(interaction: DiscordInteraction): string | null {
  return asOptionalString(interaction.member?.user?.id) ?? asOptionalString(interaction.user?.id);
}

export function getInteractionUserDisplayName(interaction: DiscordInteraction): string | null {
  return resolveInteractionDisplayName(interaction);
}

export function getInteractionTargetMessage(interaction: DiscordInteraction): unknown | null {
  if (!isRecord(interaction.data)) return null;
  const targetId = asOptionalString(interaction.data.target_id);
  if (!targetId || !isRecord(interaction.data.resolved)) return null;
  const messages = interaction.data.resolved.messages;
  return isRecord(messages) ? (messages[targetId] ?? null) : null;
}

export function parseInteractionModalFieldValues(interaction: {
  data?: unknown;
}): Record<string, string> {
  const values: Record<string, string> = {};
  const data = isRecord(interaction.data) ? interaction.data : undefined;
  const rows = data && Array.isArray(data.components) ? data.components : [];
  for (const row of rows) {
    const components = isRecord(row) && Array.isArray(row.components) ? row.components : [];
    for (const component of components) {
      if (!isRecord(component) || typeof component.custom_id !== "string") continue;
      values[component.custom_id] = typeof component.value === "string" ? component.value : "";
    }
  }
  return values;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

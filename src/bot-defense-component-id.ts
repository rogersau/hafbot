export type BotDefenseModerationAction = "confirm" | "dismiss";

export type ParsedBotDefenseComponentId =
  | {
      kind: "generation";
      action: BotDefenseModerationAction;
      guildId: string;
      userId: string;
      createdAtMs: number;
    }
  | {
      kind: "legacy";
      action: BotDefenseModerationAction;
      guildId: string;
      userId: string;
    };

export function buildBotDefenseComponentId(
  action: BotDefenseModerationAction,
  guildId: string,
  userId: string,
  createdAtMs: number,
): string {
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new Error("Bot Defense flag generation must be a non-negative safe integer.");
  }
  return `bot-defense:${action}:${guildId}:${userId}:${createdAtMs}`;
}

export function parseBotDefenseComponentId(
  customId: string | null,
): ParsedBotDefenseComponentId | null {
  if (!customId) return null;
  const parts = customId.split(":");
  if (parts[0] !== "bot-defense") return null;

  const action = parseAction(parts[1]);
  const guildId = parts[2];
  const userId = parts[3];
  if (!action || !guildId || !userId) return null;

  if (parts.length === 4) {
    return { kind: "legacy", action, guildId, userId };
  }
  if (parts.length !== 5) return null;

  const generationText = parts[4];
  if (!generationText || !/^\d+$/.test(generationText)) return null;
  const createdAtMs = Number(generationText);
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) return null;
  if (String(createdAtMs) !== generationText) return null;

  return { kind: "generation", action, guildId, userId, createdAtMs };
}

function parseAction(value: string | undefined): BotDefenseModerationAction | null {
  return value === "confirm" || value === "dismiss" ? value : null;
}

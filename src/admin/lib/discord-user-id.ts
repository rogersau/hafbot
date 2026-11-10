/** Discord snowflakes accepted by member-targeting admin controls. */
export const DISCORD_USER_ID_PATTERN = /^\d{17,20}$/;

export type DiscordUserIdParseResult =
  | { ok: true; id: string; wasMention: boolean }
  | { ok: false; error: string };

/**
 * Accept a bare Discord user ID or either user mention form and return the
 * numeric ID that existing admin endpoints expect.
 */
export function parseDiscordUserId(value: string): DiscordUserIdParseResult {
  const input = value.trim();
  const mention = input.match(/^<@!?([^>]+)>$/);
  const candidate = mention?.[1] ?? input;

  if (!candidate) {
    return { ok: false, error: "Enter a Discord user ID or @mention." };
  }
  if (!DISCORD_USER_ID_PATTERN.test(candidate)) {
    return {
      ok: false,
      error: "Enter a 17–20 digit Discord user ID or a complete <@user> mention.",
    };
  }

  return { ok: true, id: candidate, wasMention: Boolean(mention) };
}

export function normalizeDiscordUserId(value: string): string | null {
  const parsed = parseDiscordUserId(value);
  return parsed.ok ? parsed.id : null;
}

export function discordUserIdError(value: string): string | null {
  const parsed = parseDiscordUserId(value);
  return parsed.ok ? null : parsed.error;
}

export const DISCORD_USER_ID_HINT =
  "Paste a Discord user ID or @mention. Enable Developer Mode in Discord to copy an ID from a user’s context menu.";

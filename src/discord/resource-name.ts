/** Discord resource names use Unicode code-point semantics for the 100-character limit. */
export const DISCORD_RESOURCE_NAME_MAX_LENGTH = 100;

export function discordResourceNameLength(value: string): number {
  return Array.from(value).length;
}

export function isDiscordResourceNameLengthValid(value: string): boolean {
  return discordResourceNameLength(value) <= DISCORD_RESOURCE_NAME_MAX_LENGTH;
}

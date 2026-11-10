export function discordGuildIconUrl(
  guildId: string,
  iconHash: string | null | undefined,
): string | null {
  if (typeof iconHash !== "string" || iconHash.length === 0) {
    return null;
  }
  const trimmedGuildId = guildId.trim();
  if (!trimmedGuildId) {
    return null;
  }
  return `https://cdn.discordapp.com/icons/${encodeURIComponent(trimmedGuildId)}/${encodeURIComponent(iconHash)}.png`;
}

const STORAGE_KEY = "discord-automation:lastSelectedGuildId";

export function getLastSelectedGuildId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setLastSelectedGuildId(guildId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, guildId);
  } catch {
    // persistence is a nice-to-have
  }
}

export interface DiscordAccountStore {
  readDiscordAccessToken(userId: string): Promise<string | null>;
}

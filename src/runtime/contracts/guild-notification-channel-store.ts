export interface GuildNotificationChannelStore {
  readGuildNotificationChannel(guildId: string, feature: string): Promise<string | null>;
  upsertGuildNotificationChannel(body: {
    guildId: string;
    feature: string;
    notificationChannelId: string | null;
  }): Promise<void>;
}

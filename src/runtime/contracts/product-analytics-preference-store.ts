export interface ProductAnalyticsPreferenceStore {
  readEnabled(guildId: string): Promise<boolean>;
  setEnabled(guildId: string, enabled: boolean, updatedAtMs: number): Promise<void>;
}

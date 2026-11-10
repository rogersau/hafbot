import type { UserPreferences } from "../admin-types";

export interface UserPreferencesStore {
  readUserPreferences(userId: string): Promise<UserPreferences | null>;
  upsertUserPreferences(userId: string, preferences: UserPreferences): Promise<void>;
}

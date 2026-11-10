import type { UserPreferences } from "../admin-types";
import { USER_PREFERENCES_LANGUAGES, USER_PREFERENCES_THEMES } from "../admin-types";
import type { UserPreferencesStore } from "../contracts/user-preferences-store";
import type { PostgresDatabaseCapability } from "./postgres-capability";

interface UserPreferencesRow extends Record<string, unknown> {
  hidden_guild_ids_json: string;
  default_guild_id: string | null;
  email_notifications: boolean;
  push_notifications: boolean;
  theme: string;
  language: string;
}

export function createPostgresUserPreferencesStore(
  database: PostgresDatabaseCapability,
): UserPreferencesStore {
  return {
    async readUserPreferences(userId) {
      const rows = await database.query<UserPreferencesRow>(
        `SELECT hidden_guild_ids_json, default_guild_id, email_notifications,
                push_notifications, theme, language
         FROM user_preferences
         WHERE user_id = $1`,
        [userId],
      );
      return rows[0] ? rowToPreferences(rows[0]) : null;
    },

    async upsertUserPreferences(userId, preferences) {
      await database.execute(
        `INSERT INTO user_preferences (
           user_id, hidden_guild_ids_json, default_guild_id, email_notifications,
           push_notifications, theme, language, updated_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id) DO UPDATE SET
           hidden_guild_ids_json = EXCLUDED.hidden_guild_ids_json,
           default_guild_id = EXCLUDED.default_guild_id,
           email_notifications = EXCLUDED.email_notifications,
           push_notifications = EXCLUDED.push_notifications,
           theme = EXCLUDED.theme,
           language = EXCLUDED.language,
           updated_at_ms = EXCLUDED.updated_at_ms`,
        [
          userId,
          JSON.stringify(preferences.hiddenGuildIds),
          preferences.defaultGuildId,
          preferences.emailNotifications,
          preferences.pushNotifications,
          preferences.theme,
          preferences.language,
          Date.now(),
        ],
      );
    },
  };
}

function rowToPreferences(row: UserPreferencesRow): UserPreferences {
  return {
    hiddenGuildIds: parseHiddenGuildIds(row.hidden_guild_ids_json),
    defaultGuildId: row.default_guild_id,
    emailNotifications: row.email_notifications,
    pushNotifications: row.push_notifications,
    theme: USER_PREFERENCES_THEMES.includes(row.theme as UserPreferences["theme"])
      ? (row.theme as UserPreferences["theme"])
      : "system",
    language: USER_PREFERENCES_LANGUAGES.includes(row.language as UserPreferences["language"])
      ? (row.language as UserPreferences["language"])
      : "en",
  };
}

function parseHiddenGuildIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

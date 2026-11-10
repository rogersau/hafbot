import type { PlayerCountStreakReportedStore } from "../../services/player-count-service";
import type { PostgresDatabaseCapability } from "./postgres-capability";

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createPostgresPlayerCountStreakReportedStore(
  database: PostgresDatabaseCapability,
  options: { ttlSeconds?: number; now?: () => Date } = {},
): PlayerCountStreakReportedStore {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error("Player-count streak TTL must be a positive integer.");
  }
  const now = options.now ?? (() => new Date());
  return {
    async isStreakReported(key) {
      const rows = await database.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM player_count_streak_reports
           WHERE report_key = $1 AND expires_at > $2
         ) AS present`,
        [key, now()],
      );
      return rows[0]?.present === true;
    },

    async markStreakReported(key) {
      const writtenAt = now();
      const expiresAt = new Date(writtenAt.getTime() + ttlSeconds * 1_000);
      await database.execute(
        `INSERT INTO player_count_streak_reports (report_key, expires_at, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (report_key) DO UPDATE SET
           expires_at = EXCLUDED.expires_at,
           updated_at = EXCLUDED.updated_at`,
        [key, expiresAt, writtenAt],
      );
    },

    async clearStreakReported(key) {
      await database.execute("DELETE FROM player_count_streak_reports WHERE report_key = $1", [
        key,
      ]);
    },
  };
}

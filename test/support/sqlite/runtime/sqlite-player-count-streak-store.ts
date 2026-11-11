import type { PlayerCountStreakReportedStore } from "../../../../src/services/player-count-service";

const STREAK_REPORTED_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createKvPlayerCountStreakReportedStore(
  kv: KVNamespace,
): PlayerCountStreakReportedStore {
  return {
    async isStreakReported(key) {
      return (await kv.get(key)) !== null;
    },
    async markStreakReported(key) {
      await kv.put(key, "1", { expirationTtl: STREAK_REPORTED_TTL_SECONDS });
    },
    async clearStreakReported(key) {
      await kv.delete(key);
    },
  };
}

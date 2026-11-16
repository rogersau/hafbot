import { createGameAccessStore } from "./postgres-game-access-records";
import type { PostgresDatabaseCapability } from "./postgres-capability";
export function createPostgresGameAccessStore(db: PostgresDatabaseCapability) {
  return createGameAccessStore({
    async rows(sql, values) {
      return db.query<{ data: string }>(sql, values);
    },
  });
}

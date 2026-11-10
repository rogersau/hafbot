import { createGameAccessStore } from "../../commerce/game-access/store";
import type { PostgresDatabaseCapability } from "./postgres-capability";
export function createPostgresGameAccessStore(db: PostgresDatabaseCapability) {
  return createGameAccessStore({
    async rows(sql, values) {
      let index = 0;
      return db.query<{ data: string }>(
        sql.replaceAll("?", () => `$${++index}`),
        values,
      );
    },
  });
}

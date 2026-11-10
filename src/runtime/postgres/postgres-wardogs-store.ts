import { createEnforcementStore } from "../../ban-case-enforcement/store";
import { createWardogsSqlStore } from "../wardogs-sql-store";
import type { PostgresDatabaseCapability } from "./postgres-capability";
export function createPostgresWardogsStore(db: PostgresDatabaseCapability) {
  return createWardogsSqlStore({
    async rows(sql, values) {
      let index = 0;
      return db.query<{ data: string }>(
        sql.replaceAll("?", () => `$${++index}`),
        values,
      );
    },
  });
}

export function createPostgresBanEnforcementStore(db: PostgresDatabaseCapability) {
  return createEnforcementStore({
    batch(statements) {
      return db.transaction(async (tx) => {
        for (const { sql, values } of statements) {
          let index = 0;
          await tx.query(
            sql.replaceAll("?", () => `$${++index}`),
            values,
          );
        }
      });
    },
    async rows(sql, values) {
      let index = 0;
      return db.query<{ data: string }>(
        sql.replaceAll("?", () => `$${++index}`),
        values,
      );
    },
  });
}

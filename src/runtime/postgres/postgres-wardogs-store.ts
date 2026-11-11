import { createEnforcementStore } from "./postgres-enforcement-records";
import { createWardogsSqlStore } from "./postgres-wardogs-records";
import type { PostgresDatabaseCapability } from "./postgres-capability";
export function createPostgresWardogsStore(db: PostgresDatabaseCapability) {
  return createWardogsSqlStore({
    async rows(sql, values) {
      return db.query<{ data: string }>(sql, values);
    },
  });
}

export function createPostgresBanEnforcementStore(db: PostgresDatabaseCapability) {
  return createEnforcementStore({
    batch(statements) {
      return db.transaction(async (tx) => {
        for (const { sql, values } of statements) {
          await tx.query(sql, values);
        }
      });
    },
    async rows(sql, values) {
      return db.query<{ data: string }>(sql, values);
    },
  });
}

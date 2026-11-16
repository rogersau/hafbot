import { createEnforcementStore } from "../ban-case-enforcement/store";
import { createWardogsSqlStore } from "./wardogs-sql-store";
export function createSqliteWardogsStore(db: D1Database) {
  return createWardogsSqlStore({
    async rows(sql, values) {
      return (
        await db
          .prepare(sql)
          .bind(...values)
          .all<{ data: string }>()
      ).results;
    },
  });
}

export function createSqliteBanEnforcementStore(db: D1Database) {
  return createEnforcementStore({
    async batch(statements) {
      await db.batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values)));
    },
    async rows(sql, values) {
      return (
        await db
          .prepare(sql)
          .bind(...values)
          .all<{ data: string }>()
      ).results;
    },
  });
}

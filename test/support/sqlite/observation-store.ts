import { createObservationStore } from "./server-levels/observations/store";
export function createSqliteObservationStore(db: D1Database) {
  return createObservationStore({
    async rows(sql, values) {
      return (
        await db
          .prepare(sql)
          .bind(...values)
          .all<{ data: string; duplicates?: number; late?: number }>()
      ).results;
    },
    async batch(statements) {
      const results = await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.values)));
      return results.map((result) => result.meta.changes);
    },
  });
}

export * from "../../../src/runtime/attendance-observation-runtime";

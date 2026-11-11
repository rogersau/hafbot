import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { unifiedSchema } from "../db/unified-schema";

export type AppDrizzleDatabase = DrizzleD1Database<typeof unifiedSchema>;

const drizzleDatabaseCache = new WeakMap<D1Database, AppDrizzleDatabase>();

export function createD1DrizzleDatabase(database: D1Database): AppDrizzleDatabase {
  const cached = drizzleDatabaseCache.get(database);
  if (cached) {
    return cached;
  }

  const db = drizzle(database, { schema: unifiedSchema });
  drizzleDatabaseCache.set(database, db);
  return db;
}

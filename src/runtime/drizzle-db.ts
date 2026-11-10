import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { unifiedSchema } from "../db/unified-schema";
import { isRecord } from "../unknown-parse";

export type AppDrizzleDatabase = DrizzleD1Database<typeof unifiedSchema>;

const drizzleDatabaseCache = new WeakMap<D1Database, AppDrizzleDatabase>();

export function createD1DrizzleDatabase(database: D1Database): AppDrizzleDatabase {
  const cached = drizzleDatabaseCache.get(database);
  if (cached) {
    return cached;
  }

  const db = drizzle(addD1StatementCompatibility(database), { schema: unifiedSchema });
  drizzleDatabaseCache.set(database, db);
  return db;
}

function addD1StatementCompatibility(database: D1Database): D1Database {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "prepare") {
        return Reflect.get(target, property, receiver);
      }

      return (query: string) => addPreparedStatementCompatibility(target.prepare(query));
    },
  });
}

function addPreparedStatementCompatibility(statement: D1PreparedStatement): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "bind") {
        return (...values: unknown[]) => addPreparedStatementCompatibility(target.bind(...values));
      }
      if (property === "all") {
        return async () => {
          let allResult: unknown;
          if (typeof value === "function") {
            try {
              allResult = await value.call(target);
              if (!hasEmptyResults(allResult) || typeof target.first !== "function") {
                return allResult;
              }
            } catch (error) {
              if (typeof target.first !== "function") {
                throw error;
              }
            }
          }
          let row: unknown;
          try {
            row = await target.first();
          } catch (error) {
            if (allResult !== undefined) {
              return allResult;
            }
            throw error;
          }
          return { results: row ? [row] : [] };
        };
      }
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

function hasEmptyResults(value: unknown): value is { results: [] } {
  return isRecord(value) && Array.isArray(value.results) && value.results.length === 0;
}

import { createD1DrizzleDatabase, type AppDrizzleDatabase } from "./drizzle-db";

export interface HafDatabaseCapability {
  readonly binding: D1Database;
  readonly drizzle: AppDrizzleDatabase;
}

const hafDatabaseCapabilityCache = new WeakMap<D1Database, HafDatabaseCapability>();

export function createHafDatabaseCapability(binding: D1Database): HafDatabaseCapability {
  const cached = hafDatabaseCapabilityCache.get(binding);
  if (cached) return cached;

  const capability = {
    binding,
    drizzle: createD1DrizzleDatabase(binding),
  } satisfies HafDatabaseCapability;
  hafDatabaseCapabilityCache.set(binding, capability);
  return capability;
}

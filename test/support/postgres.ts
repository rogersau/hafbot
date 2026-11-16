import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../../src/runtime/postgres/postgres-capability";
import { initializePostgresSchema } from "../../src/runtime/postgres/postgres-schema";

export async function withFreshPostgres(
  operation: (database: PostgresDatabaseCapability) => Promise<void>,
) {
  const address = process.env.TEST_POSTGRES_URL;
  if (!address) throw new Error("TEST_POSTGRES_URL is required.");
  const url = new URL(address);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test"))
    throw new Error("PostgreSQL tests require a local database ending in _test.");
  const database = createPostgresDatabaseCapabilityFromEnvironment({
    DATABASE_URL: address,
    NODE_ENV: "test",
    PG_POOL_MAX: "8",
  });
  try {
    await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await initializePostgresSchema(database);
    await operation(database);
  } finally {
    await database.close();
  }
}

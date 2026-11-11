import { initializePostgresSchema } from "../dist-node/postgres-schema.mjs";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../dist-node/postgres-capability.mjs";

const database = createPostgresDatabaseCapabilityFromEnvironment(process.env);
try {
  await initializePostgresSchema(database);
  console.info("PostgreSQL is initialized with the current public schema.");
} finally {
  await database.close();
}

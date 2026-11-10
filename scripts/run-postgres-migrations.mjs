import { resolve } from "node:path";

import {
  applyPostgresMigrations,
  checkPostgresMigrations,
  readPostgresMigrations,
} from "../dist-node/postgres-migrations.mjs";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../dist-node/postgres-capability.mjs";

const apply = process.argv.includes("--apply");
const check = process.argv.includes("--check") || !apply;
if (apply && process.argv.includes("--check")) throw new Error("Choose either --check or --apply.");

const database = createPostgresDatabaseCapabilityFromEnvironment(process.env);
try {
  const migrations = await readPostgresMigrations(resolve("migrations/postgres"));
  const status = apply
    ? await applyPostgresMigrations(database, migrations)
    : await checkPostgresMigrations(database, migrations);
  console.info(
    JSON.stringify({
      event: "haf.postgres.migrations",
      mode: apply ? "apply" : "check",
      ...status,
    }),
  );
  if (check && status.pending.length > 0) process.exitCode = 1;
} finally {
  await database.close();
}

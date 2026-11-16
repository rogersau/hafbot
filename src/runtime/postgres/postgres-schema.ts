import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PostgresDatabaseCapability } from "./postgres-capability";

/** Creates the current schema on an empty database. Existing schemas are never upgraded. */
export async function initializePostgresSchema(
  database: PostgresDatabaseCapability,
  schemaFile = resolve("schema/postgres.sql"),
): Promise<void> {
  const schema = await readFile(schemaFile, "utf8");
  const expectedTables = [...schema.matchAll(/^CREATE TABLE public\.(?:"([^"]+)"|([^\s(]+))/gm)]
    .map(([, quoted, unquoted]) => quoted ?? unquoted!)
    .sort();
  if (expectedTables.length === 0) throw new Error("The PostgreSQL installation schema is empty.");
  await database.transaction(async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock($1)", [7_262_511_944]);
    const rows = await transaction.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    if (rows.length === 0) {
      await transaction.execute(schema);
      return;
    }
    if (JSON.stringify(rows.map(({ name }) => name).sort()) !== JSON.stringify(expectedTables)) {
      throw new Error(
        "PostgreSQL must contain the current public schema or be empty for a fresh installation.",
      );
    }
  });
}

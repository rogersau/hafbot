import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PostgresDatabaseCapability, PostgresExecutor } from "./postgres-capability";

const MIGRATION_FILE = /^\d{4}_[a-z0-9][a-z0-9-]*\.sql$/;
const MIGRATION_LOCK_KEY = 7_262_511_944;

export interface PostgresMigration {
  name: string;
  checksum: string;
  sql: string;
}

export interface PostgresMigrationStatus {
  applied: string[];
  pending: string[];
}

export async function readPostgresMigrations(directory: string): Promise<PostgresMigration[]> {
  const names = (await readdir(directory)).filter((name) => MIGRATION_FILE.test(name)).sort();
  if (names.length === 0) throw new Error(`No PostgreSQL migrations found in ${directory}.`);
  const migrations = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(directory, name), "utf8");
      if (!sql.trim()) throw new Error(`PostgreSQL migration ${name} is empty.`);
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
  return migrations;
}

export async function checkPostgresMigrations(
  database: PostgresDatabaseCapability,
  migrations: readonly PostgresMigration[],
): Promise<PostgresMigrationStatus> {
  const applied = await readAppliedMigrations(database);
  validateAppliedMigrations(applied, migrations);
  const appliedNames = new Set(applied.map((migration) => migration.name));
  return {
    applied: migrations
      .filter((migration) => appliedNames.has(migration.name))
      .map(({ name }) => name),
    pending: migrations
      .filter((migration) => !appliedNames.has(migration.name))
      .map(({ name }) => name),
  };
}

export async function applyPostgresMigrations(
  database: PostgresDatabaseCapability,
  migrations: readonly PostgresMigration[],
): Promise<PostgresMigrationStatus> {
  await database.transaction(async (transaction) => {
    // Startup migrations may be attempted by more than one app instance during
    // a rolling release. Serialize them so later instances wait, validate the
    // completed migration set, and continue instead of failing the rollout.
    await transaction.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await transaction.execute(`
      CREATE TABLE IF NOT EXISTS haf_schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const applied = await readAppliedMigrations(transaction);
    validateAppliedMigrations(applied, migrations);
    const appliedNames = new Set(applied.map((migration) => migration.name));
    for (const migration of migrations) {
      if (appliedNames.has(migration.name)) continue;
      await transaction.execute(migration.sql);
      await transaction.execute(
        "INSERT INTO haf_schema_migrations (name, checksum) VALUES ($1, $2)",
        [migration.name, migration.checksum],
      );
    }
  });
  return checkPostgresMigrations(database, migrations);
}

async function readAppliedMigrations(
  database: PostgresExecutor,
): Promise<Array<{ name: string; checksum: string }>> {
  try {
    return await database.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM haf_schema_migrations ORDER BY name",
    );
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    throw error;
  }
}

function validateAppliedMigrations(
  applied: readonly { name: string; checksum: string }[],
  migrations: readonly PostgresMigration[],
): void {
  const available = new Map(migrations.map((migration) => [migration.name, migration.checksum]));
  for (const migration of applied) {
    const checksum = available.get(migration.name);
    if (!checksum)
      throw new Error(`Applied PostgreSQL migration ${migration.name} is missing locally.`);
    if (checksum !== migration.checksum) {
      throw new Error(`Applied PostgreSQL migration ${migration.name} has changed checksum.`);
    }
  }
}

function isUndefinedTable(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as { code?: unknown }).code === "42P01"
  );
}

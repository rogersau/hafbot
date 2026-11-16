import type { SQLWrapper } from "drizzle-orm";
import type { PostgresDatabaseCapability, PostgresValue } from "./postgres-capability";

export interface PostgresCommand {
  statement: string;
  values: readonly PostgresValue[];
}

export function executePostgresCommands(
  database: PostgresDatabaseCapability,
  commands: readonly PostgresCommand[],
) {
  return database.transaction(async (transaction) => {
    const results = [];
    for (const { statement, values } of commands) {
      results.push(await transaction.queryResult(statement, values));
    }
    return results;
  });
}

/** Executes a group of native PostgreSQL statements in order on one transaction. */
export function executePostgresStatements(
  database: PostgresDatabaseCapability,
  statements: readonly SQLWrapper[],
) {
  return database.drizzle.transaction(async (transaction) => {
    const results = [];
    for (const statement of statements) results.push(await transaction.execute(statement));
    return results;
  });
}

// @ts-ignore -- node:sqlite is available in the Node runtime used by these tests.
import { DatabaseSync } from "node:sqlite";
import { currentSchemaSource, type TestSchemaSource } from "./schema-source";

export interface CanonicalSchemaRow {
  type: string;
  name: string;
  tableName: string;
  sql: string | null;
}
export interface TestDatabase {
  readonly d1: D1Database;
  query<T>(sql: string, ...params: unknown[]): T[];
  execRaw(sql: string): void;
  snapshotSchema(): CanonicalSchemaRow[];
  close(): void;
}

export async function createTestDatabase(
  options: { schema?: TestSchemaSource; seed?: (db: D1Database) => Promise<void> } = {},
): Promise<TestDatabase> {
  const adapter = new SqliteD1Database(options.schema);
  if (options.seed) await options.seed(adapter.d1);
  return adapter;
}

export class SqliteD1Database {
  public execCalls = 0;
  public readonly prepareCalls: string[] = [];
  private readonly sqlite = new DatabaseSync(":memory:");

  readonly d1: D1Database;

  constructor(schema: TestSchemaSource = currentSchemaSource()) {
    for (const migration of schema.migrations()) this.sqlite.exec(migration.sql);
    this.d1 = {
      prepare: (query: string) => this.prepare(query),
      batch: (statements: SqliteD1PreparedStatement[]) => this.batch(statements),
      exec: (query: string) => this.exec(query),
      withSession: () => this.withSession(),
    } as never;
  }

  query<T>(sql: string, ...params: unknown[]): T[] {
    return this.sqlite
      .prepare(sql)
      .all(...(params as never[]))
      .map(normalizeRow) as T[];
  }
  execRaw(sql: string): void {
    this.sqlite.exec(sql);
  }
  snapshotSchema(): CanonicalSchemaRow[] {
    return this.query<CanonicalSchemaRow>(
      "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    );
  }
  close(): void {
    this.sqlite.close();
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    this.execCalls += 1;
    this.sqlite.exec(query);
    return { count: 0, duration: 0 };
  }

  prepare(query: string): SqliteD1PreparedStatement {
    this.prepareCalls.push(query);
    return new SqliteD1PreparedStatement(this.sqlite.prepare(query));
  }

  async batch(
    statements: SqliteD1PreparedStatement[],
  ): Promise<Array<{ results: unknown[]; success: true; meta: { changes: number } }>> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  withSession(): SqliteD1Database {
    return this;
  }
}

class SqliteD1PreparedStatement {
  constructor(
    private readonly statement: SqliteStatement,
    private readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteD1PreparedStatement {
    return new SqliteD1PreparedStatement(this.statement, values);
  }

  async first<T>(): Promise<T | null> {
    const row = this.statement.get(...this.values);
    return row ? (normalizeRow(row) as T) : null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.values).map((row) => normalizeRow(row) as T) };
  }

  async raw(): Promise<unknown[][]> {
    return this.statement
      .all(...this.values)
      .map((row) => Object.values(row as Record<string, unknown>));
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.statement.run(...this.values) as { changes?: number };
    return { success: true, meta: { changes: result.changes ?? 0 } };
  }

  runSync(): { results: unknown[]; success: true; meta: { changes: number } } {
    const result = this.statement.run(...this.values) as {
      changes?: number;
      lastInsertRowid?: unknown;
    };
    const changes = result.changes ?? 0;
    return {
      results: [{ changes, last_insert_rowid: result.lastInsertRowid }],
      success: true,
      meta: { changes },
    };
  }
}

type SqliteStatement = {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): unknown;
  columns(): Array<{ name: string }>;
};

function normalizeRow(row: unknown): Record<string, unknown> {
  return { ...(row as Record<string, unknown>) };
}

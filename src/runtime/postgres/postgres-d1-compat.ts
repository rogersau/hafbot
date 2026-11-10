import { Buffer } from "node:buffer";
import type {
  PostgresDatabaseCapability,
  PostgresExecutor,
  PostgresQueryField,
  PostgresValue,
} from "./postgres-capability";

const INT8_OID = 20;
const NUMERIC_OID = 1700;
const BOOLEAN_OID = 16;
const DATE_OIDS = new Set([1082, 1114, 1184]);
const UNSUPPORTED_SQL =
  /\b(?:ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|INSERT\s+OR\s+REPLACE|last_insert_rowid|sqlite_)\b/i;

interface ExecutedStatement<T extends Record<string, unknown>> {
  result: D1Result<T>;
  columns: string[];
}

/**
 * A deliberately strict D1 API bridge backed by PostgreSQL. It exists to keep
 * the already-tested domain adapters usable during the provider migration; it
 * accepts only the SQLite subset present in this repository and fails closed
 * for unsupported SQL instead of attempting general dialect emulation.
 */
export function createPostgresD1CompatibilityDatabase(
  database: PostgresDatabaseCapability,
): D1Database {
  return new PostgresD1CompatibilityDatabase(database) as unknown as D1Database;
}

class PostgresD1CompatibilityDatabase implements D1Database {
  constructor(private readonly database: PostgresDatabaseCapability) {}

  prepare(query: string): D1PreparedStatement {
    return new PostgresD1PreparedStatement(this.database, query, []);
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return this.database.transaction(async (transaction) => {
      const results: D1Result<T>[] = [];
      let previousChanges = 0;
      for (const statement of statements) {
        if (!(statement instanceof PostgresD1PreparedStatement)) {
          throw new Error("PostgreSQL D1 batch received a statement from another database.");
        }
        const executed = await statement.execute<Record<string, unknown>>(
          transaction,
          previousChanges,
        );
        previousChanges = Number(executed.result.meta.changes ?? 0);
        results.push(executed.result as D1Result<T>);
      }
      return results;
    });
  }

  async exec(query: string): Promise<D1ExecResult> {
    const statement = query.trim().replace(/;\s*$/, "");
    if (!statement || hasUnquotedSemicolon(statement)) {
      throw new Error("PostgreSQL D1 exec accepts exactly one statement.");
    }
    const startedAt = performance.now();
    await this.database.queryResult(translateSql(statement, 0).sql);
    return { count: 1, duration: performance.now() - startedAt };
  }

  withSession(_constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    return {
      prepare: (query: string) => this.prepare(query),
      batch: <T = unknown>(statements: D1PreparedStatement[]) => this.batch<T>(statements),
      getBookmark: () => null,
    } as D1DatabaseSession;
  }

  dump(): Promise<ArrayBuffer> {
    return Promise.reject(new Error("PostgreSQL D1 dump is not supported."));
  }
}

class PostgresD1PreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly database: PostgresDatabaseCapability,
    private readonly query: string,
    private readonly values: readonly PostgresValue[],
  ) {
    if (!query.trim()) throw new Error("D1 prepare requires a non-empty SQL statement.");
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new PostgresD1PreparedStatement(this.database, this.query, values.map(toPostgresValue));
  }

  async first<T = unknown>(columnName?: string): Promise<T | null> {
    const executed = await this.execute<Record<string, unknown>>(this.database, 0);
    const row = executed.result.results[0];
    if (!row) return null;
    if (columnName !== undefined) {
      if (!Object.hasOwn(row, columnName)) {
        throw new Error(`D1 first column does not exist: ${columnName}.`);
      }
      return row[columnName] as T;
    }
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return (await this.execute<Record<string, unknown>>(this.database, 0)).result as D1Result<T>;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return (await this.execute<Record<string, unknown>>(this.database, 0)).result as D1Result<T>;
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const executed = await this.execute<Record<string, unknown>>(this.database, 0);
    const values = executed.result.results.map(
      (row) => executed.columns.map((column) => row[column]) as T,
    );
    return options?.columnNames ? ([executed.columns, ...values] as [string[], ...T[]]) : values;
  }

  async execute<T extends Record<string, unknown>>(
    executor: PostgresExecutor,
    previousChanges: number,
  ): Promise<ExecutedStatement<T>> {
    const translated = translateSql(this.query, previousChanges);
    validateBindingCount(translated.parameterCount, this.values.length);
    const startedAt = performance.now();
    const result = await executor.queryResult<Record<string, unknown>>(translated.sql, this.values);
    const duration = performance.now() - startedAt;
    const rows = normalizeRows(result.rows, result.fields) as T[];
    const changes = translated.writes ? result.rowCount : 0;
    return {
      columns: result.fields.map(({ name }) => name),
      result: {
        success: true,
        results: rows,
        meta: {
          duration,
          size_after: 0,
          rows_read: translated.writes ? 0 : result.rowCount,
          rows_written: changes,
          last_row_id: 0,
          changed_db: changes > 0,
          changes,
          served_by_primary: true,
        },
      },
    };
  }
}

function translateSql(
  query: string,
  previousChanges: number,
): {
  sql: string;
  parameterCount: number;
  writes: boolean;
} {
  let sql = query.trim().replace(/;\s*$/, "");
  if (!sql) throw new Error("D1 SQL must not be empty.");
  if (hasUnquotedSemicolon(sql)) throw new Error("D1 prepared statements must contain one query.");
  if (UNSUPPORTED_SQL.test(maskQuotedSql(sql))) {
    throw new Error("D1 SQL uses an unsupported SQLite-only operation.");
  }
  sql = sql.replace(/\bchanges\s*\(\s*\)/gi, String(previousChanges));
  const ignoredInsert = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(maskQuotedSql(sql));
  if (ignoredInsert) {
    sql = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO");
    if (!/\bON\s+CONFLICT\b/i.test(maskQuotedSql(sql))) sql = appendConflictDoNothing(sql);
  }
  sql = rewriteConflictTargets(sql);
  sql = rewriteScalarFunction(sql, "MAX", "GREATEST");
  sql = rewriteScalarFunction(sql, "MIN", "LEAST");
  sql = sql.replace(/\bCAST\s*\(([^()]*)\s+AS\s+INTEGER\s*\)/gi, "CAST($1 AS BIGINT)");
  const placeholders = replacePlaceholders(sql);
  return {
    sql: placeholders.sql,
    parameterCount: placeholders.parameterCount,
    writes: /\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(firstStatementWords(sql)),
  };
}

function rewriteConflictTargets(sql: string): string {
  let output = "";
  let cursor = 0;
  const pattern = /\bON\s+CONFLICT\s*\(/gi;
  for (
    let match = pattern.exec(maskQuotedSql(sql));
    match;
    match = pattern.exec(maskQuotedSql(sql))
  ) {
    const opening = match.index + match[0].lastIndexOf("(");
    const closing = matchingParenthesis(sql, opening);
    output += sql.slice(cursor, opening + 1);
    output += sql.slice(opening + 1, closing).replace(/"(?:[^"]|"")+"\./g, "");
    cursor = closing;
    pattern.lastIndex = closing + 1;
  }
  return cursor === 0 ? sql : output + sql.slice(cursor);
}

function replacePlaceholders(sql: string): { sql: string; parameterCount: number } {
  let output = "";
  let sequential = 0;
  let maximum = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'" || character === '"') {
      const end = quotedEnd(sql, index, character);
      output += sql.slice(index, end + 1);
      index = end;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index + 2);
      if (end < 0) return { sql: output + sql.slice(index), parameterCount: maximum };
      output += sql.slice(index, end + 1);
      index = end;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new Error("D1 SQL has an unterminated block comment.");
      output += sql.slice(index, end + 2);
      index = end + 1;
      continue;
    }
    if (character !== "?") {
      output += character;
      continue;
    }
    let end = index + 1;
    while (/\d/.test(sql[end] ?? "")) end += 1;
    const explicit = sql.slice(index + 1, end);
    const parameter = explicit ? Number(explicit) : (sequential += 1);
    if (!Number.isSafeInteger(parameter) || parameter < 1) {
      throw new Error("D1 SQL has an invalid numbered placeholder.");
    }
    maximum = Math.max(maximum, parameter);
    sequential = Math.max(sequential, parameter);
    output += `$${parameter}`;
    index = end - 1;
  }
  return { sql: output, parameterCount: maximum };
}

function rewriteScalarFunction(sql: string, source: string, target: string): string {
  let output = "";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'" || character === '"') {
      const end = quotedEnd(sql, index, character);
      output += sql.slice(index, end + 1);
      index = end;
      continue;
    }
    const match = sql.slice(index).match(new RegExp(`^${source}\\s*\\(`, "i"));
    if (!match || (index > 0 && /[A-Za-z0-9_]/.test(sql[index - 1]))) {
      output += character;
      continue;
    }
    const opening = index + match[0].lastIndexOf("(");
    const closing = matchingParenthesis(sql, opening);
    const inner = sql.slice(opening + 1, closing);
    const rewrittenInner = rewriteScalarFunction(inner, source, target);
    const name = hasTopLevelComma(inner) ? target : sql.slice(index, opening).trimEnd();
    output += `${name}(${rewrittenInner})`;
    index = closing;
  }
  return output;
}

function appendConflictDoNothing(sql: string): string {
  const masked = maskQuotedSql(sql);
  const returning = masked.search(/\bRETURNING\b/i);
  return returning < 0
    ? `${sql} ON CONFLICT DO NOTHING`
    : `${sql.slice(0, returning)}ON CONFLICT DO NOTHING ${sql.slice(returning)}`;
}

function normalizeRows(
  rows: readonly Record<string, unknown>[],
  fields: readonly PostgresQueryField[],
): Record<string, unknown>[] {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([name, value]) => [
        name,
        normalizeValue(value, fieldByName.get(name)),
      ]),
    ),
  );
}

function normalizeValue(value: unknown, field: PostgresQueryField | undefined): unknown {
  if (value === null || !field) return value;
  if (field.dataTypeId === BOOLEAN_OID) return value === true ? 1 : 0;
  if (field.dataTypeId === INT8_OID || field.dataTypeId === NUMERIC_OID) {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(number) && field.dataTypeId === INT8_OID) {
      throw new Error(
        `PostgreSQL D1 integer is outside JavaScript's safe range: ${String(value)}.`,
      );
    }
    if (!Number.isFinite(number))
      throw new Error(`PostgreSQL D1 numeric is invalid: ${String(value)}.`);
    return number;
  }
  if (DATE_OIDS.has(field.dataTypeId) && value instanceof Date) return value.toISOString();
  return value;
}

function toPostgresValue(value: unknown): PostgresValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date
  ) {
    return value;
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`D1 bind value has unsupported type: ${typeof value}.`);
}

function validateBindingCount(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new Error(`D1 SQL expected ${expected} bound values but received ${actual}.`);
  }
}

function firstStatementWords(sql: string): string {
  return maskQuotedSql(sql)
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

function maskQuotedSql(sql: string): string {
  let output = "";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character !== "'" && character !== '"') {
      output += character;
      continue;
    }
    const end = quotedEnd(sql, index, character);
    output += " ".repeat(end - index + 1);
    index = end;
  }
  return output;
}

function quotedEnd(sql: string, start: number, quote: string): number {
  for (let index = start + 1; index < sql.length; index += 1) {
    if (sql[index] !== quote) continue;
    if (sql[index + 1] === quote) {
      index += 1;
      continue;
    }
    return index;
  }
  throw new Error("D1 SQL has an unterminated quoted value.");
}

function matchingParenthesis(sql: string, opening: number): number {
  let depth = 0;
  for (let index = opening; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'" || character === '"') {
      index = quotedEnd(sql, index, character);
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0) return index;
  }
  throw new Error("D1 SQL has unbalanced parentheses.");
}

function hasTopLevelComma(sql: string): boolean {
  let depth = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'" || character === '"') {
      index = quotedEnd(sql, index, character);
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) return true;
  }
  return false;
}

function hasUnquotedSemicolon(sql: string): boolean {
  return maskQuotedSql(sql).includes(";");
}

export const __testing = {
  replacePlaceholders,
  rewriteConflictTargets,
  rewriteScalarFunction,
  translateSql,
};

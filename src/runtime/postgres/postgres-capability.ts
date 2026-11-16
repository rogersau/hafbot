import { Pool, types as postgresTypes, type PoolClient, type PoolConfig } from "pg";
import { readPostgresSafeInteger } from "./postgres-values";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../db/postgres/schema";

export type PostgresValue = string | number | boolean | Date | Buffer | null;

export interface PostgresQueryField {
  name: string;
  dataTypeId: number;
}

export interface PostgresQueryResult<Row extends object = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
  fields: PostgresQueryField[];
}

export interface PostgresExecutor {
  query<Row extends object = Record<string, unknown>>(
    statement: string,
    values?: readonly PostgresValue[],
  ): Promise<Row[]>;
  queryResult<Row extends object = Record<string, unknown>>(
    statement: string,
    values?: readonly PostgresValue[],
  ): Promise<PostgresQueryResult<Row>>;
  execute(statement: string, values?: readonly PostgresValue[]): Promise<number>;
}

export interface PostgresDatabaseCapability extends PostgresExecutor {
  readonly kind: "postgres";
  readonly drizzle: NodePgDatabase<typeof schema>;
  transaction<T>(operation: (transaction: PostgresExecutor) => Promise<T>): Promise<T>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}

export interface PostgresEnvironment {
  DATABASE_URL?: string;
  PG_POOL_MAX?: string;
  PG_HTTP_POOL_MAX?: string;
  PG_CONNECT_TIMEOUT_MS?: string;
  PG_IDLE_TIMEOUT_MS?: string;
  PG_STATEMENT_TIMEOUT_MS?: string;
  PG_ALLOW_INSECURE_DOCKER_NETWORK?: string;
  NODE_ENV?: string;
}

export interface PostgresConnectionOptions {
  readOnly?: boolean;
}

export function createPostgresDatabaseCapability(config: PoolConfig): PostgresDatabaseCapability {
  return new NodePostgresDatabaseCapability(
    new Pool({
      ...config,
      types: config.types ?? {
        getTypeParser(oid, format) {
          return oid === 20 && format !== "binary"
            ? (value: string) => readPostgresSafeInteger(value, "BIGINT")
            : postgresTypes.getTypeParser(oid, format);
        },
      },
    }),
  );
}

export function createPostgresDatabaseCapabilityFromEnvironment(
  environment: PostgresEnvironment,
  options: PostgresConnectionOptions = {},
): PostgresDatabaseCapability {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for the PostgreSQL runtime.");
  validatePostgresUrl(
    connectionString,
    environment.NODE_ENV === "production",
    readStrictBoolean(
      environment.PG_ALLOW_INSECURE_DOCKER_NETWORK,
      false,
      "PG_ALLOW_INSECURE_DOCKER_NETWORK",
    ),
  );
  return createPostgresDatabaseCapability({
    connectionString,
    application_name: options.readOnly ? "haf-bot-http-read-only" : "haf-bot",
    max: options.readOnly
      ? readPositiveInteger(environment.PG_HTTP_POOL_MAX, 3, "PG_HTTP_POOL_MAX")
      : readPositiveInteger(environment.PG_POOL_MAX, 8, "PG_POOL_MAX"),
    ...(options.readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
    connectionTimeoutMillis: readPositiveInteger(
      environment.PG_CONNECT_TIMEOUT_MS,
      5_000,
      "PG_CONNECT_TIMEOUT_MS",
    ),
    idleTimeoutMillis: readPositiveInteger(
      environment.PG_IDLE_TIMEOUT_MS,
      30_000,
      "PG_IDLE_TIMEOUT_MS",
    ),
    statement_timeout: readPositiveInteger(
      environment.PG_STATEMENT_TIMEOUT_MS,
      15_000,
      "PG_STATEMENT_TIMEOUT_MS",
    ),
    query_timeout: 20_000,
  });
}

class NodePostgresDatabaseCapability implements PostgresDatabaseCapability {
  readonly kind = "postgres" as const;
  readonly drizzle: NodePgDatabase<typeof schema>;

  constructor(private readonly pool: Pool) {
    this.drizzle = drizzle(pool, { schema });
  }

  query<Row extends object = Record<string, unknown>>(
    statement: string,
    values: readonly PostgresValue[] = [],
  ): Promise<Row[]> {
    return runQuery<Row>(this.pool, statement, values);
  }

  queryResult<Row extends object = Record<string, unknown>>(
    statement: string,
    values: readonly PostgresValue[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    return runQueryResult<Row>(this.pool, statement, values);
  }

  async execute(statement: string, values: readonly PostgresValue[] = []): Promise<number> {
    const result = await this.pool.query(statement, [...values]);
    return result.rowCount ?? 0;
  }

  async transaction<T>(operation: (transaction: PostgresExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(createClientExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

function createClientExecutor(client: PoolClient): PostgresExecutor {
  return {
    query<Row extends object = Record<string, unknown>>(
      statement: string,
      values: readonly PostgresValue[] = [],
    ) {
      return runQuery<Row>(client, statement, values);
    },
    queryResult<Row extends object = Record<string, unknown>>(
      statement: string,
      values: readonly PostgresValue[] = [],
    ) {
      return runQueryResult<Row>(client, statement, values);
    },
    async execute(statement: string, values: readonly PostgresValue[] = []) {
      const result = await client.query(statement, [...values]);
      return result.rowCount ?? 0;
    },
  };
}

async function runQuery<Row extends object = Record<string, unknown>>(
  target: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  statement: string,
  values: readonly PostgresValue[],
): Promise<Row[]> {
  return (await runQueryResult<Row>(target, statement, values)).rows;
}

async function runQueryResult<Row extends object = Record<string, unknown>>(
  target: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  statement: string,
  values: readonly PostgresValue[],
): Promise<PostgresQueryResult<Row>> {
  const result = await target.query(statement, [...values]);
  return {
    rows: result.rows as Row[],
    rowCount: result.rowCount ?? 0,
    fields: result.fields.map((field) => ({ name: field.name, dataTypeId: field.dataTypeID })),
  };
}

function validatePostgresUrl(
  value: string,
  requireTls: boolean,
  allowInsecureDockerNetwork = false,
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql scheme.");
  }
  if (!url.hostname || !url.pathname.slice(1)) {
    throw new Error("DATABASE_URL must include a host and database name.");
  }
  const sslMode = url.searchParams.get("sslmode");
  if (!requireTls) return;
  if (allowInsecureDockerNetwork && url.hostname === "postgres" && sslMode === "disable") {
    return;
  }
  if (sslMode !== "verify-full") {
    throw new Error(
      "Production DATABASE_URL must use sslmode=verify-full. The insecure Docker exception requires an explicit flag, host postgres, and sslmode=disable.",
    );
  }
}

function readStrictBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export const __testing = { validatePostgresUrl };

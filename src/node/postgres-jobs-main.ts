import { parseArgs } from "node:util";

import { createPostgresDatabaseCapabilityFromEnvironment } from "../runtime/postgres/postgres-capability";
import { createPostgresJobQueue } from "../runtime/postgres/postgres-job-queue";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      id: { type: "string" },
      reason: { type: "string" },
      "confirm-target": { type: "string" },
    },
  });
  const command = positionals[0];
  if (!command || positionals.length !== 1) usage();

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const database = createPostgresDatabaseCapabilityFromEnvironment(process.env);
  try {
    const jobs = createPostgresJobQueue(database);
    if (command === "stats") {
      writeResult({ command, queues: await jobs.stats() });
      return;
    }
    if (command === "inspect") {
      const id = requireOption(values.id, "--id");
      writeResult({ command, job: await jobs.inspect(id) });
      return;
    }

    requireTargetConfirmation(databaseUrl, values["confirm-target"]);
    if (command === "retry-one") {
      const id = requireOption(values.id, "--id");
      writeResult({ command, id, changed: await jobs.retryOne(id) });
      return;
    }
    if (command === "discard-one") {
      const id = requireOption(values.id, "--id");
      const reason = requireOption(values.reason, "--reason");
      writeResult({ command, id, reason, changed: await jobs.discardOne(id, reason) });
      return;
    }
    usage();
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "PostgreSQL job operation failed.");
  process.exitCode = 1;
});

function requireTargetConfirmation(databaseUrl: string, confirmation: string | undefined): void {
  const target = targetIdentity(databaseUrl);
  if (confirmation !== target) {
    throw new Error(`Target confirmation must exactly equal ${target}.`);
  }
}

function targetIdentity(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  const database = url.pathname.slice(1);
  if (!url.hostname || !database) throw new Error("DATABASE_URL must include host and database.");
  return `${url.hostname}/${database}`;
}

function requireOption(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function writeResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): never {
  console.error(
    "Usage:\n" +
      "  postgres-jobs stats\n" +
      "  postgres-jobs inspect --id <job-id>\n" +
      "  postgres-jobs retry-one --id <job-id> --confirm-target <host/database>\n" +
      "  postgres-jobs discard-one --id <job-id> --reason <reason-code> --confirm-target <host/database>",
  );
  process.exit(1);
}

export const __testing = { targetIdentity };

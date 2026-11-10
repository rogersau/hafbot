import * as Sentry from "@sentry/node";

import {
  configureOperationalSentryClient,
  reportOperationalEvent,
  type ReporterSentry,
} from "../observability/operational-reporter";
import { redactWebhookSecrets } from "../security/webhook-credentials";
import { createNodeHost } from "./host";
import { createPostgresNodeRuntime } from "./postgres-runtime";
import { parseHafRole } from "./runtime-role";
import type { DiscordE2eActors } from "../runtime/discord-e2e-actors";

export async function startNodeProcess(
  options: { discordE2eActors?: DiscordE2eActors } = {},
): Promise<void> {
  configureSentry();
  const role = parseHafRole(process.env.HAF_ROLE);
  const host = createNodeHost({
    role,
    hostname: process.env.HOST ?? "0.0.0.0",
    port: readPositiveInteger("PORT", 8080, true),
    publicOrigin: readPublicOrigin(),
    staticRoot: process.env.HAF_STATIC_ROOT ?? "dist-admin",
    statusToken: readOptionalString("HAF_STATUS_TOKEN"),
    requireStatusToken: process.env.NODE_ENV === "production",
    maintenanceMode: readBoolean("HAF_MAINTENANCE_MODE", false),
    maxRequestBytes: readPositiveInteger("HAF_MAX_REQUEST_BYTES", 8 * 1024 * 1024),
    maxBackgroundTasks: readPositiveInteger("HAF_MAX_BACKGROUND_TASKS", 100),
    shutdownTimeoutMs: readPositiveInteger("HAF_SHUTDOWN_TIMEOUT_MS", 25_000),
    createRuntime: (lifecycle) =>
      createPostgresNodeRuntime({
        environment: process.env,
        lifecycle,
        discordE2eActors: options.discordE2eActors,
      }),
    onError: (error) =>
      reportOperationalEvent({
        severity: "error",
        code: "node.host_error",
        message: "Node host operation failed",
        cause: error,
        operation: "node_host",
        environment: process.env.NODE_ENV ?? "development",
      }),
  });

  const address = await host.start();
  console.info({
    event: "haf.node.started",
    role,
    address: address.address,
    port: address.port,
    readiness: "postgres_runtime",
  });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info({ event: "haf.node.stopping", signal });
    const result = await host.shutdown(signal);
    console.info({ event: "haf.node.stopped", ...result });
    if (process.env.SENTRY_DSN) await Sentry.close(2_000);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

function configureSentry(): void {
  const dsn = readOptionalString("SENTRY_DSN");
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "production",
    beforeSend: (event) => redactWebhookSecrets(event) as typeof event,
    beforeBreadcrumb: (breadcrumb) => redactWebhookSecrets(breadcrumb) as typeof breadcrumb,
  });
  configureOperationalSentryClient(Sentry as unknown as ReporterSentry);
}

function readOptionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function readPublicOrigin(): string | undefined {
  const value = readOptionalString("HAF_PUBLIC_ORIGIN");
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("HAF_PUBLIC_ORIGIN is required in production.");
  }
  if (!value) return undefined;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("HAF_PUBLIC_ORIGIN must be an HTTPS origin without credentials or a path.");
  }
  return url.origin;
}

function readPositiveInteger(name: string, fallback: number, allowZero = false): number {
  const raw = readOptionalString(name);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(`${name} is outside the supported range.`);
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = readOptionalString(name);
  if (!raw) return fallback;
  if (["true", "1", "yes"].includes(raw.toLowerCase())) return true;
  if (["false", "0", "no"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false.`);
}

export function reportNodeStartupFailure(error: unknown): void {
  reportOperationalEvent({
    severity: "critical",
    code: "node.startup_failed",
    message: "Node host failed to start",
    cause: error,
    operation: "node_startup",
    environment: process.env.NODE_ENV ?? "development",
  });
  process.exitCode = 1;
}

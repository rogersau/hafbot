import { redactWebhookSecrets } from "../security/webhook-credentials";
import { isRecord } from "../unknown-parse";
import { SafeDiagnosticError } from "./safe-diagnostic-error";

export type OperationalSeverity = "warning" | "error" | "critical";

export interface OperationalEvent {
  severity: OperationalSeverity;
  code: string;
  message: string;
  cause?: unknown;
  guildId?: string;
  workspaceId?: string;
  operation?: string;
  environment?: string;
  correlationId?: string;
  observationId?: string;
  rayId?: string;
  context?: unknown;
  captureToSentry?: boolean;
}

const MAX_STRING = 1_000;
const MAX_KEYS = 40;
const MAX_ARRAY = 20;
const MAX_DEPTH = 5;
const CODE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export interface ReporterSentry {
  withScope(callback: (scope: ReporterSentryScope) => void): void;
  captureException(error: unknown): unknown;
  captureMessage(message: string, level?: unknown): unknown;
}

interface ReporterSentryScope {
  setLevel(level: string): void;
  setTag(key: string, value: string): void;
  setContext(key: string, value: Record<string, unknown>): void;
}

const noOpSentry: ReporterSentry = {
  withScope: () => undefined,
  captureException: () => undefined,
  captureMessage: () => undefined,
};
let configuredSentry: ReporterSentry = noOpSentry;
let sentry: ReporterSentry = configuredSentry;

export function configureOperationalSentryClient(client: ReporterSentry): void {
  configuredSentry = client;
  sentry = client;
}

/**
 * Report an operational event. This is deliberately best effort: telemetry
 * must never change the result of the customer operation being observed.
 * Event codes are stable lower-case names (`queue.delivery_failed`). Context
 * is an allowlisted, bounded serialisable object; never pass request bodies,
 * headers, cookies, credentials, or Discord content.
 */
export function reportOperationalEvent(event: OperationalEvent): void {
  try {
    const code = CODE.test(event.code) ? event.code : "invalid_event_code";
    const severity: OperationalSeverity =
      event.severity === "critical" || event.severity === "error" ? event.severity : "warning";
    const safeMessage = truncate(redactText(String(event.message || "Operational event")));
    const safeContext = sanitize(event.context);
    const safeCause = event.cause === undefined ? undefined : sanitize(event.cause);
    const payload = {
      event: "haf.operational",
      severity,
      code,
      message: safeMessage,
      ...(safeCause !== undefined ? { cause: safeCause } : {}),
      ...(event.guildId ? { guildId: truncateId(event.guildId) } : {}),
      ...(event.workspaceId ? { workspaceId: truncateId(event.workspaceId) } : {}),
      ...(event.operation ? { operation: truncate(event.operation, 160) } : {}),
      ...(event.environment ? { environment: truncate(event.environment, 64) } : {}),
      ...(event.correlationId ? { correlationId: truncateId(event.correlationId) } : {}),
      ...(event.observationId ? { observationId: truncateId(event.observationId) } : {}),
      ...(event.rayId ? { rayId: truncateId(event.rayId) } : {}),
      ...(safeContext !== undefined ? { context: safeContext } : {}),
    };
    const cause = event.cause;
    if (severity === "warning") console.warn(payload);
    else console.error(payload);
    if (event.captureToSentry === false) return;

    sentry.withScope((scope) => {
      scope.setLevel(severity === "critical" ? "fatal" : severity);
      scope.setTag("operational_event", "haf.operational");
      scope.setTag("event_code", code);
      scope.setTag("severity", severity);
      if (event.guildId) scope.setTag("guild_id", truncateId(event.guildId));
      if (event.workspaceId) scope.setTag("workspace_id", truncateId(event.workspaceId));
      if (event.operation) scope.setTag("operation", truncate(event.operation, 160));
      if (event.environment) scope.setTag("environment", truncate(event.environment, 64));
      if (event.correlationId) scope.setTag("correlation_id", truncateId(event.correlationId));
      if (event.observationId) scope.setTag("observation_id", truncateId(event.observationId));
      if (event.rayId) scope.setTag("cf_ray", truncateId(event.rayId));
      if (safeContext !== undefined) {
        scope.setContext(
          "operational",
          isStructured(safeContext) ? safeContext : { value: safeContext },
        );
      }
      if (cause instanceof Error) sentry.captureException(redactError(cause));
      else sentry.captureMessage(safeMessage, severity === "critical" ? "fatal" : severity);
    });
  } catch {
    // Minimal fallback only; do not recurse through this reporter.
    try {
      console.error("Operational telemetry failed");
    } catch {
      // Logging itself can be unavailable in unusual test/runtime environments.
    }
  }
}

export function createOperationalReporter(environment: string): typeof reportOperationalEvent {
  return (event) => reportOperationalEvent({ ...event, environment });
}

function truncate(value: string, max = MAX_STRING): string {
  return value.length <= max ? value : `${value.slice(0, max - 14)}…[truncated]`;
}

function truncateId(value: string): string {
  return truncate(value, 200);
}

function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return "[truncated-depth]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[non-finite]";
  if (typeof value === "string") return truncate(redactText(redactWebhookSecrets(value)));
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined")
    return undefined;
  if (value instanceof Error) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return {
      name: diagnosticName(value, depth),
      message: diagnosticMessage(value, depth),
      ...(value.cause !== undefined
        ? { cause: sanitizeNestedCause(value.cause, depth + 1, seen) }
        : {}),
      ...(value instanceof AggregateError
        ? {
            errors: value.errors
              .slice(0, MAX_ARRAY)
              .map((cause: unknown) => sanitizeNestedCause(cause, depth + 1, seen)),
          }
        : {}),
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1, seen));
  }
  if (!isRecord(value)) return undefined;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_KEYS)) {
    if (/authorization|cookie|token|secret|password|webhook|dsn|body|content/i.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    const safe = sanitize(child, depth + 1, seen);
    if (safe !== undefined) output[truncate(key, 100)] = safe;
  }
  return output;
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(token|secret|password|authorization|api[-_]?key)\s*[:=]\s*[^\s,}]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
}

function redactError(error: Error, seen = new WeakSet<object>(), depth = 0): Error {
  if (depth > MAX_DEPTH) return new Error("[truncated-depth]");
  if (seen.has(error)) return new Error("[circular cause]");
  seen.add(error);
  const message = diagnosticMessage(error, depth);
  const safe =
    error instanceof AggregateError
      ? new AggregateError(
          error.errors
            .slice(0, MAX_ARRAY)
            .map((cause: unknown) =>
              cause instanceof Error
                ? redactError(cause, seen, depth + 1)
                : sanitizeNestedCause(cause, depth + 1, seen),
            ),
          message,
        )
      : new Error(message);
  safe.name = diagnosticName(error, depth);
  safe.stack =
    (depth === 0 || error instanceof SafeDiagnosticError) && error.stack
      ? truncate(redactText(redactWebhookSecrets(error.stack)))
      : undefined;
  if (error.cause instanceof Error) safe.cause = redactError(error.cause, seen, depth + 1);
  else if (error.cause !== undefined)
    safe.cause = sanitizeNestedCause(error.cause, depth + 1, seen);
  return safe;
}

function sanitizeNestedCause(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return "[truncated-depth]";
  return value instanceof Error ? sanitize(value, depth, seen) : "[non-error cause omitted]";
}

function diagnosticMessage(error: Error, depth: number): string {
  return depth === 0 || error instanceof SafeDiagnosticError
    ? truncate(redactText(redactWebhookSecrets(error.message)))
    : "[untrusted error details omitted]";
}

function diagnosticName(error: Error, depth: number): string {
  if (depth === 0 || error instanceof SafeDiagnosticError)
    return truncate(redactText(redactWebhookSecrets(error.name)), 100);
  // Error.name can contain upstream data; retain only known built-in categories.
  if (error instanceof AggregateError) return "AggregateError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof ReferenceError) return "ReferenceError";
  return "Error";
}

export const __testing = {
  sanitize,
  truncate,
  setSentryClient(client: ReporterSentry): void {
    sentry = client;
  },
  resetSentryClient(): void {
    sentry = configuredSentry;
  },
};

function isStructured(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

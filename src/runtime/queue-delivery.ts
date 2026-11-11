import type { QueueJobMetadata } from "./queue-types";
import { isRecord } from "../unknown-parse";
import { isDatabaseUnavailable } from "./database-availability";
import { DiscordApiError } from "../discord/client";
import { reportOperationalEvent } from "../observability/operational-reporter";
import { findGuildIdInValue } from "./guild-service-policy";
import type { OperationalSeverity } from "../observability/operational-reporter";

export type QueueParseResult<T> = { ok: true; value: T } | { ok: false; reasonCode: string };

export type QueueDeliveryOutcome =
  | { status: "complete" }
  | { status: "retry"; reasonCode: string; delaySeconds?: number }
  | { status: "terminal"; reasonCode: string };

export type QueueDeliveryFailure = Exclude<QueueDeliveryOutcome, { status: "complete" }>;

export interface QueueDeliveryEvent {
  event: "received" | "completed" | "retried" | "terminal" | "dead_lettered";
  queue: string;
  messageId: string;
  attempts: number;
  durationMs: number;
  reasonCode?: string;
}

export interface QueueDeliveryLogger {
  info?(message: string, event: QueueDeliveryEvent): void;
}

export interface QueueDeliveryOptions<T> {
  metadata: QueueJobMetadata;
  parse(body: unknown): QueueParseResult<T>;
  handle(value: T, metadata: QueueJobMetadata): Promise<QueueDeliveryOutcome>;
  classifyError?(error: unknown): QueueDeliveryFailure;
  emit?(event: QueueDeliveryEvent): void;
  nowMs?: () => number;
  reportOperationalEvent?: typeof reportOperationalEvent;
}

export class QueueTerminalError extends Error {
  constructor(
    readonly reasonCode: string,
    message = reasonCode,
  ) {
    super(message);
    this.name = "QueueTerminalError";
  }
}

export class QueueRetryableError extends Error {
  constructor(
    readonly reasonCode: string,
    readonly delaySeconds?: number,
    message = reasonCode,
  ) {
    super(message);
    this.name = "QueueRetryableError";
  }
}

export function queueDeliveryEmitter(
  logger: QueueDeliveryLogger,
): (event: QueueDeliveryEvent) => void {
  return (event) =>
    logger.info?.("queue_delivery", {
      ...event,
      messageId: safeMessageId(event.messageId),
      attempts: Math.max(0, Math.floor(event.attempts)),
      durationMs: Math.max(0, Math.floor(event.durationMs)),
      ...(event.reasonCode ? { reasonCode: safeReasonCode(event.reasonCode) } : {}),
    });
}

export function classifyQueueDeliveryError(error: unknown): QueueDeliveryFailure {
  if (error instanceof QueueRetryableError) {
    return {
      status: "retry",
      reasonCode: error.reasonCode,
      ...(error.delaySeconds === undefined ? {} : { delaySeconds: error.delaySeconds }),
    };
  }
  if (error instanceof QueueTerminalError) {
    return { status: "terminal", reasonCode: error.reasonCode };
  }
  if (error instanceof DiscordApiError) {
    if (error.status === 408 || error.status === 429) {
      return {
        status: "retry",
        reasonCode: error.status === 429 ? "provider_rate_limited" : "provider_timeout",
        ...(error.retryAfterMs === undefined
          ? {}
          : { delaySeconds: Math.ceil(error.retryAfterMs / 1_000) }),
      };
    }
    if (error.status >= 500) {
      return { status: "retry", reasonCode: "provider_unavailable" };
    }
    return { status: "terminal", reasonCode: "provider_rejected" };
  }
  if (isDatabaseUnavailable(error)) {
    return { status: "retry", reasonCode: "database_unavailable" };
  }
  return { status: "retry", reasonCode: "unexpected_error" };
}

/**
 * Executes one direct delivery for an already-claimed native job.
 *
 * The caller supplies the untrusted payload, native metadata, parser, and the owning consumer's
 * selected ports. Every terminal path returns an explicit outcome; a missing or invalid handler
 * outcome is terminal and is never converted into a fabricated acknowledgement.
 */
export async function deliverQueueJob<T>(
  payload: unknown,
  options: QueueDeliveryOptions<T>,
): Promise<QueueDeliveryOutcome> {
  const metadata = options.metadata;
  const nowMs = options.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  const report = options.reportOperationalEvent ?? reportOperationalEvent;
  emit(options.emit, buildEvent("received", metadata, 0));

  let parsed: QueueParseResult<T>;
  try {
    parsed = options.parse(payload);
  } catch (error) {
    parsed = { ok: false, reasonCode: "parser_exception" };
    reportQueueEvent(report, "warning", metadata, payload, "parser_exception", error, {}, false);
  }

  if (!parsed.ok) {
    if (parsed.reasonCode !== "parser_exception") {
      reportQueueEvent(
        report,
        "warning",
        metadata,
        payload,
        parsed.reasonCode,
        undefined,
        {},
        false,
      );
    }
    const outcome: QueueDeliveryOutcome = { status: "terminal", reasonCode: parsed.reasonCode };
    settleEvent(options, metadata, outcome, startedAtMs, nowMs);
    return outcome;
  }

  let outcome: QueueDeliveryOutcome;
  try {
    outcome = await options.handle(parsed.value, metadata);
  } catch (error) {
    const normalizedFailure = normalizeQueueDeliveryOutcome(
      options.classifyError?.(error) ?? classifyQueueDeliveryError(error),
    );
    const classified: QueueDeliveryFailure =
      normalizedFailure === null || normalizedFailure.status === "complete"
        ? { status: "retry", reasonCode: "unexpected_error" }
        : normalizedFailure;
    reportQueueOutcome(report, metadata, payload, classified, error);
    settleEvent(options, metadata, classified, startedAtMs, nowMs);
    return classified;
  }

  const normalized = normalizeQueueDeliveryOutcome(outcome);
  if (!normalized) {
    const terminal: QueueDeliveryOutcome = {
      status: "terminal",
      reasonCode: "missing_delivery_outcome",
    };
    reportQueueOutcome(
      report,
      metadata,
      payload,
      terminal,
      new Error(`Queue consumer returned no valid delivery outcome for ${metadata.queueName}.`),
    );
    settleEvent(options, metadata, terminal, startedAtMs, nowMs);
    return terminal;
  }

  if (normalized.status !== "complete") {
    reportQueueOutcome(report, metadata, payload, normalized);
  }
  settleEvent(options, metadata, normalized, startedAtMs, nowMs);
  return normalized;
}

export function normalizeQueueDeliveryOutcome(value: unknown): QueueDeliveryOutcome | null {
  if (!isRecord(value)) return null;
  if (value.status === "complete") return { status: "complete" };
  const reasonCode = readReasonCode(value.reasonCode);
  if (!reasonCode) return null;
  if (value.status === "terminal") return { status: "terminal", reasonCode };
  if (value.status !== "retry") return null;
  const delaySeconds = normalizeDelaySeconds(value.delaySeconds);
  return {
    status: "retry",
    reasonCode,
    ...(delaySeconds === undefined ? {} : { delaySeconds }),
  };
}

function readReasonCode(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

function settleEvent<T>(
  options: QueueDeliveryOptions<T>,
  metadata: QueueJobMetadata,
  outcome: QueueDeliveryOutcome,
  startedAtMs: number,
  nowMs: () => number,
): void {
  const durationMs = Math.max(0, nowMs() - startedAtMs);
  if (outcome.status === "complete") {
    emit(options.emit, buildEvent("completed", metadata, durationMs));
    return;
  }
  if (outcome.status === "terminal") {
    emit(options.emit, buildEvent("terminal", metadata, durationMs, outcome.reasonCode));
    return;
  }
  emit(
    options.emit,
    buildEvent(
      exhausted(metadata) ? "dead_lettered" : "retried",
      metadata,
      durationMs,
      outcome.reasonCode,
    ),
  );
}

function reportQueueOutcome(
  report: typeof reportOperationalEvent,
  metadata: QueueJobMetadata,
  payload: unknown,
  outcome: QueueDeliveryFailure,
  cause?: unknown,
): void {
  const terminal = outcome.status === "terminal";
  const isExhausted = outcome.status === "retry" && exhausted(metadata);
  const expected = [
    "provider_rate_limited",
    "provider_timeout",
    "provider_rejected",
    "guild_suspended",
    "gateway_operation_busy",
  ].includes(outcome.reasonCode);
  const severity: OperationalSeverity =
    (terminal && expected) || (!isExhausted && expected) ? "warning" : "error";
  const captureToSentry = !expected && (isExhausted || terminal);
  reportQueueEvent(
    report,
    severity,
    metadata,
    payload,
    outcome.reasonCode,
    cause,
    {
      terminal,
      exhausted: isExhausted,
    },
    captureToSentry,
  );
}

function reportQueueEvent(
  report: typeof reportOperationalEvent,
  severity: OperationalSeverity,
  metadata: QueueJobMetadata,
  payload: unknown,
  reasonCode: string,
  cause?: unknown,
  extraContext: Record<string, unknown> = {},
  captureToSentry = false,
): void {
  try {
    report({
      severity,
      code: `queue.${reasonCode}`,
      message: `Queue delivery ${reasonCode}`,
      cause,
      operation: "queue.delivery",
      guildId: findGuildIdInValue(payload) ?? undefined,
      context: {
        queue: metadata.queueName,
        messageId: metadata.jobId,
        attempts: metadata.attempts,
        reasonCode,
        ...extraContext,
      },
      captureToSentry,
    });
  } catch {
    // Reporting is best effort and cannot alter delivery semantics.
  }
}

function buildEvent(
  event: QueueDeliveryEvent["event"],
  metadata: QueueJobMetadata,
  durationMs: number,
  reasonCode?: string,
): QueueDeliveryEvent {
  return {
    event,
    queue: metadata.queueName,
    messageId: safeMessageId(metadata.jobId),
    attempts: metadata.attempts,
    durationMs,
    ...(reasonCode ? { reasonCode: safeReasonCode(reasonCode) } : {}),
  };
}

function exhausted(metadata: QueueJobMetadata): boolean {
  return metadata.attempts >= Math.max(1, Math.floor(metadata.maxAttempts));
}

function safeReasonCode(value: string): string {
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value) ? value : "invalid_reason_code";
}

function safeMessageId(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : "invalid_message_id";
}

function normalizeDelaySeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(86_400, Math.floor(value)));
}

function emit(
  emitter: ((event: QueueDeliveryEvent) => void) | undefined,
  event: QueueDeliveryEvent,
): void {
  try {
    emitter?.(event);
  } catch {
    // Telemetry must never change message delivery semantics.
  }
}

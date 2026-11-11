import type { QueueMessage } from "./queue-types";
import { isDatabaseUnavailable } from "./database-availability";
import type { QueueBatch } from "./queue-types";
import { DiscordApiError } from "../discord/client";
import { reportOperationalEvent } from "../observability/operational-reporter";
import { findGuildIdInValue } from "./guild-service-policy";
import type { OperationalSeverity } from "../observability/operational-reporter";

// The delivery policy allows three retries after the initial attempt.
export const DEFAULT_QUEUE_MAX_ATTEMPTS = 4;

export type QueueParseResult<T> = { ok: true; value: T } | { ok: false; reasonCode: string };

export type QueueDeliveryOutcome =
  | { status: "complete" }
  | { status: "retry"; reasonCode: string; delaySeconds?: number }
  | { status: "terminal"; reasonCode: string };

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
  maxAttempts: number;
  parse(body: unknown): QueueParseResult<T>;
  handle(value: T): Promise<QueueDeliveryOutcome>;
  classifyError?(error: unknown): Exclude<QueueDeliveryOutcome, { status: "complete" }>;
  emit?(event: QueueDeliveryEvent): void;
  nowMs?: () => number;
  reportOperationalEvent?: typeof reportOperationalEvent;
}

export interface QueueMessageDeliveryOptions {
  maxAttempts: number;
  emit?: (event: QueueDeliveryEvent) => void;
  nowMs?: () => number;
}

export interface QueueMessageDelivery {
  settle(outcome: QueueDeliveryOutcome): void;
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

export function classifyQueueDeliveryError(
  error: unknown,
): Exclude<QueueDeliveryOutcome, { status: "complete" }> {
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

export function beginQueueMessageDelivery(
  queue: string,
  message: QueueMessage<unknown>,
  options: QueueMessageDeliveryOptions,
): QueueMessageDelivery {
  const nowMs = options.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  emit(options.emit, buildEvent("received", queue, message, 0));

  return {
    settle(outcome) {
      const durationMs = Math.max(0, nowMs() - startedAtMs);
      if (outcome.status === "complete") {
        message.ack();
        emit(options.emit, buildEvent("completed", queue, message, durationMs));
        return;
      }

      if (outcome.status === "terminal") {
        message.ack();
        emit(options.emit, buildEvent("terminal", queue, message, durationMs, outcome.reasonCode));
        return;
      }

      message.retry({ delaySeconds: normalizeDelaySeconds(outcome.delaySeconds) });
      emit(
        options.emit,
        buildEvent(
          message.attempts >= maxAttempts ? "dead_lettered" : "retried",
          queue,
          message,
          durationMs,
          outcome.reasonCode,
        ),
      );
    },
  };
}

export async function deliverQueueBatch<T>(
  batch: QueueBatch<unknown>,
  options: QueueDeliveryOptions<T>,
): Promise<void> {
  const report = options.reportOperationalEvent ?? reportOperationalEvent;
  for (const message of batch.messages) {
    const delivery = beginQueueMessageDelivery(batch.queue, message, options);

    let parsed: QueueParseResult<T>;
    try {
      parsed = options.parse(message.body);
    } catch (error) {
      parsed = { ok: false, reasonCode: "parser_exception" };
      reportQueueEvent(
        report,
        "warning",
        batch.queue,
        message,
        "parser_exception",
        error,
        {},
        false,
      );
    }

    if (!parsed.ok) {
      if (parsed.reasonCode !== "parser_exception")
        reportQueueEvent(
          report,
          "warning",
          batch.queue,
          message,
          parsed.reasonCode,
          undefined,
          {},
          false,
        );
      delivery.settle({ status: "terminal", reasonCode: parsed.reasonCode });
      continue;
    }

    let outcome: QueueDeliveryOutcome;
    let reported = false;
    try {
      outcome = await options.handle(parsed.value);
    } catch (error) {
      outcome = options.classifyError?.(error) ?? {
        status: "retry",
        reasonCode: "unexpected_error",
      };
      reportQueueOutcome(report, batch.queue, message, outcome, error, options.maxAttempts);
      reported = true;
    }

    if (!reported && outcome.status !== "complete") {
      reportQueueOutcome(report, batch.queue, message, outcome, undefined, options.maxAttempts);
    }
    delivery.settle(outcome);
  }
}

function reportQueueOutcome(
  report: typeof reportOperationalEvent,
  queue: string,
  message: QueueMessage<unknown>,
  outcome: Exclude<QueueDeliveryOutcome, { status: "complete" }>,
  cause: unknown,
  maxAttempts: number,
): void {
  const terminal = outcome.status === "terminal";
  const exhausted = outcome.status === "retry" && message.attempts >= Math.max(1, maxAttempts);
  const expected = [
    "provider_rate_limited",
    "provider_timeout",
    "provider_rejected",
    "guild_suspended",
    "gateway_operation_busy",
  ].includes(outcome.reasonCode);
  const severity: OperationalSeverity =
    (terminal && expected) || (!exhausted && expected) ? "warning" : "error";
  const captureToSentry = !expected && (exhausted || terminal);
  reportQueueEvent(
    report,
    severity,
    queue,
    message,
    outcome.reasonCode,
    cause,
    {
      terminal,
      exhausted,
    },
    captureToSentry,
  );
}

function reportQueueEvent(
  report: typeof reportOperationalEvent,
  severity: OperationalSeverity,
  queue: string,
  message: QueueMessage<unknown>,
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
      guildId: findGuildIdInValue(message.body) ?? undefined,
      context: {
        queue,
        messageId: message.id,
        attempts: message.attempts,
        reasonCode,
        ...extraContext,
      },
      captureToSentry,
    });
  } catch {
    // Reporting is best effort and cannot alter acknowledgement/retry semantics.
  }
}

function buildEvent(
  event: QueueDeliveryEvent["event"],
  queue: string,
  message: QueueMessage<unknown>,
  durationMs: number,
  reasonCode?: string,
): QueueDeliveryEvent {
  return {
    event,
    queue,
    messageId: safeMessageId(message.id),
    attempts: message.attempts,
    durationMs,
    ...(reasonCode ? { reasonCode: safeReasonCode(reasonCode) } : {}),
  };
}

function safeReasonCode(value: string): string {
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value) ? value : "invalid_reason_code";
}

function safeMessageId(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : "invalid_message_id";
}

function normalizeDelaySeconds(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
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

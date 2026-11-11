/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  classifyQueueDeliveryError,
  deliverQueueJob,
  normalizeQueueDeliveryOutcome,
  queueDeliveryEmitter,
  QueueRetryableError,
  QueueTerminalError,
  type QueueDeliveryEvent,
  type QueueDeliveryOutcome,
  type QueueParseResult,
} from "../src/runtime/queue-delivery";
import { DiscordApiError } from "../src/discord/client";
import type { OperationalEvent } from "../src/observability/operational-reporter";
import { queueJobMetadata } from "./support/queue-delivery-fixture";

test("Queue Delivery returns complete for a direct successful job", async () => {
  const events: QueueDeliveryEvent[] = [];
  const metadata = queueJobMetadata({ jobId: "job-complete", attempts: 1, maxAttempts: 4 });

  const outcome = await deliverQueueJob("work", {
    metadata,
    parse: (body) => ({ ok: true, value: body }),
    handle: async () => ({ status: "complete" }),
    emit: (event) => events.push(event),
  });

  assert.deepEqual(outcome, { status: "complete" });
  assert.deepEqual(
    events.map(({ event, messageId, reasonCode }) => ({ event, messageId, reasonCode })),
    [
      { event: "received", messageId: "job-complete", reasonCode: undefined },
      { event: "completed", messageId: "job-complete", reasonCode: undefined },
    ],
  );
});

test("Queue Delivery preserves the exact retry reason, delay, and native metadata", async () => {
  const events: QueueDeliveryEvent[] = [];
  const metadata = queueJobMetadata({ jobId: "job-retry", attempts: 2, maxAttempts: 5 });
  let nowMs = 1_000;

  const outcome = await deliverQueueJob("work", {
    metadata,
    parse: (body) => ({ ok: true, value: body }),
    handle: async (_value, received) => {
      assert.deepEqual(received, metadata);
      return { status: "retry", reasonCode: "provider_rate_limited", delaySeconds: 17 };
    },
    emit: (event) => events.push(event),
    nowMs: () => {
      const current = nowMs;
      nowMs += 17;
      return current;
    },
  });

  assert.deepEqual(outcome, {
    status: "retry",
    reasonCode: "provider_rate_limited",
    delaySeconds: 17,
  });
  assert.deepEqual(events.at(-1), {
    event: "retried",
    queue: "test-queue",
    messageId: "job-retry",
    attempts: 2,
    durationMs: 17,
    reasonCode: "provider_rate_limited",
  });
});

test("Queue Delivery classifies thrown provider and unexpected failures into retries", async () => {
  const rateLimited = await deliverQueueJob("work", {
    metadata: queueJobMetadata(),
    parse: (body) => ({ ok: true, value: body }),
    handle: async () => {
      throw new DiscordApiError("rate limited", 429, "redacted", { retryAfterMs: 2_500 });
    },
  });
  assert.deepEqual(rateLimited, {
    status: "retry",
    reasonCode: "provider_rate_limited",
    delaySeconds: 3,
  });

  const unexpected = await deliverQueueJob("work", {
    metadata: queueJobMetadata(),
    parse: (body) => ({ ok: true, value: body }),
    handle: async () => {
      throw new Error("temporary failure");
    },
  });
  assert.deepEqual(unexpected, { status: "retry", reasonCode: "unexpected_error" });
});

test("Queue Delivery terminally rejects malformed payloads before handling", async () => {
  let handled = 0;
  const reports: Array<{ severity: string; code: string; captureToSentry?: boolean }> = [];
  const outcome = await deliverQueueJob(
    { version: 1 },
    {
      metadata: queueJobMetadata({ jobId: "job-malformed" }),
      parse(): QueueParseResult<never> {
        return { ok: false, reasonCode: "unsupported_queue_version" };
      },
      async handle() {
        handled += 1;
        return { status: "complete" };
      },
      reportOperationalEvent: (event) =>
        reports.push({
          severity: event.severity,
          code: event.code,
          captureToSentry: event.captureToSentry,
        }),
    },
  );

  assert.deepEqual(outcome, { status: "terminal", reasonCode: "unsupported_queue_version" });
  assert.equal(handled, 0);
  assert.deepEqual(reports, [
    { severity: "warning", code: "queue.unsupported_queue_version", captureToSentry: false },
  ]);
});

test("Queue Delivery terminally rejects parser exceptions before handling", async () => {
  const events: QueueDeliveryEvent[] = [];
  let handled = 0;
  const reports: Array<{ severity: string; code: string }> = [];
  const outcome = await deliverQueueJob("work", {
    metadata: queueJobMetadata({ jobId: "job-parser" }),
    parse() {
      throw new Error("parser exploded");
    },
    async handle() {
      handled += 1;
      return { status: "complete" };
    },
    emit: (event) => events.push(event),
    reportOperationalEvent: (event) => reports.push({ severity: event.severity, code: event.code }),
  });

  assert.deepEqual(outcome, { status: "terminal", reasonCode: "parser_exception" });
  assert.equal(handled, 0);
  assert.equal(events.at(-1)?.event, "terminal");
  assert.equal(events.at(-1)?.reasonCode, "parser_exception");
  assert.deepEqual(reports, [{ severity: "warning", code: "queue.parser_exception" }]);
});

test("Queue Delivery never fabricates complete when a handler returns no outcome", async () => {
  const reports: Array<{ code: string; captureToSentry?: boolean }> = [];
  const outcome = await deliverQueueJob("work", {
    metadata: queueJobMetadata({ jobId: "job-missing" }),
    parse: (body) => ({ ok: true, value: body }),
    handle: (async () => undefined) as unknown as () => Promise<QueueDeliveryOutcome>,
    reportOperationalEvent: (event) =>
      reports.push({ code: event.code, captureToSentry: event.captureToSentry }),
  });

  assert.deepEqual(outcome, { status: "terminal", reasonCode: "missing_delivery_outcome" });
  assert.deepEqual(reports, [{ code: "queue.missing_delivery_outcome", captureToSentry: true }]);
});

test("Queue Delivery uses native job maxAttempts instead of a copied broker limit", async () => {
  const retried: QueueDeliveryEvent[] = [];
  const stillRetrying = await deliverQueueJob("work", {
    metadata: queueJobMetadata({ attempts: 4, maxAttempts: 6 }),
    parse: (body) => ({ ok: true, value: body }),
    handle: async () => ({ status: "retry", reasonCode: "database_unavailable" }),
    emit: (event) => retried.push(event),
  });
  assert.deepEqual(stillRetrying, { status: "retry", reasonCode: "database_unavailable" });
  assert.equal(retried.at(-1)?.event, "retried");

  const exhaustedEvents: QueueDeliveryEvent[] = [];
  const exhausted = await deliverQueueJob("work", {
    metadata: queueJobMetadata({ attempts: 6, maxAttempts: 6 }),
    parse: (body) => ({ ok: true, value: body }),
    handle: async () => ({ status: "retry", reasonCode: "database_unavailable" }),
    emit: (event) => exhaustedEvents.push(event),
  });
  assert.deepEqual(exhausted, { status: "retry", reasonCode: "database_unavailable" });
  assert.equal(exhaustedEvents.at(-1)?.event, "dead_lettered");
  assert.equal(exhaustedEvents.at(-1)?.reasonCode, "database_unavailable");
});

test("Queue Delivery reports one caught failure without changing retry settlement", async () => {
  const reports: Array<{
    severity: string;
    code: string;
    guildId?: string;
    captureToSentry?: boolean;
  }> = [];
  const outcome = await deliverQueueJob(
    { guildId: "guild-1" },
    {
      metadata: queueJobMetadata(),
      parse: (body) => ({ ok: true, value: body }),
      handle: async () => {
        throw new Error("temporary failure");
      },
      reportOperationalEvent: (event) =>
        reports.push({
          severity: event.severity,
          code: event.code,
          guildId: event.guildId,
          captureToSentry: event.captureToSentry,
        }),
    },
  );
  assert.deepEqual(outcome, { status: "retry", reasonCode: "unexpected_error" });
  assert.deepEqual(reports, [
    {
      severity: "error",
      code: "queue.unexpected_error",
      guildId: "guild-1",
      captureToSentry: false,
    },
  ]);
});

test("Queue Delivery reports terminal and exhausted outcomes at the expected severity", async () => {
  const reports: Array<{ severity: string; code: string; captureToSentry?: boolean }> = [];
  const reportOperationalEvent = (event: OperationalEvent) =>
    reports.push({
      severity: event.severity,
      code: event.code,
      captureToSentry: event.captureToSentry,
    });
  const metadata = (reasonCode: string, attempts: number) =>
    queueJobMetadata({ jobId: reasonCode, attempts, maxAttempts: 4 });

  await deliverQueueJob("terminal", {
    metadata: metadata("terminal", 1),
    parse: (body) => ({ ok: true, value: body }),
    handle: async () => ({ status: "terminal", reasonCode: "provider_rejected" }),
    reportOperationalEvent,
  });
  await deliverQueueJob("rate-limited", {
    metadata: metadata("rate-limited", 4),
    parse: (body) => ({ ok: true, value: body }),
    handle: async () => ({ status: "retry", reasonCode: "provider_rate_limited" }),
    reportOperationalEvent,
  });
  await deliverQueueJob("busy", {
    metadata: metadata("busy", 4),
    parse: (body) => ({ ok: true, value: body }),
    handle: async () => {
      throw new QueueRetryableError("gateway_operation_busy", 1);
    },
    reportOperationalEvent,
  });
  await deliverQueueJob("exhausted", {
    metadata: metadata("exhausted", 4),
    parse: (body) => ({ ok: true, value: body }),
    handle: async () => ({ status: "retry", reasonCode: "unexpected_error" }),
    reportOperationalEvent,
  });

  assert.deepEqual(reports, [
    { severity: "warning", code: "queue.provider_rejected", captureToSentry: false },
    { severity: "error", code: "queue.provider_rate_limited", captureToSentry: false },
    { severity: "error", code: "queue.gateway_operation_busy", captureToSentry: false },
    { severity: "error", code: "queue.unexpected_error", captureToSentry: true },
  ]);
});

test("Queue Delivery isolates reporter failures", async () => {
  const outcome = await deliverQueueJob("work", {
    metadata: queueJobMetadata(),
    parse: (body) => ({ ok: true, value: body }),
    handle: async () => ({ status: "terminal", reasonCode: "invalid_configuration" }),
    reportOperationalEvent: () => {
      throw new Error("telemetry unavailable");
    },
  });
  assert.deepEqual(outcome, { status: "terminal", reasonCode: "invalid_configuration" });
});

test("Queue Delivery classifies provider rate limits and permanent configuration failures", () => {
  assert.deepEqual(
    classifyQueueDeliveryError(
      new DiscordApiError("rate limited", 429, "redacted", { retryAfterMs: 2_500 }),
    ),
    { status: "retry", reasonCode: "provider_rate_limited", delaySeconds: 3 },
  );
  assert.deepEqual(classifyQueueDeliveryError(new DiscordApiError("forbidden", 403, "redacted")), {
    status: "terminal",
    reasonCode: "provider_rejected",
  });
  assert.deepEqual(classifyQueueDeliveryError(new DiscordApiError("timeout", 408, "redacted")), {
    status: "retry",
    reasonCode: "provider_timeout",
  });
  assert.deepEqual(
    classifyQueueDeliveryError(
      Object.assign(new Error("database unavailable"), { code: "ECONNREFUSED" }),
    ),
    {
      status: "retry",
      reasonCode: "database_unavailable",
    },
  );
  assert.deepEqual(
    classifyQueueDeliveryError(new QueueTerminalError("invalid_runtime_configuration")),
    { status: "terminal", reasonCode: "invalid_runtime_configuration" },
  );
  assert.deepEqual(classifyQueueDeliveryError(new QueueRetryableError("lease_busy", 12)), {
    status: "retry",
    reasonCode: "lease_busy",
    delaySeconds: 12,
  });
});

test("Queue Delivery outcome normalization rejects unknown shapes", () => {
  assert.deepEqual(normalizeQueueDeliveryOutcome({ status: "complete", extra: true }), {
    status: "complete",
  });
  assert.deepEqual(
    normalizeQueueDeliveryOutcome({ status: "retry", reasonCode: "busy", delaySeconds: 2.9 }),
    { status: "retry", reasonCode: "busy", delaySeconds: 2 },
  );
  assert.deepEqual(normalizeQueueDeliveryOutcome({ status: "terminal", reasonCode: "bad" }), {
    status: "terminal",
    reasonCode: "bad",
  });
  assert.equal(normalizeQueueDeliveryOutcome(undefined), null);
  assert.equal(normalizeQueueDeliveryOutcome({ status: "retry" }), null);
});

test("Queue Delivery sanitizes events emitted by consumers outside the direct executor", () => {
  const calls: unknown[][] = [];
  const emit = queueDeliveryEmitter({ info: (...args) => calls.push(args) });

  emit({
    event: "retried",
    queue: "test-queue",
    messageId: "https://discord.com/api/webhooks/123/secret-token",
    attempts: 1.8,
    durationMs: -10,
    reasonCode: "secret token",
  });

  assert.deepEqual(calls, [
    [
      "queue_delivery",
      {
        event: "retried",
        queue: "test-queue",
        messageId: "invalid_message_id",
        attempts: 1,
        durationMs: 0,
        reasonCode: "invalid_reason_code",
      },
    ],
  ]);
});

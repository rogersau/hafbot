import type { QueueBatch } from "../src/runtime/queue-types";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  classifyQueueDeliveryError,
  deliverQueueBatch,
  queueDeliveryEmitter,
  QueueRetryableError,
  QueueTerminalError,
  type QueueDeliveryEvent,
  type QueueParseResult,
} from "../src/runtime/queue-delivery";
import { DiscordApiError } from "../src/discord/client";

test("Queue Delivery acknowledges completed and terminal siblings while retrying only the failed message", async () => {
  const messages = [
    fakeMessage("complete", 1),
    fakeMessage("retry", 2),
    fakeMessage("malformed", 1),
  ];
  const events: QueueDeliveryEvent[] = [];

  await deliverQueueBatch(fakeBatch("test-queue", messages), {
    maxAttempts: 4,
    parse(body): QueueParseResult<string> {
      return body === "malformed"
        ? { ok: false, reasonCode: "invalid_envelope" }
        : { ok: true, value: String(body) };
    },
    async handle(value) {
      return value === "retry"
        ? { status: "retry", reasonCode: "provider_rate_limited", delaySeconds: 17 }
        : { status: "complete" };
    },
    emit: (event) => events.push(event),
  });

  assert.deepEqual(
    messages.map((message) => message.actions),
    [[{ action: "ack" }], [{ action: "retry", delaySeconds: 17 }], [{ action: "ack" }]],
  );
  assert.deepEqual(
    events.map(({ event, messageId, reasonCode }) => ({ event, messageId, reasonCode })),
    [
      { event: "received", messageId: "message-complete", reasonCode: undefined },
      { event: "completed", messageId: "message-complete", reasonCode: undefined },
      { event: "received", messageId: "message-retry", reasonCode: undefined },
      {
        event: "retried",
        messageId: "message-retry",
        reasonCode: "provider_rate_limited",
      },
      { event: "received", messageId: "message-malformed", reasonCode: undefined },
      { event: "terminal", messageId: "message-malformed", reasonCode: "invalid_envelope" },
    ],
  );
});

test("Queue Delivery classifies unexpected failures without exposing message bodies", async () => {
  const secretBody = "https://discord.com/api/webhooks/123/secret-token";
  const message = fakeMessage(secretBody, 1);
  const events: QueueDeliveryEvent[] = [];

  await deliverQueueBatch(fakeBatch("secret-queue", [message]), {
    maxAttempts: 4,
    parse: (body) => ({ ok: true, value: body }),
    async handle() {
      throw new Error(`failed for ${secretBody}`);
    },
    emit: (event) => events.push(event),
  });

  assert.deepEqual(message.actions, [{ action: "retry", delaySeconds: undefined }]);
  assert.equal(events.at(-1)?.event, "retried");
  assert.equal(events.at(-1)?.reasonCode, "unexpected_error");
  assert.doesNotMatch(JSON.stringify(events), /secret-token|webhooks\/123/);
});

test("Queue Delivery identifies the final retry that Cloudflare will move to the DLQ", async () => {
  const message = fakeMessage("work", 4);
  const events: QueueDeliveryEvent[] = [];

  await deliverQueueBatch(fakeBatch("test-queue", [message]), {
    maxAttempts: 4,
    parse: (body) => ({ ok: true, value: body }),
    handle: async () => ({ status: "retry", reasonCode: "d1_unavailable" }),
    emit: (event) => events.push(event),
  });

  assert.deepEqual(message.actions, [{ action: "retry", delaySeconds: undefined }]);
  assert.equal(events.at(-1)?.event, "dead_lettered");
  assert.equal(events.at(-1)?.reasonCode, "d1_unavailable");
});

test("Queue Delivery reports one caught failure without changing retry settlement", async () => {
  const message = fakeMessage({ guildId: "guild-1" }, 1);
  const reports: Array<{
    severity: string;
    code: string;
    guildId?: string;
    captureToSentry?: boolean;
  }> = [];
  await deliverQueueBatch(fakeBatch("test-queue", [message]), {
    maxAttempts: 4,
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
  });
  assert.deepEqual(message.actions, [{ action: "retry", delaySeconds: undefined }]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.severity, "error");
  assert.equal(reports[0]?.code, "queue.unexpected_error");
  assert.equal(reports[0]?.guildId, "guild-1");
  assert.equal(reports[0]?.captureToSentry, false);
});

test("Queue Delivery reports terminal and exhausted outcomes at the expected severity", async () => {
  const terminal = fakeMessage("terminal", 1);
  const rateLimited = fakeMessage("rate-limited", 4);
  const busy = fakeMessage("busy", 4);
  const exhausted = fakeMessage("exhausted", 4);
  const reports: Array<{ severity: string; code: string; captureToSentry?: boolean }> = [];
  await deliverQueueBatch(fakeBatch("test-queue", [terminal, rateLimited, busy, exhausted]), {
    maxAttempts: 4,
    parse: (body) => ({ ok: true, value: body }),
    classifyError: classifyQueueDeliveryError,
    async handle(value) {
      if (value === "terminal") return { status: "terminal", reasonCode: "provider_rejected" };
      if (value === "rate-limited") return { status: "retry", reasonCode: "provider_rate_limited" };
      if (value === "busy") throw new QueueRetryableError("gateway_operation_busy", 1);
      return { status: "retry", reasonCode: "unexpected_error" };
    },
    reportOperationalEvent: (event) =>
      reports.push({
        severity: event.severity,
        code: event.code,
        captureToSentry: event.captureToSentry,
      }),
  });
  assert.deepEqual(terminal.actions, [{ action: "ack" }]);
  assert.deepEqual(rateLimited.actions, [{ action: "retry", delaySeconds: undefined }]);
  assert.deepEqual(busy.actions, [{ action: "retry", delaySeconds: 1 }]);
  assert.deepEqual(exhausted.actions, [{ action: "retry", delaySeconds: undefined }]);
  assert.deepEqual(reports, [
    { severity: "warning", code: "queue.provider_rejected", captureToSentry: false },
    { severity: "error", code: "queue.provider_rate_limited", captureToSentry: false },
    { severity: "error", code: "queue.gateway_operation_busy", captureToSentry: false },
    { severity: "error", code: "queue.unexpected_error", captureToSentry: true },
  ]);
});

test("Queue Delivery isolates reporter failures", async () => {
  const message = fakeMessage("work", 1);
  await assert.doesNotReject(() =>
    deliverQueueBatch(fakeBatch("test-queue", [message]), {
      maxAttempts: 4,
      parse: (body) => ({ ok: true, value: body }),
      handle: async () => ({ status: "terminal", reasonCode: "invalid_configuration" }),
      reportOperationalEvent: () => {
        throw new Error("telemetry unavailable");
      },
    }),
  );
  assert.deepEqual(message.actions, [{ action: "ack" }]);
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
  assert.deepEqual(classifyQueueDeliveryError(new Error("D1_ERROR: database unavailable")), {
    status: "retry",
    reasonCode: "d1_unavailable",
  });
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

test("Queue Delivery sanitizes events emitted by consumers outside the batch adapter", () => {
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

interface FakeMessage extends Message<unknown> {
  actions: Array<{ action: "ack" } | { action: "retry"; delaySeconds: number | undefined }>;
}

function fakeMessage(body: unknown, attempts: number): FakeMessage {
  const actions: FakeMessage["actions"] = [];
  return {
    id: `message-${String(body)}`,
    timestamp: new Date("2026-07-18T00:00:00Z"),
    body,
    attempts,
    actions,
    ack: () => actions.push({ action: "ack" }),
    retry: (options) => actions.push({ action: "retry", delaySeconds: options?.delaySeconds }),
  };
}

function fakeBatch(queue: string, messages: FakeMessage[]): QueueBatch<unknown> {
  return {
    queue,
    messages,
    ackAll() {},
    retryAll() {},
  };
}

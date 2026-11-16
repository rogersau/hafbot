/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import type {
  TicketLifecycle,
  TicketRecoveryEnvelope,
} from "../src/services/tickets/ticket-lifecycle";
import { deliverTicketRecovery } from "../src/runtime/ticket-recovery-queue-consumer";
import { queueJobMetadata } from "./support/queue-delivery-fixture";

test("ticket recovery queue retries incomplete work and completes later work", async () => {
  const envelope: TicketRecoveryEnvelope = {
    kind: "template-reply-completion",
    recovery: {
      interactionId: "interaction-1",
      botMessageId: "message-1",
      ticket: {} as never,
      template: {} as never,
    },
  };
  let complete = false;
  const lifecycle = {
    async resumeTemplateReplyCompletion() {
      return complete
        ? { ok: true as const, ticket: {} as never, template: {} as never }
        : {
            ok: false as const,
            code: "partial-success" as const,
            message: "still incomplete",
            recovery: envelope.recovery,
          };
    },
  } as unknown as TicketLifecycle;

  const first = await deliverTicketRecovery(
    envelope,
    queueJobMetadata({ jobId: "first", queueName: "ticket-recovery" }),
    lifecycle,
    {} as never,
    "token",
  );
  assert.deepEqual(first, {
    status: "retry",
    reasonCode: "ticket_recovery_incomplete",
    delaySeconds: 60,
  });

  complete = true;
  const second = await deliverTicketRecovery(
    envelope,
    queueJobMetadata({ jobId: "second", queueName: "ticket-recovery" }),
    lifecycle,
    {} as never,
    "token",
  );
  assert.deepEqual(second, { status: "complete" });
});

test("ticket recovery queue terminates malformed messages before touching services", async () => {
  let calls = 0;
  const outcome = await deliverTicketRecovery(
    { kind: "close-cleanup", recovery: {} },
    queueJobMetadata({ jobId: "malformed", queueName: "ticket-recovery" }),
    {
      async resumeOpenCleanup() {
        calls++;
        return { ok: true as const, ticket: {} as never };
      },
    } as unknown as TicketLifecycle,
    {
      async resumeRecovery() {
        calls++;
        return { ok: true as const, value: undefined };
      },
    },
    "token",
  );

  assert.deepEqual(outcome, { status: "terminal", reasonCode: "invalid_ticket_recovery" });
  assert.equal(calls, 0);
});

test("ticket recovery queue consumes trusted panel recovery", async () => {
  const envelope: TicketRecoveryEnvelope = {
    kind: "panel-recovery",
    recovery: {
      operation: "delete",
      guildId: "guild-1",
      panelId: "panel-1",
      channelId: "panel-channel",
      messageId: "message-1",
    },
  };
  let received: unknown;

  const outcome = await deliverTicketRecovery(
    envelope,
    queueJobMetadata({ jobId: "panel", queueName: "ticket-recovery" }),
    {} as TicketLifecycle,
    {
      async resumeRecovery(recovery) {
        received = recovery;
        return { ok: true, value: undefined };
      },
    },
    "token",
  );

  assert.deepEqual(received, envelope.recovery);
  assert.deepEqual(outcome, { status: "complete" });
});

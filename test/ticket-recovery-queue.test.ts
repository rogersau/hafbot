import type { QueueBatch } from "../src/runtime/queue-types";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import type {
  TicketLifecycle,
  TicketRecoveryEnvelope,
} from "../src/services/tickets/ticket-lifecycle";
import { deliverTicketRecoveryQueueBatch } from "../src/runtime/ticket-recovery-queue-consumer";

test("ticket recovery queue retries incomplete work and acknowledges completion", async () => {
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

  const first = createMessageBatch(envelope);
  await deliverTicketRecoveryQueueBatch(first.batch, lifecycle, {} as never, "token");
  assert.equal(first.retries, 1);
  assert.equal(first.acks, 0);

  complete = true;
  const second = createMessageBatch(envelope);
  await deliverTicketRecoveryQueueBatch(second.batch, lifecycle, {} as never, "token");
  assert.equal(second.retries, 0);
  assert.equal(second.acks, 1);
});

test("ticket recovery queue terminates malformed messages", async () => {
  const delivery = createMessageBatch({ kind: "close-cleanup", recovery: {} });

  await deliverTicketRecoveryQueueBatch(
    delivery.batch,
    {} as TicketLifecycle,
    {} as never,
    "token",
  );

  assert.equal(delivery.acks, 1);
  assert.equal(delivery.retries, 0);
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
  const delivery = createMessageBatch(envelope);
  let received: unknown;

  await deliverTicketRecoveryQueueBatch(
    delivery.batch,
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
  assert.equal(delivery.acks, 1);
  assert.equal(delivery.retries, 0);
});

function createMessageBatch(body: unknown): {
  batch: QueueBatch<unknown>;
  readonly acks: number;
  readonly retries: number;
} {
  let acks = 0;
  let retries = 0;
  return {
    batch: {
      queue: "haf-bot-ticket-recovery",
      messages: [
        {
          id: "recovery-1",
          body,
          attempts: 1,
          timestamp: new Date(),
          ack() {
            acks += 1;
          },
          retry() {
            retries += 1;
          },
        },
      ],
      ackAll() {},
      retryAll() {},
    } as QueueBatch<unknown>,
    get acks() {
      return acks;
    },
    get retries() {
      return retries;
    },
  };
}

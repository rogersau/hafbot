import type { QueueBatch } from "../src/runtime/queue-types";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { deliverR2QuotaQueueBatch } from "../src/runtime/r2-quota-queue-consumer";
import type { GuildR2ObjectStore } from "../src/runtime/contracts";
import {
  createProductionRuntimeStores,
  withStoreOverrides,
} from "./support/production-runtime-stores";

test("R2 quota consumer persists valid create and delete notifications", async () => {
  const fixture = createProductionRuntimeStores();
  const store = fixture.stores.guildR2Objects;
  const create = fakeMessage("create", {
    event: "object-create",
    bucket: "haf-bot-new-worker-transcripts",
    object: { key: "guild-1/channel-1.html", size: 1234 },
    eventTime: "2026-05-25T12:34:56.789Z",
  });

  await deliverR2QuotaQueueBatch(fakeBatch([create]), store);

  assert.equal(await store.getGuildUsageBytes("guild-1"), 1234);
  assert.deepEqual(
    fixture.database.query(
      "SELECT object_key, size_bytes, created_at_ms FROM guild_r2_objects WHERE guild_id = ?",
      "guild-1",
    ),
    [
      {
        object_key: "guild-1/channel-1.html",
        size_bytes: 1234,
        created_at_ms: 1_779_712_496_789,
      },
    ],
  );
  assert.deepEqual(create.actions, ["ack"]);

  const remove = fakeMessage("delete", {
    action: "delete",
    bucket: "haf-bot-new-worker-transcripts",
    key: "guild-1/channel-1.html",
    size: 1234,
    timestamp: 1_800_000_000_000,
  });
  await deliverR2QuotaQueueBatch(fakeBatch([remove]), store);

  assert.equal(await store.getGuildUsageBytes("guild-1"), 0);
  assert.deepEqual(remove.actions, ["ack"]);
});

test("R2 quota consumer acknowledges successful siblings and retries only a failed D1 write", async () => {
  const fixture = createProductionRuntimeStores();
  const productionStore = fixture.stores.guildR2Objects;
  const store = withStoreOverrides<GuildR2ObjectStore>(productionStore, {
    async upsertObject(input) {
      if (input.key.endsWith("retry.html")) throw new Error("D1 unavailable");
      await productionStore.upsertObject(input);
    },
  });
  const complete = fakeMessage("complete", {
    event: "object-create",
    object: { key: "guild-1/complete.html", size: 10 },
    eventTime: "2026-05-25T12:34:56.789Z",
  });
  const retry = fakeMessage("retry", {
    event: "object-create",
    object: { key: "guild-1/retry.html", size: 20 },
    eventTime: "2026-05-25T12:34:57.789Z",
  });
  const malformed = fakeMessage("malformed", { event: "object-create" });

  await deliverR2QuotaQueueBatch(fakeBatch([complete, retry, malformed]), store);

  assert.equal(await productionStore.getGuildUsageBytes("guild-1"), 10);
  assert.deepEqual(complete.actions, ["ack"]);
  assert.deepEqual(retry.actions, ["retry"]);
  assert.deepEqual(malformed.actions, ["ack"]);
});

test("R2 quota consumer rejects events without a valid source timestamp", async () => {
  const fixture = createProductionRuntimeStores();
  const missing = fakeMessage("missing-time", {
    event: "object-create",
    object: { key: "guild-1/missing.html", size: 10 },
  });
  const invalid = fakeMessage("invalid-time", {
    event: "object-deleted",
    object: { key: "guild-1/invalid.html", size: 10 },
    eventTime: "not-a-date",
  });

  await deliverR2QuotaQueueBatch(fakeBatch([missing, invalid]), fixture.stores.guildR2Objects);

  assert.equal(await fixture.stores.guildR2Objects.getGuildUsageBytes("guild-1"), 0);
  assert.deepEqual(missing.actions, ["ack"]);
  assert.deepEqual(invalid.actions, ["ack"]);
});

function fakeMessage(id: string, body: unknown) {
  const actions: string[] = [];
  return {
    id,
    body,
    attempts: 1,
    timestamp: new Date(),
    actions,
    ack: () => actions.push("ack"),
    retry: () => actions.push("retry"),
  };
}

function fakeBatch(messages: ReturnType<typeof fakeMessage>[]): QueueBatch<unknown> {
  return {
    queue: "haf-bot-r2-quota",
    messages,
    ackAll() {},
    retryAll() {},
  };
}

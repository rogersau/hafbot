/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { deliverR2Quota } from "../src/runtime/r2-quota-queue-consumer";
import type { GuildR2ObjectStore } from "../src/runtime/contracts";
import {
  createProductionRuntimeStores,
  withStoreOverrides,
} from "./support/production-runtime-stores";
import { queueJobMetadata } from "./support/queue-delivery-fixture";

test("R2 quota consumer persists valid create and delete notifications", async () => {
  const fixture = createProductionRuntimeStores();
  const store = fixture.stores.guildR2Objects;
  const create = await deliverR2Quota(
    {
      event: "object-create",
      bucket: "haf-bot-new-worker-transcripts",
      object: { key: "guild-1/channel-1.html", size: 1234 },
      eventTime: "2026-05-25T12:34:56.789Z",
    },
    queueJobMetadata({ jobId: "create", queueName: "r2-quota" }),
    store,
  );

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
  assert.deepEqual(create, { status: "complete" });

  const remove = await deliverR2Quota(
    {
      action: "delete",
      bucket: "haf-bot-new-worker-transcripts",
      key: "guild-1/channel-1.html",
      size: 1234,
      timestamp: 1_800_000_000_000,
    },
    queueJobMetadata({ jobId: "delete", queueName: "r2-quota" }),
    store,
  );

  assert.equal(await store.getGuildUsageBytes("guild-1"), 0);
  assert.deepEqual(remove, { status: "complete" });
});

test("R2 quota consumer completes successful siblings and retries only a failed D1 write", async () => {
  const fixture = createProductionRuntimeStores();
  const productionStore = fixture.stores.guildR2Objects;
  const store = withStoreOverrides<GuildR2ObjectStore>(productionStore, {
    async upsertObject(input) {
      if (input.key.endsWith("retry.html")) throw new Error("D1 unavailable");
      await productionStore.upsertObject(input);
    },
  });
  const complete = await deliverR2Quota(
    {
      event: "object-create",
      object: { key: "guild-1/complete.html", size: 10 },
      eventTime: "2026-05-25T12:34:56.789Z",
    },
    queueJobMetadata({ jobId: "complete", queueName: "r2-quota" }),
    store,
  );
  const retry = await deliverR2Quota(
    {
      event: "object-create",
      object: { key: "guild-1/retry.html", size: 20 },
      eventTime: "2026-05-25T12:34:57.789Z",
    },
    queueJobMetadata({ jobId: "retry", queueName: "r2-quota" }),
    store,
  );
  let writes = 0;
  const malformed = await deliverR2Quota(
    { event: "object-create" },
    queueJobMetadata({ jobId: "malformed", queueName: "r2-quota" }),
    withStoreOverrides<GuildR2ObjectStore>(productionStore, {
      async upsertObject(input) {
        writes++;
        await productionStore.upsertObject(input);
      },
    }),
  );

  assert.equal(await productionStore.getGuildUsageBytes("guild-1"), 10);
  assert.deepEqual(complete, { status: "complete" });
  assert.deepEqual(retry, { status: "retry", reasonCode: "d1_unavailable" });
  assert.deepEqual(malformed, { status: "terminal", reasonCode: "invalid_r2_event" });
  assert.equal(writes, 0);
});

test("R2 quota consumer rejects events without a valid source timestamp", async () => {
  const fixture = createProductionRuntimeStores();
  const missing = await deliverR2Quota(
    {
      event: "object-create",
      object: { key: "guild-1/missing.html", size: 10 },
    },
    queueJobMetadata({ jobId: "missing-time", queueName: "r2-quota" }),
    fixture.stores.guildR2Objects,
  );
  const invalid = await deliverR2Quota(
    {
      event: "object-deleted",
      object: { key: "guild-1/invalid.html", size: 10 },
      eventTime: "not-a-date",
    },
    queueJobMetadata({ jobId: "invalid-time", queueName: "r2-quota" }),
    fixture.stores.guildR2Objects,
  );

  assert.equal(await fixture.stores.guildR2Objects.getGuildUsageBytes("guild-1"), 0);
  assert.deepEqual(missing, { status: "terminal", reasonCode: "invalid_r2_event" });
  assert.deepEqual(invalid, { status: "terminal", reasonCode: "invalid_r2_event" });
});

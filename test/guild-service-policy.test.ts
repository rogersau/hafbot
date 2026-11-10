/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  GuildServicePolicy,
  GUILD_SERVICE_UNAVAILABLE_MESSAGE,
  isGatewayGuildLifecycleEvent,
} from "../src/runtime/guild-service-policy";
import type { GuildServiceSuspensionStore } from "../src/runtime/contracts";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import { suppressSuspendedQueueMessages } from "../src/index";

test("GuildServicePolicy reads live suspension state and restores immediately", async () => {
  const store = productionSuspensionStore();
  await store.suspendGuild({
    guildId: "guild-1",
    reason: "Internal abuse evidence",
    occurredAtMs: 100,
    actorUserId: "admin-1",
  });
  const policy = new GuildServicePolicy(store);

  assert.equal(await policy.isGuildSuspended("guild-1"), true);
  await store.restoreGuild({ guildId: "guild-1", occurredAtMs: 200, actorUserId: "admin-2" });
  assert.equal(await policy.isGuildSuspended("guild-1"), false);
});

test("GuildServicePolicy customer response never exposes the internal reason", () => {
  const response = GuildServicePolicy.buildUnavailableResponse();

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { error: GUILD_SERVICE_UNAVAILABLE_MESSAGE });
  assert.doesNotMatch(JSON.stringify(response.body), /reason|abuse/i);
});

test("already-queued guild work is acknowledged and removed at the consumer boundary", async () => {
  const acked: string[] = [];
  const makeMessage = (id: string, guildId: string) => ({
    id,
    timestamp: new Date(),
    attempts: 1,
    body: { event: { guild_id: guildId } },
    ack: () => acked.push(id),
    retry: () => {},
  });
  const batch = {
    queue: "gateway-events",
    messages: [makeMessage("blocked", "guild-1"), makeMessage("allowed", "guild-2")],
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<{ event: { guild_id: string } }>;
  const store = createPolicyStore((guildId) => guildId === "guild-1");

  const filtered = await suppressSuspendedQueueMessages(batch, store);

  assert.deepEqual(acked, ["blocked"]);
  assert.deepEqual(
    filtered.messages.map((message) => message.id),
    ["allowed"],
  );
});

test("suspended guild lifecycle events can pass through for removal handling", async () => {
  const body = {
    type: "GUILD_CREATE",
    data: { id: "guild-1", name: "Blocked Guild" },
  };
  const message = {
    id: "blocked-install",
    timestamp: new Date(),
    attempts: 1,
    body,
    ack() {},
    retry() {},
  };
  const batch = {
    queue: "gateway-events",
    messages: [message],
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<typeof body>;

  const filtered = await suppressSuspendedQueueMessages(
    batch,
    createPolicyStore(() => true),
    undefined,
    isGatewayGuildLifecycleEvent,
  );

  assert.deepEqual(
    filtered.messages.map(({ id }) => id),
    ["blocked-install"],
  );
});

test("a suspension lookup failure retries only that message and preserves its siblings", async () => {
  const actions: Array<{ id: string; action: "ack" | "retry" }> = [];
  const makeMessage = (id: string, guildId: string) => ({
    id,
    timestamp: new Date(),
    attempts: 1,
    body: { event: { guild_id: guildId } },
    ack: () => actions.push({ id, action: "ack" }),
    retry: () => actions.push({ id, action: "retry" }),
  });
  const batch = {
    queue: "gateway-events",
    messages: [makeMessage("unavailable", "guild-1"), makeMessage("allowed", "guild-2")],
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<{ event: { guild_id: string } }>;
  const store = createPolicyStore((guildId) => {
    if (guildId === "guild-1") throw new Error("D1 unavailable");
    return false;
  });

  const filtered = await suppressSuspendedQueueMessages(batch, store);

  assert.deepEqual(actions, [{ id: "unavailable", action: "retry" }]);
  assert.deepEqual(
    filtered.messages.map((message) => message.id),
    ["allowed"],
  );
});

test("a final-attempt suspension lookup failure emits dead-letter telemetry", async () => {
  const events: unknown[][] = [];
  const reports: Array<{ captureToSentry?: boolean; context?: unknown }> = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => events.push(args);
  try {
    const message = {
      id: "final-attempt",
      timestamp: new Date(),
      attempts: 4,
      body: { guildId: "guild-1" },
      ack() {},
      retry() {},
    };
    await suppressSuspendedQueueMessages(
      {
        queue: "gateway-events",
        messages: [message],
        ackAll() {},
        retryAll() {},
      } as unknown as MessageBatch<{ guildId: string }>,
      createPolicyStore(() => {
        throw new Error("D1 unavailable");
      }),
      (event) => reports.push(event),
    );
  } finally {
    console.info = originalInfo;
  }

  const finalEvent = events.at(-1)?.[1] as { event?: string } | undefined;
  assert.equal(finalEvent?.event, "dead_lettered");
  assert.equal(reports[0]?.captureToSentry, true);
  assert.deepEqual(reports[0]?.context, {
    queue: "gateway-events",
    messageId: "final-attempt",
    attempts: 4,
    exhausted: true,
  });
});

function createPolicyStore(isSuspended: (guildId: string) => boolean): GuildServiceSuspensionStore {
  const store = productionSuspensionStore();
  store.readActiveSuspension = async (guildId) =>
    isSuspended(guildId)
      ? {
          guildId,
          reason: "secret",
          createdAtMs: 1,
          createdByUserId: "admin",
          removedAtMs: null,
          removedByUserId: null,
        }
      : null;
  return store;
}

function productionSuspensionStore(): GuildServiceSuspensionStore {
  const store = createProductionRuntimeStores().stores.guildServiceSuspensions;
  if (!store) throw new Error("Guild service suspension store is unavailable.");
  return store;
}

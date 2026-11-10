/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  createBillingAssignmentService,
  type BillingAssignmentStore,
  type BillingGuildAssignment,
} from "../src/runtime/billing/assignments";
import type { BillingSubscriptionProjection } from "../src/runtime/billing/types";

const actor = { discordUserId: "user", displayName: "Plan Owner" };

test("Premium assigns one currently manageable installed Guild and rejects stale permission", async () => {
  const store = new MemoryAssignmentStore("premium");
  let eligible = ["guild-1"];
  const service = createBillingAssignmentService({
    store,
    async listEligibleGuilds() {
      return eligible.map((guildId) => ({ guildId, name: guildId, icon: null }));
    },
  });
  await service.assign("owner", actor, "guild-1");
  await assert.rejects(() => service.assign("owner", actor, "guild-2"), /not_currently_manageable/);
  eligible = ["guild-1", "guild-2"];
  await assert.rejects(() => service.assign("owner", actor, "guild-2"), /capacity/);
});

test("Premium Plus permits three assignments, moves immediately, and preserves ownership", async () => {
  const store = new MemoryAssignmentStore("premium_plus");
  const service = createBillingAssignmentService({
    store,
    async listEligibleGuilds() {
      return ["g1", "g2", "g3", "g4"].map((guildId) => ({ guildId, name: guildId, icon: null }));
    },
    now: () => 10,
  });
  await Promise.all([
    service.assign("owner", actor, "g1"),
    service.assign("owner", actor, "g2"),
    service.assign("owner", actor, "g3"),
  ]);
  await assert.rejects(() => service.assign("owner", actor, "g4"), /capacity/);
  await service.move("owner", actor, "g1", "g4");
  assert.deepEqual((await store.listAssignments("owner")).map((row) => row.guildId).sort(), [
    "g2",
    "g3",
    "g4",
  ]);
  await service.unassign("owner", actor, "g2");
  assert.deepEqual(store.dormantGuilds, ["g1", "g2"]);
  assert.deepEqual(
    store.operations.map((operation) => operation.kind),
    [
      "guild_assignment_assigned",
      "guild_assignment_assigned",
      "guild_assignment_assigned",
      "guild_assignment_moved",
      "guild_assignment_unassigned",
    ],
  );
  const moved = JSON.parse(store.operations[3]!.summaryJson);
  assert.deepEqual(moved.fromGuild, { guildId: "g1", name: "g1" });
  assert.deepEqual(moved.toGuild, { guildId: "g4", name: "g4" });
  assert.equal(moved.notifyOwner, true);
});

test("quarantine blocks assignment mutations", async () => {
  const store = new MemoryAssignmentStore("premium");
  store.quarantineReason = "unknown_catalog";
  const service = createBillingAssignmentService({
    store,
    async listEligibleGuilds() {
      return [{ guildId: "g1", name: "g1", icon: null }];
    },
  });
  await assert.rejects(() => service.assign("owner", actor, "g1"), /billing_quarantined/);
  await assert.rejects(() => service.move("owner", actor, "g1", "g2"), /billing_quarantined/);
  await assert.rejects(() => service.unassign("owner", actor, "g1"), /billing_quarantined/);
});

test("assignment moves are blocked unless the Subscription is active", async () => {
  const store = new MemoryAssignmentStore("premium_plus");
  const service = createBillingAssignmentService({
    store,
    async listEligibleGuilds() {
      return ["g1", "g2"].map((guildId) => ({ guildId, name: guildId, icon: null }));
    },
  });
  await service.assign("owner", actor, "g1");
  store.status = "past_due";
  await assert.rejects(
    () => service.move("owner", actor, "g1", "g2"),
    /assignment_move_blocked_during_grace/,
  );
  assert.deepEqual(
    (await store.listAssignments("owner")).map((row) => row.guildId),
    ["g1"],
  );
});

test("billing reports paid access assigned by another plan owner", async () => {
  const store = new MemoryAssignmentStore("premium");
  store.effectivePlans.set("shared-guild", "premium_plus");
  const service = createBillingAssignmentService({
    store,
    async listEligibleGuilds() {
      return [{ guildId: "shared-guild", name: "Shared Guild", icon: null }];
    },
  });

  const result = await service.read("member-owner", "member-discord-user");
  assert.equal(result.assignments.length, 0);
  assert.equal(result.eligibleGuilds[0]?.effectivePlan, "premium_plus");
});

class MemoryAssignmentStore implements BillingAssignmentStore {
  readonly rows = new Map<string, BillingGuildAssignment>();
  readonly dormantGuilds: string[] = [];
  readonly operations: import("../src/runtime/billing/types").BillingLedgerOperation[] = [];
  readonly effectivePlans = new Map<string, "free" | "premium" | "premium_plus">();
  quarantineReason: string | null = null;
  status: BillingSubscriptionProjection["status"] = "active";
  constructor(private readonly plan: "premium" | "premium_plus") {}
  async readProjection(): Promise<BillingSubscriptionProjection> {
    return {
      ownerId: "owner",
      customerId: "cus",
      subscriptionId: "sub",
      priceId: "price",
      productId: "prod",
      plan: this.plan,
      frequency: "monthly",
      status: this.status,
      currentPeriodStartMs: 1,
      currentPeriodEndMs: 2,
      cancelAtPeriodEnd: false,
      cancelledAtMs: null,
      latestInvoiceId: null,
      scheduleId: null,
      observedAtMs: 1,
      quarantineReason: this.quarantineReason,
    };
  }
  async listAssignments(ownerId: string) {
    return [...this.rows.values()].filter((row) => row.ownerId === ownerId);
  }
  async readEffectivePlans(guildIds: string[]) {
    return new Map(
      guildIds.map((guildId) => [guildId, this.effectivePlans.get(guildId) ?? "free"] as const),
    );
  }
  async assign(input: Parameters<BillingAssignmentStore["assign"]>[0]) {
    const existing = this.rows.get(input.guildId);
    if (existing) {
      if (existing.ownerId !== input.ownerId) return false;
      if (input.operation) this.operations.push(input.operation);
      return true;
    }
    if (
      [...this.rows.values()].filter((row) => row.subscriptionId === input.subscriptionId).length >=
      input.capacity
    )
      return false;
    this.rows.set(input.guildId, {
      guildId: input.guildId,
      ownerId: input.ownerId,
      subscriptionId: input.subscriptionId,
      assignedAtMs: input.nowMs,
    });
    if (input.operation) this.operations.push(input.operation);
    return true;
  }
  async move(input: Parameters<BillingAssignmentStore["move"]>[0]) {
    const current = this.rows.get(input.fromGuildId);
    if (!current || current.ownerId !== input.ownerId || this.rows.has(input.toGuildId))
      return false;
    this.rows.delete(input.fromGuildId);
    this.dormantGuilds.push(input.fromGuildId);
    this.rows.set(input.toGuildId, {
      ...current,
      guildId: input.toGuildId,
      assignedAtMs: input.nowMs,
    });
    if (input.operation) this.operations.push(input.operation);
    return true;
  }
  async unassign(input: Parameters<BillingAssignmentStore["unassign"]>[0]) {
    const current = this.rows.get(input.guildId);
    if (!current || current.ownerId !== input.ownerId) return false;
    this.rows.delete(input.guildId);
    this.dormantGuilds.push(input.guildId);
    if (input.operation) this.operations.push(input.operation);
    return true;
  }
}

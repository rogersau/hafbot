/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  BillingDeliveryError,
  processBillingDelivery,
  sweepBillingDeliveryOutbox,
  type BillingDeliveryState,
  type BillingDeliveryStore,
} from "../src/runtime/billing/delivery";

test("owner DM and Billing Audit projection deliver once with privacy-safe fields", async () => {
  const store = new MemoryDeliveryStore();
  const owner: unknown[] = [];
  const audit: Array<{ embeds?: Array<{ title?: string; fields?: unknown[] }> }> = [];
  const result = await processBillingDelivery({
    operationId: "op",
    store,
    createId: ids(),
    now: () => 10,
    discord: {
      async resolveOwnerDiscordIdentity() {
        return { discordUserId: "discord-user", displayName: "Rogers AU" };
      },
      async sendOwnerDm(_id, message) {
        owner.push(message);
        return { id: "dm-1" };
      },
      async sendAudit(message) {
        audit.push(message);
        return { id: "audit-1" };
      },
    },
  });
  assert.deepEqual(result, { result: "complete" });
  assert.equal(owner.length, 1);
  assert.equal(audit.length, 1);
  assert.doesNotMatch(JSON.stringify(owner[0]), /cus_|sub_|invoice|payment payload/i);
  assert.match(JSON.stringify(owner[0]), /Your payment needs attention/);
  assert.doesNotMatch(JSON.stringify(audit[0]), /cus_|sub_|invoice|payment payload/i);
  assert.equal(audit[0]?.embeds?.[0]?.title, "Payment Attention Required");
  assert.match(JSON.stringify(audit[0]), /Rogers AU/);
  await processBillingDelivery({
    operationId: "op",
    store,
    discord: {
      async resolveOwnerDiscordIdentity() {
        return { discordUserId: "discord-user", displayName: "Rogers AU" };
      },
      async sendOwnerDm() {
        throw new Error("duplicate");
      },
      async sendAudit() {
        throw new Error("duplicate");
      },
    },
  });
  assert.equal(owner.length, 1);
  assert.equal(audit.length, 1);
});

test("transient owner failures follow bounded 1/5/30 minute policy and terminal failures stop", async () => {
  const store = new MemoryDeliveryStore();
  store.state.auditStatus = "delivered";
  const discord = {
    async resolveOwnerDiscordIdentity() {
      return { discordUserId: "user", displayName: "User" };
    },
    async sendOwnerDm() {
      throw new BillingDeliveryError("rate_limited", true, 120_000);
    },
    async sendAudit() {
      return { id: "audit" };
    },
  };
  assert.deepEqual(
    await processBillingDelivery({ operationId: "op", store, discord, createId: ids() }),
    { result: "retry", delaySeconds: 120 },
  );
  assert.deepEqual(
    await processBillingDelivery({ operationId: "op", store, discord, createId: ids() }),
    { result: "retry", delaySeconds: 300 },
  );
  assert.deepEqual(
    await processBillingDelivery({ operationId: "op", store, discord, createId: ids() }),
    { result: "complete" },
  );
  assert.equal(store.state.ownerDmStatus, "terminal");

  const permanent = new MemoryDeliveryStore();
  permanent.state.auditStatus = "delivered";
  await processBillingDelivery({
    operationId: "op",
    store: permanent,
    createId: ids(),
    discord: {
      async resolveOwnerDiscordIdentity() {
        return null;
      },
      async sendOwnerDm() {
        return { id: "never" };
      },
      async sendAudit() {
        return { id: "audit" };
      },
    },
  });
  assert.equal(permanent.state.ownerAttemptCount, 1);
  assert.equal(permanent.state.ownerDmStatus, "terminal");
});

test("delivery outbox sweep and replay repair reuse the existing operation", async () => {
  const store = new MemoryDeliveryStore();
  const queued: unknown[] = [];
  assert.equal(
    await sweepBillingDeliveryOutbox({
      store,
      queue: {
        async send(message, options) {
          queued.push({ message, options });
        },
      },
      now: () => 10,
    }),
    1,
  );
  assert.deepEqual(queued, [{ message: { operationId: "op" }, options: { delaySeconds: 60 } }]);
  await store.replay("op", 20);
  assert.equal(store.operationCount, 1);
  assert.equal(store.state.auditStatus, "pending");
});

test("Guild Assignment uses friendly owner and audit embeds and replays the audit snapshot", async () => {
  const store = new MemoryDeliveryStore();
  store.state.operation.kind = "guild_assignment_moved";
  store.state.operation.summaryJson = JSON.stringify({
    summary: "guild assignment moved",
    resultingAccess: "premium_plus",
    effectiveAtMs: 10_000,
    requiredAction: null,
    billingPath: "https://hafbot.xyz/admin/billing",
    notifyOwner: true,
    eventType: "guild_assignment",
    plan: "premium_plus",
    owner: { discordUserId: "owner-discord", displayName: "Plan Owner" },
    actor: { discordUserId: "owner-discord", displayName: "Plan Owner" },
    fromGuild: { guildId: "guild-1", name: "Old Guild" },
    toGuild: { guildId: "guild-2", name: "New Guild" },
  });
  const messages: unknown[] = [];
  const ownerMessages: unknown[] = [];
  const discord = {
    async resolveOwnerDiscordIdentity() {
      return { discordUserId: "changed-owner", displayName: "Changed Name" };
    },
    async sendOwnerDm(_userId: string, message: unknown) {
      ownerMessages.push(message);
      return { id: "owner-dm" };
    },
    async sendAudit(message: unknown) {
      messages.push(message);
      return { id: `audit-${messages.length}` };
    },
  };

  await processBillingDelivery({ operationId: "op", store, discord, createId: ids() });
  await store.replay("op", 20);
  await processBillingDelivery({ operationId: "op", store, discord, createId: ids() });

  assert.equal(messages.length, 2);
  assert.equal(ownerMessages.length, 1);
  assert.match(JSON.stringify(ownerMessages[0]), /Guild Assignment was moved/);
  assert.match(JSON.stringify(ownerMessages[0]), /Open Billing/);
  assert.deepEqual(messages[1], messages[0]);
  assert.match(JSON.stringify(messages[0]), /Guild Assignment Moved/);
  assert.match(JSON.stringify(messages[0]), /Old Guild/);
  assert.match(JSON.stringify(messages[0]), /New Guild/);
  assert.match(JSON.stringify(messages[0]), /Plan Owner/);
  assert.doesNotMatch(JSON.stringify(messages[0]), /Changed Name/);
});

test("quarantine and recovery DMs explain impact without exposing internal state names", async () => {
  const quarantine = await deliverOwnerMessage("subscription_quarantined", "premium");
  assert.match(quarantine, /We’re checking a billing issue/);
  assert.match(quarantine, /Premium access remains active/);
  assert.match(quarantine, /No action is needed right now/);
  assert.doesNotMatch(quarantine, /quarantined/i);
  assert.doesNotMatch(quarantine, /2027-07-16/);
  assert.match(quarantine, /https:\/\/hafbot\.xyz\/admin\/billing/);

  const recovered = await deliverOwnerMessage("subscription_recovered", "premium");
  assert.match(recovered, /Billing is back to normal/);
  assert.match(recovered, /Nothing.*you’re all set/);
  assert.doesNotMatch(recovered, /subscription recovered/i);
});

async function deliverOwnerMessage(kind: string, resultingAccess: string): Promise<string> {
  const store = new MemoryDeliveryStore();
  store.state.auditStatus = "delivered";
  store.state.operation.kind = kind;
  store.state.operation.createdAtMs = 1_000;
  store.state.operation.summaryJson = JSON.stringify({
    summary: kind.replaceAll("_", " "),
    resultingAccess,
    effectiveAtMs: Date.UTC(2027, 6, 16, 9, 56, 56),
    requiredAction: null,
    billingPath: "https://hafbot.xyz/admin/billing",
    plan: resultingAccess,
    notifyOwner: true,
  });
  const messages: unknown[] = [];
  await processBillingDelivery({
    operationId: "op",
    store,
    discord: {
      async resolveOwnerDiscordIdentity() {
        return { discordUserId: "owner", displayName: "Owner" };
      },
      async sendOwnerDm(_userId, message) {
        messages.push(message);
        return { id: "dm" };
      },
      async sendAudit() {
        return { id: "unused" };
      },
    },
  });
  return JSON.stringify(messages[0]);
}

function ids() {
  let value = 0;
  return () => `attempt-${value++}`;
}
class MemoryDeliveryStore implements BillingDeliveryStore {
  operationCount = 1;
  sent = false;
  state: BillingDeliveryState = {
    operation: {
      id: "op",
      ownerId: "owner",
      kind: "payment_recovery_required",
      source: "webhook",
      correlationId: null,
      summaryJson: JSON.stringify({
        summary: "payment recovery required",
        resultingAccess: "premium",
        effectiveAtMs: 1,
        requiredAction: "Update payment details",
        billingPath: "/admin/billing",
      }),
      createdAtMs: 1,
    },
    ownerDmStatus: "pending",
    auditStatus: "pending",
    ownerAttemptCount: 0,
  };
  async read() {
    return this.state;
  }
  async recordAttempt(input: Parameters<BillingDeliveryStore["recordAttempt"]>[0]) {
    if (input.destination === "owner_dm") this.state.ownerAttemptCount += 1;
  }
  async markOwnerDelivered() {
    this.state.ownerDmStatus = "delivered";
  }
  async markOwnerTerminal() {
    this.state.ownerDmStatus = "terminal";
  }
  async markAuditDelivered() {
    this.state.auditStatus = "delivered";
  }
  async listPendingOutbox() {
    return this.sent ? [] : ["op"];
  }
  async markOutboxSent() {
    this.sent = true;
  }
  async replay(_operationId: string, _nowMs: number) {
    this.sent = false;
    this.state.auditStatus = "pending";
  }
}

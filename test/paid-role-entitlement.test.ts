/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  PaidRoleEntitlementService,
  type PaidRoleEntitlementState,
  type PaidRoleManagedAssignment,
} from "../src/commerce/paid-role-entitlement";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;

test("active paid entitlement assigns a managed role and repeats idempotently", async () => {
  const h = harness();
  const first = await h.service.reconcile({
    operationKey: "op-active",
    source: "scheduled",
    nowMs: NOW,
    state: state(),
  });
  const second = await h.service.reconcile({
    operationKey: "op-active",
    source: "scheduled",
    nowMs: NOW,
    state: state(),
  });
  assert.equal(first.action, "assign");
  assert.equal(first.managed, true);
  assert.equal(second.reason, "already_applied");
  assert.equal(h.discord.adds.length, 1);
  assert.equal(h.store.assignments.size, 1);
});

test("failed payment retains access for seven days and removes it afterwards", async () => {
  const h = harness(true);
  const grace = await h.service.reconcile({
    operationKey: "op-grace",
    source: "scheduled",
    nowMs: NOW + 6 * DAY,
    state: state({ subscriptionStatus: "past_due", failedPaymentAtMs: NOW }),
  });
  assert.equal(grace.reason, "failed_payment_grace");
  const expired = await h.service.reconcile({
    operationKey: "op-grace-expired",
    source: "scheduled",
    nowMs: NOW + 7 * DAY + 1,
    state: state({ subscriptionStatus: "past_due", failedPaymentAtMs: NOW }),
  });
  assert.equal(expired.reason, "payment_failed_after_grace");
  assert.equal(h.discord.removes.length, 1);
});

test("past-due access without a durable failure time fails closed", async () => {
  const h = harness(true);
  const decision = await h.service.reconcile({
    operationKey: "op-missing-grace-anchor",
    source: "scheduled",
    nowMs: NOW,
    state: state({ subscriptionStatus: "past_due", failedPaymentAtMs: null }),
  });
  assert.equal(decision.action, "remove");
  assert.equal(decision.reason, "payment_unpaid");
});

test("grace access restores a missing managed role", async () => {
  const h = harness(true);
  h.discord.roles.clear();
  const grace = await h.service.reconcile({
    operationKey: "op-grace-restore",
    source: "scheduled",
    nowMs: NOW,
    state: state({
      subscriptionStatus: "past_due",
      paymentStatus: "failed",
      failedPaymentAtMs: NOW - DAY,
    }),
  });
  assert.equal(grace.action, "assign");
  assert.equal(grace.reason, "failed_payment_grace");
  assert.deepEqual(h.discord.adds, ["role"]);
});

test("incomplete, trialing, and unpaid invoice state cannot grant a role", async () => {
  for (const [subscriptionStatus, paymentStatus] of [
    ["incomplete", "processing"],
    ["trialing", null],
    ["active", "requires_action"],
  ] as const) {
    const h = harness(false);
    const decision = await h.service.reconcile({
      operationKey: `op-ineligible-${subscriptionStatus}-${paymentStatus}`,
      source: "scheduled",
      nowMs: NOW,
      state: state({ subscriptionStatus, paymentStatus }),
    });
    assert.notEqual(decision.action, "assign");
    assert.deepEqual(h.discord.adds, []);
  }
});

test("cancel-at-period-end and partial refunds retain paid access, full refund removes", async () => {
  const h = harness(true);
  const cancelled = await h.service.reconcile({
    operationKey: "op-cancel",
    source: "scheduled",
    nowMs: NOW,
    state: state({ cancelAtPeriodEnd: true, currentPeriodEndMs: NOW + DAY }),
  });
  assert.equal(cancelled.reason, "cancel_at_period_end");
  const partial = await h.service.reconcile({
    operationKey: "op-partial",
    source: "scheduled",
    nowMs: NOW,
    state: state({ amountMinor: 100, amountRefundedMinor: 50 }),
  });
  assert.equal(partial.reason, "active_paid");
  const full = await h.service.reconcile({
    operationKey: "op-full",
    source: "scheduled",
    nowMs: NOW,
    state: state({ amountMinor: 100, amountRefundedMinor: 100 }),
  });
  assert.equal(full.reason, "full_refund");
  assert.deepEqual(h.store.providerActions.at(-1), {
    actionType: "subscription.cancel_at_period_end",
    assignmentId: "assignment-1",
    connectedAccountId: "acct_seller",
    nowMs: NOW,
    operationKey: "paid-role-provider:acct_seller:sub-1:subscription.cancel_at_period_end",
    reasonCode: "full_refund",
    subscriptionId: "sub-1",
  });
});

test("dispute suspension, win restore, and loss removal/cancellation are coherent", async () => {
  const h = harness(true);
  const suspended = await h.service.reconcile({
    operationKey: "op-dispute",
    source: "scheduled",
    nowMs: NOW,
    state: state({ disputeStatus: "under_review" }),
  });
  assert.equal(suspended.reason, "dispute_suspended");
  const restored = await h.service.reconcile({
    operationKey: "op-win",
    source: "scheduled",
    nowMs: NOW,
    state: state({ disputeStatus: "won" }),
  });
  assert.equal(restored.action, "assign");
  const lost = await h.service.reconcile({
    operationKey: "op-loss",
    source: "scheduled",
    nowMs: NOW,
    state: state({ disputeStatus: "lost", subscriptionId: "sub-1" }),
  });
  assert.equal(lost.reason, "dispute_lost");
  assert.deepEqual(h.store.providerActions, [
    {
      actionType: "subscription.cancel_at_period_end",
      assignmentId: "assignment-1",
      connectedAccountId: "acct_seller",
      nowMs: NOW,
      operationKey: "paid-role-provider:acct_seller:sub-1:subscription.cancel_at_period_end",
      reasonCode: "dispute_lost",
      subscriptionId: "sub-1",
    },
  ]);
});

test("leave/kick retain, rejoin restores, ban removes and schedules cancellation", async () => {
  const h = harness(true);
  assert.equal(
    (
      await h.service.reconcile({
        operationKey: "op-leave",
        source: "scheduled",
        nowMs: NOW,
        state: state({ memberState: "left" }),
      })
    ).reason,
    "member_absent",
  );
  assert.equal(
    (
      await h.service.reconcile({
        operationKey: "op-kick",
        source: "scheduled",
        nowMs: NOW,
        state: state({ memberState: "kicked" }),
      })
    ).reason,
    "member_absent",
  );
  assert.equal(
    (
      await h.service.reconcile({
        operationKey: "op-rejoin",
        source: "scheduled",
        nowMs: NOW,
        state: state({ memberState: "rejoined" }),
      })
    ).reason,
    "active_paid",
  );
  assert.equal(
    (
      await h.service.reconcile({
        operationKey: "op-ban",
        source: "scheduled",
        nowMs: NOW,
        state: state({ memberState: "banned", subscriptionId: "sub-1" }),
      })
    ).reason,
    "member_absent",
  );
  assert.equal(
    h.discord.removes.length,
    0,
    "Discord already removes guild roles from a banned member",
  );
  assert.deepEqual(h.store.providerActions.at(-1), {
    actionType: "subscription.cancel_at_period_end",
    assignmentId: "assignment-1",
    connectedAccountId: "acct_seller",
    nowMs: NOW,
    operationKey: "paid-role-provider:acct_seller:sub-1:subscription.cancel_at_period_end",
    reasonCode: "member_absent",
    subscriptionId: "sub-1",
  });
  assert.equal(h.store.assignments.get("guild:user:role")?.state, "withheld");
  const restoredAfterBan = await h.service.reconcile({
    operationKey: "op-unban-rejoin",
    source: "scheduled",
    nowMs: NOW,
    state: state({ memberState: "rejoined", subscriptionId: "sub-1" }),
  });
  assert.equal(restoredAfterBan.action, "assign");
  assert.equal(h.store.assignments.get("guild:user:role")?.state, "managed");
});

test("manual roles are never removed and webhook/browser payloads cannot mutate Discord", async () => {
  const h = harness(false);
  h.discord.roles.add("guild:user:role");
  const manual = await h.service.reconcile({
    operationKey: "op-manual",
    source: "scheduled",
    nowMs: NOW,
    state: state({ subscriptionStatus: "unpaid" }),
  });
  assert.equal(manual.reason, "manual_role_preserved");
  const webhook = await h.service.reconcile({
    operationKey: "op-webhook",
    source: "webhook",
    nowMs: NOW,
    state: state(),
  });
  assert.equal(webhook.mutated, false);
  const checkout = await h.service.reconcile({
    operationKey: "op-checkout-redirect",
    source: "checkout",
    nowMs: NOW,
    state: state(),
  });
  assert.equal(checkout.mutated, false);
  assert.equal(h.discord.adds.length, 0);
});

test("a transient role failure releases the claim and retries with the same operation key", async () => {
  const h = harness();
  h.discord.throwAddOnce = true;
  await assert.rejects(() =>
    h.service.reconcile({
      operationKey: "op-retry",
      source: "scheduled",
      nowMs: NOW,
      state: state(),
    }),
  );
  const retried = await h.service.reconcile({
    operationKey: "op-retry",
    source: "scheduled",
    nowMs: NOW,
    state: state(),
  });
  assert.equal(retried.action, "assign");
  assert.equal(h.discord.adds.length, 1);
});

test("Discord success followed by a failed assignment write retains ownership on retry", async () => {
  const h = harness();
  h.store.assignments.set("guild:user:role", {
    ...assignment(),
    state: "pending",
    attemptCount: 0,
    assignedAtMs: null,
  });
  const saveAssignment = h.store.saveManagedAssignment.bind(h.store);
  let failCompletion = true;
  h.store.saveManagedAssignment = async (value) => {
    if (value.state === "managed" && failCompletion) {
      failCompletion = false;
      throw new Error("assignment_persistence_unavailable");
    }
    await saveAssignment(value);
  };
  const input = {
    operationKey: "op-ambiguous-assignment",
    source: "scheduled" as const,
    nowMs: NOW,
    state: state(),
  };
  await assert.rejects(h.service.reconcile(input), /assignment_persistence_unavailable/);
  assert.ok(h.discord.roles.has("guild:user:role"));
  assert.equal(h.store.assignments.get("guild:user:role")?.state, "pending");
  assert.equal((await h.service.reconcile(input)).action, "assign");
  assert.equal(h.store.assignments.get("guild:user:role")?.state, "managed");

  await h.service.reconcile({
    ...input,
    operationKey: "op-ambiguous-assignment-ended",
    state: state({ subscriptionStatus: "unpaid" }),
  });
  assert.equal(h.discord.roles.has("guild:user:role"), false);
});

test("provider cancellation remains durable when Discord removal fails", async () => {
  const h = harness(true);
  h.discord.throwRemoveOnce = true;
  await assert.rejects(() =>
    h.service.reconcile({
      operationKey: "op-discord-remove-fails",
      source: "scheduled",
      nowMs: NOW,
      state: state({ amountMinor: 100, amountRefundedMinor: 100 }),
    }),
  );
  assert.equal(h.store.providerActions.length, 1);
  assert.equal(
    h.store.providerActions[0]?.operationKey,
    "paid-role-provider:acct_seller:sub-1:subscription.cancel_at_period_end",
  );
  assert.equal(h.store.assignments.get("guild:user:role")?.state, "managed");
});

test("a corrected role preflight can retry the same operation key", async () => {
  const h = harness();
  h.discord.preflight = { ok: false, code: "hierarchy" };
  const blocked = await h.service.reconcile({
    operationKey: "op-preflight-retry",
    source: "scheduled",
    nowMs: NOW,
    state: state(),
  });
  assert.equal(blocked.action, "quarantine");

  h.discord.preflight = { ok: true };
  const retried = await h.service.reconcile({
    operationKey: "op-preflight-retry",
    source: "scheduled",
    nowMs: NOW + 1,
    state: state({ updatedAtMs: NOW + 1 }),
  });
  assert.equal(retried.action, "assign");
});

test("member_missing is entitlement-local and remains recoverable", async () => {
  const h = harness(true);
  h.discord.roles.clear();
  h.discord.preflight = { ok: false, code: "member_missing" };
  const result = await h.service.reconcile({
    operationKey: "op-member-missing",
    source: "scheduled",
    nowMs: NOW,
    state: state(),
  });
  assert.equal(result.action, "retain");
  assert.equal(result.reason, "member_absent");
  assert.equal(h.store.assignments.get("guild:user:role")?.state, "withheld");
  assert.equal(h.store.assignments.get("guild:user:role")?.withheldReason, "member_absent");
});

test("role repair migrates present and recoverable absent assignments", async () => {
  const h = harness(true);
  h.store.assignments.set("guild:user-2:role", {
    ...assignment(),
    id: "assignment-2",
    entitlementId: "ent-2",
    discordUserId: "user-2",
    state: "withheld",
    withheldReason: "member_absent",
  });
  h.store.states.set("ent-2", state({ entitlementId: "ent-2", discordUserId: "user-2" }));

  const result = await h.service.repair({
    operationKey: "op-repair-recoverable",
    guildId: "guild",
    offeringId: "offering",
    oldRoleId: "role",
    replacementRoleId: "role-new",
    startedAtMs: NOW,
    nowMs: NOW + DAY,
  });

  assert.equal(result.repaired, 2);
  assert.deepEqual(h.discord.adds, ["role-new"]);
  assert.equal(
    [...h.store.assignments.values()].filter((value) => value.discordRoleId === "role").length,
    0,
  );
  assert.equal(h.store.assignments.get("guild:user-2:role-new")?.state, "withheld");
});

test("role repair migrates untouched projections without removing a manually granted role", async () => {
  const h = harness(true);
  h.store.assignments.set("guild:user:role", {
    ...assignment(),
    state: "pending",
    attemptCount: 0,
    assignedAtMs: null,
  });
  const result = await h.service.repair({
    operationKey: "op-repair-manual",
    guildId: "guild",
    offeringId: "offering",
    oldRoleId: "role",
    replacementRoleId: "role-new",
    startedAtMs: NOW,
    nowMs: NOW + DAY,
  });
  assert.equal(result.repaired, 1);
  assert.equal(h.store.assignments.get("guild:user:role-new")?.attemptCount, 0);
  assert.ok(h.discord.roles.has("guild:user:role"));
  assert.deepEqual(h.discord.adds, []);
  assert.deepEqual(h.discord.removes, []);
});

test("admin suspend/revoke, preflight failures and 72-hour repair are explicit", async () => {
  const h = harness(true);
  assert.equal(
    (await h.service.adminSuspend({ operationKey: "op-suspend", nowMs: NOW, state: state() }))
      .reason,
    "admin_suspended",
  );
  const preflightHarness = harness(true);
  preflightHarness.discord.preflight = { ok: false, code: "hierarchy" };
  const failed = await preflightHarness.service.adminRevoke({
    operationKey: "op-revoke",
    nowMs: NOW,
    state: state(),
  });
  assert.equal(failed.action, "quarantine");
  h.discord.preflight = { ok: true };
  const repairHarness = harness(true);
  repairHarness.discord.preflight = { ok: false, code: "hierarchy" };
  const retry = await repairHarness.service.repair({
    operationKey: "op-repair-retry",
    guildId: "guild",
    offeringId: "offering",
    oldRoleId: "role",
    replacementRoleId: "role-new",
    startedAtMs: NOW,
    nowMs: NOW + DAY,
  });
  assert.equal(retry.action, "retry");
  repairHarness.discord.preflight = { ok: true };
  const repaired = await repairHarness.service.repair({
    operationKey: "op-repair",
    guildId: "guild",
    offeringId: "offering",
    oldRoleId: "role",
    replacementRoleId: "role-new",
    startedAtMs: NOW,
    nowMs: NOW + DAY,
  });
  assert.equal(repaired.repaired, 1);
  const expired = await h.service.repair({
    operationKey: "op-repair-expired",
    guildId: "guild",
    offeringId: "offering",
    oldRoleId: "role-new",
    replacementRoleId: "role-newer",
    startedAtMs: NOW,
    nowMs: NOW + 3 * DAY + 1,
  });
  assert.equal(expired.action, "quarantine");
});

function state(overrides: Partial<PaidRoleEntitlementState> = {}): PaidRoleEntitlementState {
  return {
    entitlementId: "ent-1",
    connectedAccountId: "acct_seller",
    guildId: "guild",
    discordUserId: "user",
    discordRoleId: "role",
    subscriptionId: "sub-1",
    subscriptionStatus: "active",
    cancelAtPeriodEnd: false,
    currentPeriodEndMs: NOW + 30 * DAY,
    paymentStatus: "succeeded",
    amountMinor: 100,
    amountRefundedMinor: 0,
    disputeStatus: null,
    failedPaymentAtMs: null,
    adminAction: null,
    memberState: "present",
    updatedAtMs: NOW,
    ...overrides,
  };
}

function harness(withManaged = false) {
  const store = new MemoryStore();
  const discord = new MemoryDiscord();
  if (withManaged) {
    store.assignments.set("guild:user:role", assignment());
    store.states.set("ent-1", state());
    discord.roles.add("guild:user:role");
  }
  const service = new PaidRoleEntitlementService({ store, discord });
  return { store, discord, service };
}

function assignment(): PaidRoleManagedAssignment {
  return {
    id: "assignment-1",
    entitlementId: "ent-1",
    guildId: "guild",
    discordUserId: "user",
    discordRoleId: "role",
    state: "managed",
    withheldReason: null,
    providerCancellationState: "none",
    attemptCount: 1,
    lastErrorCode: null,
    assignedAtMs: NOW,
    removedAtMs: null,
    updatedAtMs: NOW,
  };
}

class MemoryStore {
  readonly states = new Map<string, PaidRoleEntitlementState>();
  readonly assignments = new Map<string, PaidRoleManagedAssignment>();
  readonly providerActions: Array<{
    operationKey: string;
    assignmentId: string | null;
    connectedAccountId: string;
    subscriptionId: string;
    actionType: "subscription.cancel_at_period_end" | "subscription.cancel_immediately";
    reasonCode: string;
    nowMs: number;
  }> = [];
  readonly operations = new Set<string>();
  async readState(id: string) {
    return this.states.get(id) ?? null;
  }
  async saveState(value: PaidRoleEntitlementState) {
    this.states.set(value.entitlementId, value);
  }
  async readManagedAssignment(input: {
    entitlementId: string;
    guildId: string;
    discordUserId: string;
    discordRoleId: string;
  }) {
    const assignment = this.assignments.get(
      `${input.guildId}:${input.discordUserId}:${input.discordRoleId}`,
    );
    return assignment?.entitlementId === input.entitlementId ? assignment : null;
  }
  async saveManagedAssignment(value: PaidRoleManagedAssignment) {
    for (const [key, existing] of this.assignments) {
      if (existing.entitlementId === value.entitlementId) this.assignments.delete(key);
    }
    this.assignments.set(`${value.guildId}:${value.discordUserId}:${value.discordRoleId}`, value);
  }
  async listManagedAssignments(input: { guildId: string; discordRoleId: string }) {
    return [...this.assignments.values()].filter(
      (a) => a.guildId === input.guildId && a.discordRoleId === input.discordRoleId,
    );
  }
  async enqueueProviderAction(input: (typeof this.providerActions)[number]) {
    if (!this.providerActions.some((action) => action.operationKey === input.operationKey)) {
      this.providerActions.push(input);
    }
    return "pending" as const;
  }
  async appendOperation(input: { operationKey: string }) {
    if (this.operations.has(input.operationKey)) return false;
    this.operations.add(input.operationKey);
    return true;
  }
  async releaseOperation(operationKey: string) {
    this.operations.delete(operationKey);
  }
}

class MemoryDiscord {
  readonly roles = new Set<string>();
  readonly adds: string[] = [];
  readonly removes: string[] = [];
  preflight: {
    ok: boolean;
    code?: "permission" | "hierarchy" | "role_missing" | "member_missing" | "unknown";
  } = { ok: true };
  throwAddOnce = false;
  throwRemoveOnce = false;
  async hasRole(input: { guildId: string; discordUserId: string; discordRoleId: string }) {
    return this.roles.has(`${input.guildId}:${input.discordUserId}:${input.discordRoleId}`);
  }
  async preflightRole() {
    return this.preflight;
  }
  async addRole(input: { guildId: string; discordUserId: string; discordRoleId: string }) {
    if (this.throwAddOnce) {
      this.throwAddOnce = false;
      throw new Error("discord_transient");
    }
    this.roles.add(`${input.guildId}:${input.discordUserId}:${input.discordRoleId}`);
    this.adds.push(input.discordRoleId);
  }
  async removeRole(input: { guildId: string; discordUserId: string; discordRoleId: string }) {
    if (this.throwRemoveOnce) {
      this.throwRemoveOnce = false;
      throw new Error("discord_transient");
    }
    this.roles.delete(`${input.guildId}:${input.discordUserId}:${input.discordRoleId}`);
    this.removes.push(input.discordRoleId);
  }
}

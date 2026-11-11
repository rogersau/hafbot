/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  buildGuildBillingEscalation,
  createBillingSupportService,
  type BillingSupportCase,
  type BillingSupportStore,
} from "../src/runtime/billing/support";
import type { BillingAssignmentStore } from "../src/runtime/billing/assignments";
import type { BillingDeliveryStore } from "../src/runtime/billing/delivery";
import type {
  BillingLedgerOperation,
  BillingSubscriptionProjection,
} from "../src/runtime/billing/types";
import { createBillingApiHandler } from "../src/runtime/billing/billing-api";
import type { BillingCheckoutService } from "../src/runtime/billing/checkout";

test("Billing Support exposes only allow-listed recovery operations and audits outcomes", async () => {
  const store = new MemorySupportStore();
  const actions: string[] = [];
  const service = createBillingSupportService({
    store,
    assignments: store,
    delivery: store,
    async syncOwner() {
      actions.push("reconcile");
    },
    async createBillingLink() {
      actions.push("billing_link");
      return { url: "https://portal" };
    },
    now: () => 10,
    createId: (() => {
      let id = 0;
      return () => `op-${id++}`;
    })(),
  });
  assert.equal((await service.listCases()).length, 1);
  const inspection = await service.inspect("case-1");
  assert.equal(inspection.projection?.plan, "premium_plus");
  await service.reconcile("case-1", "operator");
  assert.deepEqual(await service.billingLink("case-1", "operator", "intent_link"), {
    url: "https://portal",
  });
  await service.moveAssignment("case-1", "operator", "g1", "g2");
  await service.replayDelivery("case-1", "operator", "lifecycle-op");
  await service.setStatus("case-1", "operator", "resolved");
  assert.deepEqual(actions, ["reconcile", "billing_link"]);
  assert.equal(store.supportOperations.length, 5);
  assert.equal(
    store.supportOperations.every(
      (operation) => JSON.parse(operation.summaryJson).notifyOwner === false,
    ),
    true,
  );
  assert.ok(
    store.supportOperations.every(
      (operation) => operation.source === "support" && operation.summaryJson.includes("operator"),
    ),
  );
  assert.equal("setPermanentPlan" in service, false);
  assert.equal("transferOwnership" in service, false);
  assert.equal("editStripeSubscription" in service, false);
});

test("Guild fallback message is deterministic and contains no owner or payment detail", () => {
  const message = buildGuildBillingEscalation();
  assert.equal(message, buildGuildBillingEscalation());
  assert.doesNotMatch(message, /owner id|invoice|card|amount|stripe|payment failed/i);
  assert.match(message, /Billing needs attention/);
});

test("Billing summary includes the validated display Price catalogue", async () => {
  const handler = createBillingApiHandler({
    service: emptyCheckoutService(),
    prices: {
      async read() {
        return [
          {
            plan: "premium",
            frequency: "monthly",
            unitAmount: 499,
            currency: "aud",
            decimalAmount: "4.99",
            formattedAmount: "$4.99",
          },
        ];
      },
    },
    async readSession() {
      return {
        user: { id: "owner", discordUserId: "discord-user", name: "Owner" },
      };
    },
  });

  const response = await handler(new Request("https://haf/admin/api/billing"));
  const body = (await response?.json()) as {
    prices: Array<{ formattedAmount: string }>;
  };
  assert.equal(response?.status, 200);
  assert.equal(body.prices[0]?.formattedAmount, "$4.99");
  assert.equal(Object.hasOwn(body, "founderAdmission"), false);
});

test("Billing Support authorization is freshly checked and broad admin sessions do not grant access", async () => {
  let roleGranted = true;
  let checks = 0;
  const support = {
    async listCases() {
      return [];
    },
  } as never;
  const handler = createBillingApiHandler({
    service: emptyCheckoutService(),
    support,
    async readSession() {
      return {
        user: {
          id: "auth-user",
          discordUserId: "discord-user",
          name: "Operator",
        },
      };
    },
    async authorizeSupport() {
      checks += 1;
      return roleGranted;
    },
  });
  assert.equal(
    (await handler(new Request("https://haf/admin/api/billing-support/cases")))?.status,
    200,
  );
  roleGranted = false;
  assert.equal(
    (await handler(new Request("https://haf/admin/api/billing-support/cases")))?.status,
    403,
  );
  assert.equal(checks, 2);

  const broadAdminOnly = createBillingApiHandler({
    service: emptyCheckoutService(),
    support,
    async readSession() {
      return null;
    },
    async authorizeSupport() {
      return true;
    },
  });
  assert.equal(
    (
      await broadAdminOnly(
        new Request("https://haf/admin/api/billing-support/cases", {
          headers: { cookie: "global-admin=session" },
        }),
      )
    )?.status,
    401,
  );
});

function emptyCheckoutService(): BillingCheckoutService {
  return {
    listCatalog: async () => [],
    async readSummary() {
      return null;
    },
    async startCheckout() {
      throw new Error("unused");
    },
    async requestSync() {
      throw new Error("unused");
    },
  };
}

class MemorySupportStore
  implements BillingSupportStore, BillingAssignmentStore, BillingDeliveryStore
{
  supportOperations: BillingLedgerOperation[] = [];
  supportCase: BillingSupportCase = {
    id: "case-1",
    ownerId: "owner",
    kind: "delivery",
    status: "open",
    safeProviderIdsJson: "[]",
    openedAtMs: 1,
    updatedAtMs: 1,
    resolvedAtMs: null,
  };
  projection: BillingSubscriptionProjection = {
    ownerId: "owner",
    customerId: "cus",
    subscriptionId: "sub",
    priceId: "price",
    productId: "prod",
    plan: "premium_plus",
    frequency: "monthly",
    status: "active",
    currentPeriodStartMs: 1,
    currentPeriodEndMs: 2,
    cancelAtPeriodEnd: false,
    cancelledAtMs: null,
    latestInvoiceId: null,
    scheduleId: null,
    observedAtMs: 1,
    quarantineReason: null,
  };
  async listCases() {
    return [this.supportCase];
  }
  async readCase(id: string) {
    return id === "case-1" ? this.supportCase : null;
  }
  async readProjection() {
    return this.projection;
  }
  async listAssignments() {
    return [
      {
        guildId: "g1",
        ownerId: "owner",
        subscriptionId: "sub",
        assignedAtMs: 1,
      },
    ];
  }
  async listDeliveryAttempts() {
    return [];
  }
  async listOwnerHistory() {
    return this.supportOperations;
  }
  async setCaseStatus(_id: string, status: string) {
    this.supportCase.status = status;
  }
  async appendSupportOperation(operation: BillingLedgerOperation) {
    this.supportOperations.push(operation);
  }
  async assign() {
    return false;
  }
  async move() {
    return true;
  }
  async unassign() {
    return false;
  }
  async read() {
    return null;
  }
  async recordAttempt() {}
  async markOwnerDelivered() {}
  async markOwnerTerminal() {}
  async markAuditDelivered() {}
  async listPendingOutbox() {
    return [];
  }
  async markOutboxSent() {}
  async replay() {}
}

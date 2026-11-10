import type { BillingGuildAssignment, BillingAssignmentStore } from "./assignments";
import type { BillingDeliveryStore } from "./delivery";
import type { BillingHistoryStore } from "./history";
import type { BillingSubscriptionProjection, BillingLedgerOperation } from "./types";

export interface BillingSupportCase {
  id: string;
  ownerId: string;
  kind: string;
  status: string;
  safeProviderIdsJson: string;
  openedAtMs: number;
  updatedAtMs: number;
  resolvedAtMs: number | null;
}
export interface BillingSupportStore extends BillingHistoryStore {
  listCases(): Promise<BillingSupportCase[]>;
  readCase(caseId: string): Promise<BillingSupportCase | null>;
  readProjection(ownerId: string): Promise<BillingSubscriptionProjection | null>;
  listAssignments(ownerId: string): Promise<BillingGuildAssignment[]>;
  listDeliveryAttempts(ownerId: string): Promise<unknown[]>;
  setCaseStatus(caseId: string, status: string, nowMs: number): Promise<void>;
  appendSupportOperation(operation: BillingLedgerOperation): Promise<void>;
}

export function createBillingSupportService(options: {
  store: BillingSupportStore;
  assignments: BillingAssignmentStore;
  delivery: BillingDeliveryStore;
  syncOwner(input: { ownerId: string; source: "support"; correlationId: string }): Promise<unknown>;
  createBillingLink(ownerId: string, intentId: string): Promise<{ url: string }>;
  now?: () => number;
  createId?: () => string;
}) {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => crypto.randomUUID());
  async function inspect(caseId: string) {
    const supportCase = await requireCase(caseId);
    const [projection, operations, assignments, deliveryAttempts] = await Promise.all([
      options.store.readProjection(supportCase.ownerId),
      options.store.listOwnerHistory(supportCase.ownerId),
      options.store.listAssignments(supportCase.ownerId),
      options.store.listDeliveryAttempts(supportCase.ownerId),
    ]);
    return { case: supportCase, projection, operations, assignments, deliveryAttempts };
  }
  async function requireCase(caseId: string) {
    const supportCase = await options.store.readCase(caseId);
    if (!supportCase) throw new SupportError("support_case_not_found", 404);
    return supportCase;
  }
  async function audited(
    caseId: string,
    actorId: string,
    action: string,
    work: (supportCase: BillingSupportCase) => Promise<unknown>,
  ) {
    const supportCase = await requireCase(caseId);
    let outcome = "succeeded";
    try {
      return await work(supportCase);
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      await options.store.appendSupportOperation({
        id: createId(),
        ownerId: supportCase.ownerId,
        kind: `support_${action}`,
        source: "support",
        correlationId: caseId,
        summaryJson: JSON.stringify({
          summary: `support ${action} ${outcome}`,
          operatorId: actorId,
          resultingAccess:
            (await options.store.readProjection(supportCase.ownerId))?.plan ?? "free",
          effectiveAtMs: now(),
          requiredAction: null,
          billingPath: "/admin/billing",
          notifyOwner: false,
        }),
        createdAtMs: now(),
      });
    }
  }
  return {
    listCases: () => options.store.listCases(),
    inspect,
    reconcile: (caseId: string, actorId: string) =>
      audited(caseId, actorId, "reconcile", (supportCase) =>
        options.syncOwner({
          ownerId: supportCase.ownerId,
          source: "support",
          correlationId: caseId,
        }),
      ),
    billingLink: (caseId: string, actorId: string, intentId: string) =>
      audited(caseId, actorId, "billing_link", (supportCase) =>
        options.createBillingLink(supportCase.ownerId, intentId),
      ),
    moveAssignment: (caseId: string, actorId: string, fromGuildId: string, toGuildId: string) =>
      audited(caseId, actorId, "assignment_move", async (supportCase) => {
        const projection = await options.store.readProjection(supportCase.ownerId);
        if (
          !projection?.subscriptionId ||
          (projection.plan !== "premium" && projection.plan !== "premium_plus") ||
          projection.status !== "active" ||
          projection.quarantineReason
        )
          throw new SupportError("usable_subscription_required", 409);
        const moved = await options.assignments.move({
          ownerId: supportCase.ownerId,
          subscriptionId: projection.subscriptionId,
          fromGuildId,
          toGuildId,
          plan: projection.plan,
          nowMs: now(),
        });
        if (!moved) throw new SupportError("assignment_move_invalid", 409);
      }),
    replayDelivery: (caseId: string, actorId: string, operationId: string) =>
      audited(caseId, actorId, "delivery_replay", async () =>
        options.delivery.replay(operationId, now()),
      ),
    setStatus: (caseId: string, actorId: string, status: string) =>
      audited(caseId, actorId, "case_status", async () =>
        options.store.setCaseStatus(caseId, status, now()),
      ),
  };
}

export function buildGuildBillingEscalation(): string {
  return "HAF Billing needs attention. A Plan Owner should open Billing in the HAF dashboard or contact Billing Support.";
}

export class SupportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

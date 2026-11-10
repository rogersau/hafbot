import type { BillingSubscriptionProjection } from "./types";

export interface StripeDisputeState {
  id: string;
  status: "needs_response" | "under_review" | "lost" | "won" | "warning_closed";
  amount: number;
  chargeAmount: number;
  paymentMethodType: string;
}
export interface BillingAdverseProvider {
  readDispute(disputeId: string): Promise<StripeDisputeState>;
  cancelImmediately(subscriptionId: string, idempotencyKey: string): Promise<void>;
}
export interface BillingAdverseStore {
  readProjection(ownerId: string): Promise<BillingSubscriptionProjection | null>;
  endAssignments(ownerId: string, nowMs: number): Promise<void>;
  openCase(input: {
    id: string;
    ownerId: string;
    kind: string;
    safeProviderId: string;
    nowMs: number;
  }): Promise<void>;
}

export function createBillingAdverseService(options: {
  provider: BillingAdverseProvider;
  store: BillingAdverseStore;
  readEvent(eventId: string): Promise<{ eventType: string; objectId: string | null } | null>;
  now?: () => number;
}) {
  return {
    async handleEvent(eventId: string, ownerId: string): Promise<void> {
      const event = await options.readEvent(eventId);
      if (
        !event ||
        event.eventType.startsWith("charge.refund") ||
        event.eventType.startsWith("refund.")
      )
        return;
      if (!event.eventType.startsWith("charge.dispute") || !event.objectId) return;
      const dispute = await options.provider.readDispute(event.objectId);
      if (dispute.status === "won" || dispute.status === "warning_closed") return;
      const supported =
        dispute.amount === dispute.chargeAmount && dispute.paymentMethodType === "card";
      const nowMs = options.now?.() ?? Date.now();
      await options.store.openCase({
        id: `dispute:${dispute.id}`,
        ownerId,
        kind: supported ? "supported_card_dispute" : "unsupported_dispute",
        safeProviderId: dispute.id,
        nowMs,
      });
      if (!supported) return;
      const projection = await options.store.readProjection(ownerId);
      if (!projection?.subscriptionId || projection.status === "cancelled") return;
      await options.provider.cancelImmediately(
        projection.subscriptionId,
        `dispute-cancel:${dispute.id}`,
      );
      await options.store.endAssignments(ownerId, nowMs);
    },
  };
}

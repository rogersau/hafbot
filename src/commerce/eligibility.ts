export interface CommerceEligibilityState {
  entitlementId: string;
  connectedAccountId: string;
  guildId: string;
  discordUserId: string;
  subscriptionId: string | null;
  subscriptionStatus:
    | "incomplete"
    | "trialing"
    | "active"
    | "past_due"
    | "paused"
    | "unpaid"
    | "canceled"
    | "ended";
  cancelAtPeriodEnd: boolean;
  currentPeriodEndMs: number | null;
  paymentStatus: "requires_action" | "processing" | "succeeded" | "failed" | "canceled" | null;
  amountMinor: number | null;
  amountRefundedMinor: number;
  disputeStatus:
    | "warning_needs_response"
    | "warning_under_review"
    | "warning_closed"
    | "needs_response"
    | "under_review"
    | "won"
    | "lost"
    | null;
  failedPaymentAtMs: number | null;
  adminAction: "suspend" | "revoke" | null;
  memberState: "present" | "left" | "kicked" | "rejoined" | "banned";
  updatedAtMs: number;
}

export interface CommerceEligibilityDecision {
  action: "assign" | "retain" | "remove";
  reason:
    | "active_paid"
    | "failed_payment_grace"
    | "cancel_at_period_end"
    | "member_absent"
    | "payment_unpaid"
    | "payment_failed_after_grace"
    | "ended"
    | "full_refund"
    | "dispute_suspended"
    | "dispute_won"
    | "dispute_lost"
    | "admin_suspended"
    | "admin_revoked";
}
const GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
// Financial and membership policy shared by independent Commerce projections.
export function commerceEligibility(
  state: CommerceEligibilityState,
  nowMs: number,
): CommerceEligibilityDecision {
  if (state.adminAction === "suspend") return { action: "remove", reason: "admin_suspended" };
  if (state.adminAction === "revoke") return { action: "remove", reason: "admin_revoked" };
  if (state.memberState === "banned") return { action: "remove", reason: "member_absent" };
  if (state.memberState === "left" || state.memberState === "kicked") {
    return { action: "retain", reason: "member_absent" };
  }
  if (state.disputeStatus === "lost") return { action: "remove", reason: "dispute_lost" };
  if (
    state.disputeStatus &&
    state.disputeStatus !== "won" &&
    state.disputeStatus !== "warning_closed"
  ) {
    return { action: "remove", reason: "dispute_suspended" };
  }
  const restoredFromDispute = state.disputeStatus === "won";
  if (
    state.amountMinor !== null &&
    state.amountMinor > 0 &&
    state.amountRefundedMinor >= state.amountMinor
  ) {
    return { action: "remove", reason: "full_refund" };
  }
  if (state.subscriptionStatus === "unpaid" || state.subscriptionStatus === "ended") {
    return {
      action: "remove",
      reason: state.subscriptionStatus === "unpaid" ? "payment_unpaid" : "ended",
    };
  }
  if (state.subscriptionStatus === "past_due") {
    const started = state.failedPaymentAtMs;
    if (started === null) return { action: "remove", reason: "payment_unpaid" };
    if (nowMs - started <= GRACE_MS) return { action: "assign", reason: "failed_payment_grace" };
    return { action: "remove", reason: "payment_failed_after_grace" };
  }
  if (
    state.cancelAtPeriodEnd &&
    state.currentPeriodEndMs !== null &&
    nowMs <= state.currentPeriodEndMs
  ) {
    return { action: "assign", reason: "cancel_at_period_end" };
  }
  if (
    state.subscriptionStatus === "canceled" &&
    state.currentPeriodEndMs !== null &&
    nowMs > state.currentPeriodEndMs
  ) {
    return { action: "remove", reason: "ended" };
  }
  if (state.paymentStatus === "canceled") return { action: "remove", reason: "payment_unpaid" };
  if (state.paymentStatus === "failed" && state.failedPaymentAtMs !== null) {
    return nowMs - state.failedPaymentAtMs <= GRACE_MS
      ? { action: "assign", reason: "failed_payment_grace" }
      : { action: "remove", reason: "payment_failed_after_grace" };
  }
  if (state.subscriptionStatus !== "active" || state.paymentStatus !== "succeeded") {
    return { action: "remove", reason: "payment_unpaid" };
  }
  return {
    action: "assign",
    reason: restoredFromDispute ? "dispute_won" : "active_paid",
  };
}

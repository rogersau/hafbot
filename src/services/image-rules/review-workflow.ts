import type { ImageRulesModQueueItem } from "../../types";

export type ImageReviewWorkflow =
  | { kind: "pending" }
  | { kind: "restore-leased"; claimToken: string }
  | { kind: "restore-recovery-required"; claimToken: string }
  | { kind: "handled" };

/** The old restoring status stays blocked during mixed-version rollouts. */
export function readImageReviewWorkflow(
  item: Pick<ImageRulesModQueueItem, "status" | "restoreClaimToken" | "restoreClaimExpiresAtMs">,
  nowMs: number,
): ImageReviewWorkflow {
  if (item.status !== "pending") return { kind: "handled" };
  if (item.restoreClaimToken === null) return { kind: "pending" };
  return {
    kind:
      item.restoreClaimExpiresAtMs !== null && item.restoreClaimExpiresAtMs > nowMs
        ? "restore-leased"
        : "restore-recovery-required",
    claimToken: item.restoreClaimToken,
  };
}

export type ImageRestoreDelivery = { kind: "new-delivery" } | { kind: "inspect-history" };

import { z } from "zod";

const checkpointSchema = z.object({
  status: z.enum(["processing", "completed", "failed"]),
  providerResultId: z.string().nullable(),
  providerCompletedAtMs: z.number().finite().nullable(),
  reconciliationRequestedAtMs: z.number().finite().nullable(),
  quarantinedAtMs: z.number().finite().nullable(),
});

export type FinancialActionWorkflow =
  | { kind: "quarantined" }
  | { kind: "provider-pending" }
  | { kind: "reconciliation-pending"; providerResultId: string | null }
  | { kind: "completion-pending"; providerResultId: string | null }
  | { kind: "completed"; providerResultId: string | null };

/** Failed attempts retain their successful checkpoints. A lease is still required for every write. */
export function readFinancialActionWorkflow(stored: unknown): FinancialActionWorkflow {
  if (stored === null) return { kind: "provider-pending" };
  const action = checkpointSchema.parse(stored);
  if (action.quarantinedAtMs !== null) return { kind: "quarantined" };
  if (action.status === "completed")
    return { kind: "completed", providerResultId: action.providerResultId };
  if (action.providerCompletedAtMs === null) return { kind: "provider-pending" };
  return {
    kind:
      action.reconciliationRequestedAtMs === null ? "reconciliation-pending" : "completion-pending",
    providerResultId: action.providerResultId,
  };
}

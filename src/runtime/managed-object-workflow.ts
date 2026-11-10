/** Upload progress is independent of quota eligibility and the storage provider. */
export type ManagedObjectWorkflow =
  | { kind: "reserved" }
  | { kind: "upload-outcome-unknown" }
  | { kind: "uploaded" }
  | { kind: "committed" };

export type ManagedObjectEvent = "upload-started" | "upload-confirmed" | "commit-confirmed";

export function transitionManagedObject(
  state: ManagedObjectWorkflow,
  event: ManagedObjectEvent,
): ManagedObjectWorkflow {
  if (state.kind === "reserved" && event === "upload-started")
    return { kind: "upload-outcome-unknown" };
  if (state.kind === "upload-outcome-unknown" && event === "upload-confirmed")
    return { kind: "uploaded" };
  if (state.kind === "uploaded" && event === "commit-confirmed") return { kind: "committed" };
  throw new Error(`Cannot apply ${event} while managed object is ${state.kind}.`);
}

/** A confirmed PUT must retain its reservation even when a later HEAD says absent. */
export function managedObjectFailureAction(
  state: ManagedObjectWorkflow,
  definitelyAbsent = false,
): "release-reservation" | "retain-for-reconciliation" {
  return state.kind === "reserved" || (state.kind === "upload-outcome-unknown" && definitelyAbsent)
    ? "release-reservation"
    : "retain-for-reconciliation";
}

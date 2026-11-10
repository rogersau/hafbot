import type { SetupResolution, SetupRun } from "../feature-setup";

export type SetupDependencyWorkflow =
  | { kind: "unresolved" }
  | { kind: "creation-unconfirmed" }
  | { kind: "resolution-pending"; resolution: SetupResolution }
  | { kind: "application-pending"; resolution: SetupResolution }
  | { kind: "completed"; resolution: SetupResolution };

export function readSetupDependencyWorkflow(run: SetupRun, key: string): SetupDependencyWorkflow {
  const resolution = run.resolutions.find((candidate) => candidate.dependencyKey === key);
  if (resolution)
    return {
      kind: resolution.appliedAtMs === null ? "application-pending" : "completed",
      resolution,
    };
  return { kind: run.pendingCreationDependencyKey === key ? "creation-unconfirmed" : "unresolved" };
}

export type SetupDependencyEvent =
  | { type: "creation-started" }
  | { type: "resource-resolved"; resolution: SetupResolution }
  | { type: "resolution-saved" }
  | { type: "application-saved"; nowMs: number };

export function transitionSetupDependency(
  state: SetupDependencyWorkflow,
  event: SetupDependencyEvent,
): SetupDependencyWorkflow {
  switch (event.type) {
    case "creation-started":
      if (state.kind === "unresolved") return { kind: "creation-unconfirmed" };
      break;
    case "resource-resolved":
      if (state.kind === "unresolved" || state.kind === "creation-unconfirmed")
        return { kind: "resolution-pending", resolution: event.resolution };
      break;
    case "resolution-saved":
      if (state.kind === "resolution-pending") return { ...state, kind: "application-pending" };
      break;
    case "application-saved":
      if (state.kind === "application-pending")
        return {
          kind: "completed",
          resolution: { ...state.resolution, appliedAtMs: event.nowMs, updatedAtMs: event.nowMs },
        };
      break;
  }
  throw new Error(`Cannot apply ${event.type} while setup dependency is ${state.kind}.`);
}

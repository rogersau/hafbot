export type RestoreWorkflow<Preview> =
  | { kind: "editing" }
  | { kind: "previewing"; preview: Preview | null }
  | { kind: "preview-failed"; preview: Preview | null; error: string }
  | { kind: "previewed" | "confirming" | "restoring"; preview: Preview }
  | { kind: "restore-failed"; preview: Preview; error: string }
  | { kind: "refreshing" }
  | { kind: "refresh-failed"; error: string };

export type RestoreEvent<Preview> =
  | {
      type:
        | "reset"
        | "preview-started"
        | "confirmation-started"
        | "confirmation-cancelled"
        | "restore-started"
        | "restore-committed"
        | "refresh-started"
        | "refresh-completed";
    }
  | { type: "preview-created"; preview: Preview }
  | { type: "preview-failed" | "restore-failed" | "refresh-failed"; error: string };

export function restoreIsCommitted<Preview>(state: RestoreWorkflow<Preview>): boolean {
  return state.kind === "refreshing" || state.kind === "refresh-failed";
}

/** A committed restore can only refresh; it cannot submit another mutation or discard its blocker. */
export function transitionRestore<Preview>(
  state: RestoreWorkflow<Preview>,
  event: RestoreEvent<Preview>,
): RestoreWorkflow<Preview> {
  switch (event.type) {
    case "reset":
      return restoreIsCommitted(state) ? state : { kind: "editing" };
    case "preview-started":
      if (
        !restoreIsCommitted(state) &&
        state.kind !== "restoring" &&
        state.kind !== "confirming" &&
        state.kind !== "previewing"
      )
        return { kind: "previewing", preview: "preview" in state ? state.preview : null };
      break;
    case "preview-created":
      if (state.kind === "previewing") return { kind: "previewed", preview: event.preview };
      break;
    case "preview-failed":
      if (state.kind === "previewing")
        return { ...state, kind: "preview-failed", error: event.error };
      break;
    case "confirmation-started":
      if (
        (state.kind === "previewed" ||
          state.kind === "restore-failed" ||
          state.kind === "preview-failed") &&
        state.preview !== null
      )
        return { kind: "confirming", preview: state.preview };
      break;
    case "confirmation-cancelled":
      if (state.kind === "confirming") return { kind: "previewed", preview: state.preview };
      break;
    case "restore-started":
      if (state.kind === "confirming") return { kind: "restoring", preview: state.preview };
      break;
    case "restore-failed":
      if (state.kind === "restoring")
        return { kind: "restore-failed", preview: state.preview, error: event.error };
      break;
    case "restore-committed":
      if (state.kind === "restoring") return { kind: "refreshing" };
      break;
    case "refresh-started":
      if (restoreIsCommitted(state)) return { kind: "refreshing" };
      break;
    case "refresh-failed":
      if (state.kind === "refreshing") return { kind: "refresh-failed", error: event.error };
      break;
    case "refresh-completed":
      if (state.kind === "refreshing") return { kind: "editing" };
      break;
  }
  return state;
}

export type PermissionCopyWorkflow =
  | "idle"
  | "applying"
  | "refreshing"
  | "committed"
  | "refresh-failed";

export type PermissionCopyEvent =
  | "preview-started"
  | "apply-started"
  | "apply-failed"
  | "apply-committed"
  | "refresh-started"
  | "refresh-completed"
  | "refresh-failed";

export function permissionCopyNeedsRefresh(state: PermissionCopyWorkflow): boolean {
  return state === "refreshing" || state === "refresh-failed";
}

/** A confirmed copy must finish reconciliation before another preview or apply. */
export function transitionPermissionCopy(
  state: PermissionCopyWorkflow,
  event: PermissionCopyEvent,
): PermissionCopyWorkflow {
  switch (event) {
    case "preview-started":
      if (state === "idle" || state === "committed") return "idle";
      break;
    case "apply-started":
      if (state === "idle") return "applying";
      break;
    case "apply-failed":
      if (state === "applying") return "idle";
      break;
    case "apply-committed":
      if (state === "applying") return "refreshing";
      break;
    case "refresh-started":
      if (state === "refresh-failed") return "refreshing";
      break;
    case "refresh-completed":
      if (state === "refreshing") return "committed";
      break;
    case "refresh-failed":
      if (state === "refreshing") return "refresh-failed";
      break;
  }
  return state;
}

/**
 * Runs a committed Admin mutation and then reconciles the route data.
 *
 * A route refresh is deliberately not part of the mutation's failure domain:
 * once `mutate` resolves, the server has committed the action and callers must
 * never present a refresh outage as a failed save/publish/delete.
 */
export type AdminMutationResult<T> =
  | { kind: "refreshed"; data: T; refreshError: null }
  | { kind: "refresh-failed"; data: T; refreshError: unknown };

export async function reconcileAdminMutation<T>(
  mutate: () => Promise<T>,
  refresh?: (() => Promise<void>) | null,
): Promise<AdminMutationResult<T>> {
  const data = await mutate();
  if (!refresh) return { kind: "refreshed", data, refreshError: null };

  try {
    await refresh();
    return { kind: "refreshed", data, refreshError: null };
  } catch (refreshError) {
    return { kind: "refresh-failed", data, refreshError };
  }
}

/** Retry only the reconciliation request; it can never invoke the mutation. */
export async function retryAdminRefresh(
  refresh?: (() => Promise<void>) | null,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  if (!refresh) return { ok: true };
  try {
    await refresh();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Safely reconcile a route after a mutation when a page does not need local status state. */
export async function refreshAdminRouteData(
  refresh?: (() => Promise<void>) | null,
  onFailure?: (error: unknown) => void,
): Promise<boolean> {
  const result = await reconcileAdminMutation(async () => undefined, refresh);
  if (result.kind === "refresh-failed") {
    const { refreshError } = result;
    onFailure?.(refreshError);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("admin-refresh-failed", {
          detail: { error: refreshError, refresh },
        }),
      );
    }
    return false;
  }
  return true;
}

/**
 * Require an authoritative route reload before a versioned editor may be remounted.
 * Rejecting keeps configuration history's committed-restore blocker open.
 */
export async function requireAdminRouteRefresh(
  refresh?: (() => Promise<void>) | null,
): Promise<void> {
  if (!refresh) {
    throw new Error(
      "The restored configuration could not be loaded because refresh is unavailable.",
    );
  }
  if (!(await refreshAdminRouteData(refresh))) {
    throw new Error("The restored configuration could not be loaded. Retry the editor refresh.");
  }
}

export function adminRefreshWarning(action: string, error: unknown): string {
  const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
  return `${action} completed, but the page could not refresh.${detail}`;
}

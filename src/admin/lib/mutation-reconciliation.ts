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

export async function refreshAdminRouteData(
  refresh?: (() => Promise<void>) | null,
  onFailure?: (error: unknown) => void,
): Promise<boolean> {
  const result = await retryAdminRefresh(refresh);
  if (!result.ok) onFailure?.(result.error);
  return result.ok;
}

export async function requireAdminRouteRefresh(
  refresh?: (() => Promise<void>) | null,
  onFailure?: (error: unknown) => void,
): Promise<void> {
  if (!refresh) {
    throw new Error(
      "The restored configuration could not be loaded because refresh is unavailable.",
    );
  }
  if (!(await refreshAdminRouteData(refresh, onFailure))) {
    throw new Error("The restored configuration could not be loaded. Retry the editor refresh.");
  }
}

export function adminRefreshWarning(action: string, error: unknown): string {
  const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
  return `${action} completed, but the page could not refresh.${detail}`;
}

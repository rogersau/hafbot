import { useMemo } from "react";

import { areAdminActionSnapshotsEqual } from "../components/admin-bottom-action-bar";

export interface UnsavedChangesState {
  hasChanges: boolean;
}

export function useUnsavedChanges(current: unknown, saved: unknown): UnsavedChangesState {
  const hasChanges = useMemo(() => hasUnsavedChanges(current, saved), [current, saved]);

  return { hasChanges };
}

export function hasUnsavedChanges(current: unknown, saved: unknown): boolean {
  return !areAdminActionSnapshotsEqual(current, saved);
}

export { areAdminActionSnapshotsEqual };

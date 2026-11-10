import { cn } from "../lib/utils";
import { useRegisterSetupCheckDirtyState } from "./setup-check-dirty-state";

export function UnsavedChangesIndicator({ hasChanges }: { hasChanges: boolean }) {
  useRegisterSetupCheckDirtyState(hasChanges);
  if (!hasChanges) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-200",
      )}
    >
      Unsaved changes
    </span>
  );
}

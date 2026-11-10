import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * A standalone empty-state box for a list or section that has no entries yet.
 *
 * Mirrors the house style used by `ResponsiveTable`'s empty message
 * (`rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground`) so an
 * empty list reads consistently whether it lives inside a table or a
 * SettingsBlock. Use `children` for richer empty-state content (e.g. a hint
 * plus a call to action).
 */
export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "admin-empty-state rounded-[4px] border bg-muted/20 p-4 text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

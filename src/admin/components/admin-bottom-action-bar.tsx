import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./ui/button";
import { isRecord } from "../../unknown-parse";

type BottomActionVariant =
  | "default"
  | "secondary"
  | "accent"
  | "outline"
  | "destructive"
  | "ghost"
  | "link";

interface AdminBottomAction {
  label: string;
  loadingLabel?: string;
  loading?: boolean;
  successLabel?: string;
  success?: boolean;
  disabled?: boolean;
  variant?: BottomActionVariant;
  onClick: () => void;
}

interface AdminBottomActionBarHostContextValue {
  target: HTMLDivElement | null;
}

const AdminBottomActionBarHostContext = createContext<
  AdminBottomActionBarHostContextValue | undefined
>(undefined);

export function AdminBottomActionBarProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ target }), [target]);

  return (
    <AdminBottomActionBarHostContext.Provider value={value}>
      {children}
      <div ref={setTarget} className="admin-bottom-action-bar-host" />
    </AdminBottomActionBarHostContext.Provider>
  );
}

export function AdminBottomActionBar({ actions }: { actions: AdminBottomAction[] }) {
  const host = useContext(AdminBottomActionBarHostContext);
  const actionBar = (
    <div className="admin-bottom-action-bar relative z-20 shrink-0 border-t bg-background py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] backdrop-blur md:py-3 md:pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {actions.map((action) => (
          <Button
            key={action.label}
            type="button"
            variant={action.variant ?? "default"}
            disabled={action.disabled}
            loading={action.loading}
            loadingLabel={action.loadingLabel}
            success={action.success}
            successLabel={action.successLabel}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );

  return host?.target ? createPortal(actionBar, host.target) : actionBar;
}

export function areAdminActionSnapshotsEqual(current: unknown, saved: unknown): boolean {
  return stableStringify(current) === stableStringify(saved);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  if (isRecord(value)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortObjectKeys((value as Record<string, unknown>)[key]);
        return sorted;
      }, {});
  }

  return value;
}

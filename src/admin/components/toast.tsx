import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import {
  AdminSessionProvider,
  useAdminSession,
  useAdminSessionState,
  useOptionalAdminSession,
} from "../lib/admin-session";

const noToast = {
  success: (_message: string) => undefined,
  error: (_message: string) => undefined,
  info: (_message: string) => undefined,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <AdminSessionProvider>
      <ToastViewport>{children}</ToastViewport>
    </AdminSessionProvider>
  );
}

function ToastViewport({ children }: { children: ReactNode }) {
  const session = useAdminSession();
  const toasts = useAdminSessionState((state) => state.toasts);

  return (
    <>
      {children}
      <div
        className="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[80] flex w-[calc(100%-1.5rem)] -translate-x-1/2 flex-col items-center gap-2 sm:left-auto sm:right-4 sm:w-auto sm:translate-x-0 sm:items-end"
        data-toast-container
      >
        {[...toasts].reverse().map((toast) => (
          <div
            key={toast.id}
            role={toast.variant === "error" ? "alert" : "status"}
            aria-live={toast.variant === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            data-toast-id={toast.id}
            className="pointer-events-auto"
          >
            <button
              type="button"
              className={cn(
                "admin-toast max-w-sm rounded-[4px] border px-4 py-3 text-left text-sm shadow-lg transition-colors",
                toast.variant === "success" && "border-green-500/40 bg-green-950 text-green-50",
                toast.variant === "error" &&
                  "border-destructive/40 bg-destructive text-destructive-foreground",
                toast.variant === "info" && "border-border bg-popover text-popover-foreground",
              )}
              onClick={() => session.dismissToast(toast.id)}
            >
              {toast.message}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

export function useToast() {
  return useOptionalAdminSession()?.toast ?? noToast;
}

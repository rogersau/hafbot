import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "../lib/utils";

type ToastVariant = "success" | "error" | "info";

interface ToastEntry {
  id: number;
  variant: ToastVariant;
  message: string;
}

interface ToastContextValue {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
const TOAST_DISMISS_MS = 4000;
const TOAST_LIMIT = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextToastId = useRef(0);
  const dismissTimers = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = dismissTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      dismissTimers.current.delete(id);
    }
  }, []);

  // Timer handles are external browser resources and must be released when the provider unmounts.
  // oxlint-disable-next-line custom/no-use-effect
  useEffect(() => {
    return () => {
      for (const timer of dismissTimers.current.values()) {
        window.clearTimeout(timer);
      }
      dismissTimers.current.clear();
    };
  }, []);

  const api = useMemo<ToastContextValue>(() => {
    function show(variant: ToastVariant, message: string) {
      const id = ++nextToastId.current;
      const entry: ToastEntry = { id, variant, message };

      setToasts((current) => {
        const next = [...current, entry];
        const overflow = next.slice(0, Math.max(0, next.length - TOAST_LIMIT));
        for (const removed of overflow) {
          const timer = dismissTimers.current.get(removed.id);
          if (timer !== undefined) {
            window.clearTimeout(timer);
            dismissTimers.current.delete(removed.id);
          }
        }
        return next.slice(-TOAST_LIMIT);
      });

      if (typeof window !== "undefined") {
        const timer = window.setTimeout(() => dismiss(id), TOAST_DISMISS_MS);
        dismissTimers.current.set(id, timer);
      }
    }

    return {
      success: (message) => show("success", message),
      error: (message) => show("error", message),
      info: (message) => show("info", message),
    };
  }, [dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[80] flex w-[calc(100%-1.5rem)] -translate-x-1/2 flex-col items-center gap-2 sm:left-auto sm:right-4 sm:w-auto sm:translate-x-0 sm:items-end"
        data-toast-container
      >
        {/* Render newest first so it remains closest to the top/right notification anchor. */}
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
              onClick={() => dismiss(toast.id)}
            >
              {toast.message}
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    return {
      success: () => undefined,
      error: () => undefined,
      info: () => undefined,
    };
  }
  return context;
}

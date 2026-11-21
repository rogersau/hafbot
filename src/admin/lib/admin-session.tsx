import { Store, useStore } from "@tanstack/react-store";
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import type { FeedbackSnapshot } from "../components/admin-feedback-dialog";
import {
  readAdminNavSectionPreferences,
  type AdminNavSectionPreferences,
} from "./admin-nav-section-preferences";
import type { AdminWorkspaceTabHistory } from "../components/admin-workspace-tabs";
import type { AdminReadCache } from "./admin-read";
import type { GuildResourcesCache } from "./guild-resources-cache";
import {
  adminRefreshWarning,
  refreshAdminRouteData,
  requireAdminRouteRefresh,
} from "./mutation-reconciliation";

type ToastVariant = "success" | "error" | "info";

interface ToastEntry {
  id: number;
  variant: ToastVariant;
  message: string;
}

interface RefreshFailure {
  error: unknown;
  refresh?: (() => Promise<void>) | null;
  sequence: number;
}

interface AdminSessionState {
  toasts: ToastEntry[];
  refreshFailure: RefreshFailure | null;
  feedback: { snapshot: FeedbackSnapshot; open: boolean } | null;
  workspaceTabs: AdminWorkspaceTabHistory | null;
  sidebarCollapsed: boolean;
  navSectionPreferences: AdminNavSectionPreferences | null;
  guildResourcesRefreshVersion: number;
}

const TOAST_DISMISS_MS = 4000;
const TOAST_LIMIT = 3;
const standaloneRouteRefresh = { refreshAdminRouteData, requireAdminRouteRefresh };

function createAdminSession() {
  const store = new Store<AdminSessionState>({
    toasts: [],
    refreshFailure: null,
    feedback: null,
    workspaceTabs: null,
    sidebarCollapsed: false,
    navSectionPreferences: null,
    guildResourcesRefreshVersion: 0,
  });
  let nextToastId = 0;
  let refreshSequence = 0;
  let mounted = false;
  const dismissTimers = new Map<number, number>();
  const guildResourcesCache: GuildResourcesCache = new Map();
  const reads: AdminReadCache = new Map();

  function update(
    patch: Partial<AdminSessionState> | ((state: AdminSessionState) => Partial<AdminSessionState>),
  ) {
    store.setState((state) => ({
      ...state,
      ...(typeof patch === "function" ? patch(state) : patch),
    }));
  }

  function clearToastTimer(id: number) {
    const timer = dismissTimers.get(id);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    dismissTimers.delete(id);
  }

  function dismissToast(id: number) {
    clearToastTimer(id);
    update(({ toasts }) => ({ toasts: toasts.filter((toast) => toast.id !== id) }));
  }

  function showToast(variant: ToastVariant, message: string) {
    if (!mounted) return;
    const id = ++nextToastId;
    const next = [...store.state.toasts, { id, variant, message }];
    for (const removed of next.slice(0, Math.max(0, next.length - TOAST_LIMIT))) {
      clearToastTimer(removed.id);
    }
    if (typeof window !== "undefined") {
      dismissTimers.set(
        id,
        window.setTimeout(() => dismissToast(id), TOAST_DISMISS_MS),
      );
    }
    update({ toasts: next.slice(-TOAST_LIMIT) });
  }

  function recordRefreshFailure(error: unknown, refresh: RefreshFailure["refresh"]) {
    update({ refreshFailure: { error, refresh, sequence: ++refreshSequence } });
    showToast("info", adminRefreshWarning("Admin changes", error));
  }

  return {
    store,
    update,
    guildResourcesCache,
    reads,
    dismissToast,
    mount() {
      mounted = true;
      update({ navSectionPreferences: readAdminNavSectionPreferences() });
      return () => {
        mounted = false;
        for (const id of dismissTimers.keys()) clearToastTimer(id);
      };
    },
    toast: {
      success: (message: string) => showToast("success", message),
      error: (message: string) => showToast("error", message),
      info: (message: string) => showToast("info", message),
    },
    routeRefresh: {
      refreshAdminRouteData(
        refresh?: RefreshFailure["refresh"],
        onFailure?: (error: unknown) => void,
      ) {
        return refreshAdminRouteData(refresh, (error) => {
          onFailure?.(error);
          recordRefreshFailure(error, refresh);
        });
      },
      requireAdminRouteRefresh(refresh?: RefreshFailure["refresh"]) {
        return requireAdminRouteRefresh(refresh, (error) => recordRefreshFailure(error, refresh));
      },
    },
  };
}

const AdminSessionContext = createContext<ReturnType<typeof createAdminSession> | null>(null);

export function AdminSessionProvider({ children }: { children: ReactNode }) {
  const parent = useContext(AdminSessionContext);
  const [session] = useState(() => parent ?? createAdminSession());
  useLayoutEffect(() => {
    if (!parent) return session.mount();
  }, [parent, session]);
  return <AdminSessionContext.Provider value={session}>{children}</AdminSessionContext.Provider>;
}

export function useOptionalAdminSession() {
  return useContext(AdminSessionContext);
}

export function useAdminRouteRefresh() {
  return useOptionalAdminSession()?.routeRefresh ?? standaloneRouteRefresh;
}

export function useAdminSession() {
  const session = useOptionalAdminSession();
  if (!session) throw new Error("Missing AdminSessionProvider");
  return session;
}

export function useAdminSessionState<T>(select: (state: AdminSessionState) => T): T {
  return useStore(useAdminSession().store, select);
}

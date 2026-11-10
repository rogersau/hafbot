import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouterState } from "@tanstack/react-router";

import { AdminShell } from "../components/admin-shell";
import { AdminFeedbackProvider, resolveFeedbackScope } from "../components/admin-feedback-dialog";
import { getCurrentPageLabel } from "../components/admin-shell-nav";
import { SetupCheckDirtyStateProvider } from "../components/setup-check-dirty-state";
import { useTheme } from "../hooks/use-theme";
import { buildAdminDocumentTitle } from "../lib/admin-document-title";
import { buildAdminDashboardHref } from "../lib/dashboard-urls";
import { getAdminRouteState } from "../lib/admin-route-state";
import type { AdminPageMetadata, AdminRouterContext } from "./context";

const AdminRouteContext = createContext<AdminRouterContext | null>(null);

export function AdminRouteContextProvider({
  value,
  children,
}: {
  value: AdminRouterContext;
  children: ReactNode;
}) {
  const [pageMetadata, setPageMetadata] = useState<AdminPageMetadata | null>(null);
  const lastPathRef = useRef(value.currentPath);

  if (lastPathRef.current !== value.currentPath) {
    lastPathRef.current = value.currentPath;
    setPageMetadata(null);
  }

  // The browser title is external document state and follows the active route context.
  // oxlint-disable-next-line custom/no-use-effect
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = buildAdminDocumentTitle({
      authenticated: true,
      currentPath: value.currentPath,
      selectedGuildId: value.pathGuildId || value.selectedGuildId,
      guildDirectory: value.guildDirectory,
    });
  }, [value.currentPath, value.guildDirectory, value.pathGuildId, value.selectedGuildId]);

  const contextValue = useMemo(
    () => ({ ...value, pageMetadata, setPageMetadata }),
    [value, pageMetadata],
  );

  const selectedGuildId = value.pathGuildId || value.selectedGuildId;

  return (
    <AdminRouteContext.Provider value={contextValue}>
      {/* Keep feedback in this authenticated session when a route or guild remounts its shell. */}
      <AdminFeedbackProvider
        context={{
          route: typeof window === "undefined" ? value.currentPath : window.location.pathname,
          pageLabel: getCurrentPageLabel(value.currentPath, selectedGuildId),
          ...resolveFeedbackScope(selectedGuildId, value.selectedWorkspaceId),
          workerVersion: value.workerVersion,
        }}
      >
        {children}
      </AdminFeedbackProvider>
    </AdminRouteContext.Provider>
  );
}

export function useAdminRouteContext(): AdminRouterContext {
  const context = useContext(AdminRouteContext);
  if (!context) throw new Error("Missing AdminRouteContextProvider");

  const location = useRouterState({
    select: (state) => ({
      pathname: state.location.pathname,
      search: state.location.searchStr,
    }),
  });
  const routeState = getAdminRouteState({
    pathname: location.pathname,
    search: location.search,
  });

  return {
    ...context,
    ...routeState,
    currentSearch: location.search,
  };
}

export function AdminRouteShell({ children }: { children: ReactNode }) {
  const context = useAdminRouteContext();
  const selectedGuildId = context.pathGuildId || context.selectedGuildId;

  // Keep <html>'s theme class and the theme cookie in sync with the user's
  // preference. Lives here so the effect runs inside the router tree, where
  // the user-preferences context is available for every routed page.
  useTheme(context.userPreferences.theme);

  return (
    <AdminShell
      currentPath={context.currentPath}
      currentSearch={context.currentSearch}
      guildDirectory={context.guildDirectory}
      guildLookupError={context.guildLookupError}
      selectedGuildId={selectedGuildId}
      onSelectedGuildChange={context.onSelectedGuildChange}
      refreshGuildDirectory={context.refreshGuildDirectory}
      selectedWorkspaceId={context.selectedWorkspaceId}
      buildNavigationHref={(path) =>
        buildAdminDashboardHref(path, context.selectedWorkspaceId, selectedGuildId)
      }
      playstationLinkEnabled={context.playstationLinkEnabled}
      selectedGuildTier={context.entitlement?.tier ?? null}
      userProfile={context.userProfile}
      userPreferences={context.userPreferences}
      applyUserPreferencesPatch={context.applyUserPreferencesPatch}
      pageMetadata={context.pageMetadata}
      isRoutePending={context.isRoutePending}
    >
      <SetupCheckDirtyStateProvider>{children}</SetupCheckDirtyStateProvider>
    </AdminShell>
  );
}

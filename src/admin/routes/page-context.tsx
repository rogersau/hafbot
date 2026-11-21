import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";

import { AdminShell } from "../components/admin-shell";
import { AdminFeedbackProvider, resolveFeedbackScope } from "../components/admin-feedback-dialog";
import { getCurrentPageLabel } from "../components/admin-shell-nav";
import { buildAdminDocumentTitle } from "../lib/admin-document-title";
import { buildAdminDashboardHref } from "../lib/dashboard-urls";
import type { AdminRouterContext } from "./context";

const AdminRouteContext = createContext<AdminRouterContext | null>(null);

export function AdminRouteContextProvider({
  value,
  children,
}: {
  value: AdminRouterContext;
  children: ReactNode;
}) {
  const selectedGuildId = value.pathGuildId || value.selectedGuildId;
  const title = buildAdminDocumentTitle({
    authenticated: true,
    currentPath: value.currentPath,
    selectedGuildId,
    guildDirectory: value.guildDirectory,
  });

  useLayoutEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <AdminRouteContext.Provider value={value}>
      <AdminFeedbackProvider
        context={{
          route: value.currentPath,
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
  return context;
}

export function AdminRouteShell({ children }: { children: ReactNode }) {
  const context = useAdminRouteContext();
  const selectedGuildId = context.pathGuildId || context.selectedGuildId;

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
      isRoutePending={context.isRoutePending}
    >
      {children}
    </AdminShell>
  );
}

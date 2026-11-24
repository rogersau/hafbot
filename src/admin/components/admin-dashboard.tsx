import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { ToastProvider } from "./toast";
import { AdminRefreshNoticeHost } from "./admin-refresh-notice-host";
import { getCurrentPageLabel } from "./admin-shell-nav";
import {
  adminWorkspaceContextKey,
  getAdminWorkspaceRouteId,
  recordAdminWorkspaceVisit,
} from "./admin-workspace-tabs";
import { useGuildDirectory } from "../hooks/use-guild-directory";
import { useEntitlement } from "../hooks/use-entitlement";
import { useTheme } from "../hooks/use-theme";
import { useUserPreferences } from "../hooks/use-user-preferences";
import { AdminSessionProvider, useAdminSession, useAdminSessionState } from "../lib/admin-session";
import { resetGuildResourcesCache } from "../lib/guild-resources-cache";
import { buildAdminDashboardHref, encodeGuildIdForSearch } from "../lib/dashboard-urls";
import { reportDashboardMilestone } from "../lib/product-analytics";
import type { AdminRouterContext } from "../routes/context";
import type { GuildShellLoaderData, LoadedAdminRouteData } from "../lib/admin-route-loaders";
import type { AdminDocumentData } from "../../web/router-context";
import { AdminRouteContextProvider } from "../routes/page-context";
import { getAdminRouteState, getDefaultAdminRedirectTarget } from "../lib/admin-route-state";
import { setLastSelectedGuildId, getLastSelectedGuildId } from "../lib/guild-selection-persistence";
import { readFirstWorkflowId, withFirstWorkflow } from "../../first-workflow-intent";

interface DashboardProps {
  admin: AdminDocumentData;
  guildRouteId: string;
  location: { pathname: string; searchStr: string };
  children: ReactNode;
}

export function AdminDashboard(props: DashboardProps) {
  return (
    <AdminSessionProvider>
      <AdminDashboardContent {...props} />
    </AdminSessionProvider>
  );
}

function AdminDashboardContent({ admin, guildRouteId, location, children }: DashboardProps) {
  const router = useRouter();
  const session = useAdminSession();
  const lastRecordedLocation = useRef<string | null>(null);
  const { pathname, searchStr: currentSearch } = location;
  const currentRouteState = getAdminRouteState({
    pathname,
    search: currentSearch,
  });
  const { currentPath, selectedWorkspaceId, selectedGuildId, pathGuildId } = currentRouteState;
  const isRoutePending = useRouterState({ router, select: (state) => state.status === "pending" });
  const guildShellLoaderData = useRouterState({
    router,
    select: (state) => {
      const match = state.matches.find((candidate) => candidate.routeId === guildRouteId);
      return match?.loaderData as LoadedAdminRouteData<GuildShellLoaderData> | undefined;
    },
  });
  const guildResourcesRefreshVersion = useAdminSessionState(
    (state) => state.guildResourcesRefreshVersion,
  );
  const entitlementResult = useEntitlement(selectedWorkspaceId, selectedGuildId, !pathGuildId);
  const guildShellMatchesCurrentRoute =
    guildShellLoaderData?.data.guildId === pathGuildId &&
    guildShellLoaderData.data.workspaceId === selectedWorkspaceId;
  const entitlement = pathGuildId
    ? guildShellMatchesCurrentRoute
      ? guildShellLoaderData.data.entitlement
      : null
    : selectedGuildId && !entitlementResult.loading && !entitlementResult.error
      ? entitlementResult.data
      : null;

  const { guildDirectory, guildLookupError, refreshGuildDirectory } = useGuildDirectory(
    true,
    selectedWorkspaceId,
  );
  const {
    preferences: userPreferences,
    loading: userPreferencesLoading,
    applyPatch: applyUserPreferencesPatch,
  } = useUserPreferences(true);
  useTheme(userPreferences.theme, !userPreferencesLoading);

  useLayoutEffect(() => {
    const recordVisit = (to: typeof router.state.location, from?: typeof to) => {
      if (from?.pathname === to.pathname && from.searchStr === to.searchStr) return;
      const pathAndSearch = `${to.pathname}${to.searchStr}`;
      if (lastRecordedLocation.current === pathAndSearch) return;
      lastRecordedLocation.current = pathAndSearch;
      const { currentPath, selectedGuildId, selectedWorkspaceId } = getAdminRouteState({
        pathname: to.pathname,
        search: to.searchStr,
      });
      const contextKey = adminWorkspaceContextKey(selectedWorkspaceId, selectedGuildId);
      const id = getAdminWorkspaceRouteId(currentPath, selectedGuildId);
      const overviewHref = buildAdminDashboardHref("/admin", selectedWorkspaceId, selectedGuildId);
      session.update(({ workspaceTabs }) => ({
        workspaceTabs: recordAdminWorkspaceVisit(workspaceTabs, contextKey, overviewHref, {
          id,
          label: getCurrentPageLabel(currentPath, selectedGuildId),
          href: `${currentPath}${to.searchStr}`,
          pinned: id === "overview",
        }),
      }));
      if (currentPath !== "/admin/billing" || !selectedGuildId) return;
      const previous =
        from && getAdminRouteState({ pathname: from.pathname, search: from.searchStr });
      if (
        previous?.currentPath === currentPath &&
        previous.selectedGuildId === selectedGuildId &&
        previous.selectedWorkspaceId === selectedWorkspaceId
      )
        return;
      void reportDashboardMilestone({
        guildId: selectedGuildId,
        workspaceId: selectedWorkspaceId,
        action: "upgrade_viewed",
      }).catch(() => undefined);
    };

    const initial = router.state.resolvedLocation;
    if (initial) recordVisit(initial);
    return router.subscribe("onResolved", ({ toLocation, fromLocation }) =>
      recordVisit(toLocation, fromLocation),
    );
  }, [router, session]);

  const handleSelectedGuildChange = useCallback(
    async (nextGuildId: string) => {
      const normalizedGuildId = nextGuildId.trim();
      let nextHref = buildAdminDashboardHref(currentPath, selectedWorkspaceId, normalizedGuildId);
      if (currentPath === "/admin/billing") {
        const params = new URLSearchParams(currentSearch);
        if (normalizedGuildId) params.set("guildId", encodeGuildIdForSearch(normalizedGuildId));
        else params.delete("guildId");
        const query = params.toString();
        nextHref = query ? `/admin/billing?${query}` : "/admin/billing";
      } else if (
        currentPath === "/admin" ||
        currentPath === buildAdminDashboardHref("/admin", "", selectedGuildId)
      ) {
        nextHref = withFirstWorkflow(nextHref, readFirstWorkflowId(currentSearch));
      }
      const next = router.buildLocation({ to: nextHref });
      await router.navigate({ to: nextHref, replace: true });
      if (router.state.resolvedLocation?.href === next.href) {
        setLastSelectedGuildId(normalizedGuildId);
        if (normalizedGuildId !== selectedGuildId) {
          void reportDashboardMilestone({
            guildId: normalizedGuildId,
            workspaceId: selectedWorkspaceId,
            action: "guild_selected",
          }).catch(() => undefined);
        }
      }
    },
    [router, currentPath, currentSearch, selectedGuildId, selectedWorkspaceId],
  );

  const handleRefresh = useCallback(async () => {
    resetGuildResourcesCache(session.guildResourcesCache);
    await router.invalidate({ sync: true });
    session.update(({ guildResourcesRefreshVersion }) => ({
      guildResourcesRefreshVersion: guildResourcesRefreshVersion + 1,
    }));
    await refreshGuildDirectory();
  }, [router, refreshGuildDirectory, session]);

  const routerContext: AdminRouterContext = {
    ...currentRouteState,
    currentSearch,
    defaultRedirectTarget: getDefaultAdminRedirectTarget({
      currentPath,
      search: currentSearch,
      selectedWorkspaceId,
      selectedGuildId,
      guildDirectory,
      defaultGuildId: userPreferences.defaultGuildId,
      hiddenGuildIds: userPreferences.hiddenGuildIds,
      preferencesLoading: userPreferencesLoading,
      lastUsedGuildId: getLastSelectedGuildId(),
    }),
    guildDirectory,
    guildLookupError,
    guildResourcesRefreshVersion,
    onSelectedGuildChange: handleSelectedGuildChange,
    refreshGuildDirectory,
    onRefresh: handleRefresh,
    playstationLinkEnabled: admin.playstationLinkEnabled ?? true,
    workerVersion: admin.workerVersion,
    entitlement,
    userProfile: {
      name: admin.userProfile?.name ?? "Admin User",
      email: admin.userProfile?.email ?? "",
      image: admin.userProfile?.image ?? "",
    },
    userPreferences,
    applyUserPreferencesPatch,
    isRoutePending,
  };

  return (
    <ToastProvider>
      <AdminRefreshNoticeHost />
      <AdminRouteContextProvider value={routerContext}>{children}</AdminRouteContextProvider>
    </ToastProvider>
  );
}

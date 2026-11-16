import { useCallback, useMemo, useState } from "react";
import {
  createBrowserHistory,
  createMemoryHistory,
  createRouter,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { SignInCard } from "./components/sign-in-card";
import { ToastProvider } from "./components/toast";
import { AdminRefreshNoticeHost } from "./components/admin-refresh-notice-host";
import { normalizeAdminDashboardPath } from "./dashboard-routes";
import { useGuildDirectory } from "./hooks/use-guild-directory";
import { useEntitlement } from "./hooks/use-entitlement";
import { useUserPreferences } from "./hooks/use-user-preferences";
import { resetGuildResourcesCache } from "./lib/guild-resources-cache";
import {
  buildAdminDashboardHref,
  encodeGuildIdForSearch,
  getDiscordSignInCallbackUrl,
} from "./lib/dashboard-urls";
import { routeTree } from "./routes/route-tree";
import type { AdminPageMetadata, AdminRouterContext } from "./routes/context";
import type { GuildShellLoaderData, LoadedAdminRouteData } from "./lib/admin-route-loaders";
import { AdminRouteContextProvider } from "./routes/page-context";
import { getAdminRouteState, getDefaultAdminRedirectTarget } from "./lib/admin-route-state";
import { setLastSelectedGuildId, getLastSelectedGuildId } from "./lib/guild-selection-persistence";
import { DEFAULT_USER_PREFERENCES } from "../runtime/admin-types";

export { combineDashboardErrors, describeError } from "./lib/api";
export {
  getSelectedGuildIdFromPath,
  getSelectedGuildIdFromSearch,
  getSelectedWorkspaceIdFromSearch,
  buildAdminDashboardHref,
  getDiscordSignInCallbackUrl,
  buildAdminOverviewApiPath,
  buildAdminGuildDirectoryApiPath,
} from "./lib/dashboard-urls";

interface Props {
  initialAuthenticated?: boolean;
  initialPath?: string;
  initialSearch?: string;
  initialUserName?: string;
  initialUserEmail?: string;
  initialUserImage?: string;
  initialPlayStationLinkEnabled?: boolean;
  initialWorkerVersion?: string;
}

export default function App({
  initialAuthenticated = false,
  initialPath = "/admin",
  initialSearch = "",
  initialUserName = "Admin User",
  initialUserEmail = "",
  initialUserImage = "",
  initialPlayStationLinkEnabled = true,
  initialWorkerVersion = "",
}: Props) {
  const [authenticated] = useState(initialAuthenticated);
  const initialDashboardPath = authenticated ? normalizeAdminDashboardPath(initialPath) : "/admin";

  const router = useMemo(() => {
    const initialEntry = initialSearch
      ? `${initialDashboardPath}${initialSearch}`
      : initialDashboardPath;
    if (authenticated && typeof window !== "undefined") {
      const currentHref = `${window.location.pathname}${window.location.search}`;
      if (currentHref !== initialEntry) {
        window.history.replaceState(window.history.state, "", initialEntry);
      }
    }

    const createdRouter = createRouter({
      routeTree,
      defaultPreload: "intent",
      history:
        typeof window === "undefined"
          ? createMemoryHistory({ initialEntries: [initialEntry] })
          : createBrowserHistory(),
      context: createRouterContext(),
    });

    if (typeof window === "undefined") {
      createdRouter.stores.setMatches(
        createdRouter
          .matchRoutes(createdRouter.state.location)
          .map((match) =>
            match.status === "pending" ? { ...match, status: "success" as const } : match,
          ),
      );
    }

    return createdRouter;
  }, []);

  const routerLocation = useRouterState({
    router,
    select: (state) => ({
      pathname: state.location.pathname,
      search: state.location.searchStr,
      status: state.status,
    }),
  });
  const currentRouteState = getAdminRouteState({
    pathname: normalizeAdminDashboardPath(routerLocation.pathname),
    search: routerLocation.search,
  });
  const guildShellLoaderData = useRouterState({
    router,
    select: (state) => {
      const match = state.matches.find((candidate) => candidate.routeId === "/admin/$guildId");
      return match?.loaderData as LoadedAdminRouteData<GuildShellLoaderData> | undefined;
    },
  });
  const [guildResourcesRefreshVersion, setGuildResourcesRefreshVersion] = useState(0);
  // Workspace authorization remains server-side for existing grants. Dashboard
  // startup no longer depends on discovering or selecting an organization.
  const entitlementResult = useEntitlement(
    currentRouteState.selectedWorkspaceId,
    currentRouteState.selectedGuildId,
    !currentRouteState.pathGuildId,
  );
  const guildShellMatchesCurrentRoute =
    guildShellLoaderData?.data.guildId === currentRouteState.pathGuildId &&
    guildShellLoaderData.data.workspaceId === currentRouteState.selectedWorkspaceId;
  const entitlement = currentRouteState.pathGuildId
    ? guildShellMatchesCurrentRoute
      ? guildShellLoaderData.data.entitlement
      : null
    : currentRouteState.selectedGuildId && !entitlementResult.loading && !entitlementResult.error
      ? entitlementResult.data
      : null;

  const { guildDirectory, guildLookupError, refreshGuildDirectory } = useGuildDirectory(
    authenticated,
    currentRouteState.selectedWorkspaceId,
  );
  const {
    preferences: userPreferences,
    loading: userPreferencesLoading,
    applyPatch: applyUserPreferencesPatch,
  } = useUserPreferences(authenticated);
  const handleSelectedGuildChange = useCallback(
    (nextGuildId: string) => {
      const normalizedGuildId = nextGuildId.trim();
      setLastSelectedGuildId(normalizedGuildId);
      const routeState = getAdminRouteState({
        pathname: router.state.location.pathname,
        search: router.state.location.searchStr,
      });
      if (routeState.currentPath === "/admin/billing") {
        const params = new URLSearchParams(router.state.location.searchStr);
        if (normalizedGuildId) params.set("guildId", encodeGuildIdForSearch(normalizedGuildId));
        else params.delete("guildId");
        const query = params.toString();
        void router.navigate({
          to: query ? `/admin/billing?${query}` : "/admin/billing",
          replace: true,
        });
        return;
      }
      const nextHref = buildAdminDashboardHref(
        routeState.currentPath,
        routeState.selectedWorkspaceId,
        normalizedGuildId,
      );

      if (typeof window !== "undefined") {
        void router.navigate({ to: nextHref, replace: true });
      }
    },
    [router],
  );

  const handleRefresh = useCallback(async () => {
    resetGuildResourcesCache();
    await router.invalidate({ sync: true });
    setGuildResourcesRefreshVersion((current) => current + 1);
    await refreshGuildDirectory();
  }, [router, refreshGuildDirectory]);

  const routerContext: AdminRouterContext = {
    currentPath: currentRouteState.currentPath,
    currentSearch: routerLocation.search,
    selectedWorkspaceId: currentRouteState.selectedWorkspaceId,
    selectedGuildId: currentRouteState.selectedGuildId,
    pathGuildId: currentRouteState.pathGuildId,
    reactionRulesTab: currentRouteState.reactionRulesTab,
    playerLinkPlatform: currentRouteState.playerLinkPlatform,
    ticketsTab: currentRouteState.ticketsTab,
    commerceTab: currentRouteState.commerceTab,
    defaultRedirectTarget: getDefaultAdminRedirectTarget({
      currentPath: currentRouteState.currentPath,
      search: routerLocation.search,
      selectedWorkspaceId: currentRouteState.selectedWorkspaceId,
      selectedGuildId: currentRouteState.selectedGuildId,
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
    playstationLinkEnabled: initialPlayStationLinkEnabled,
    workerVersion: initialWorkerVersion || undefined,
    entitlement,
    userProfile: {
      name: initialUserName,
      email: initialUserEmail,
      image: initialUserImage,
    },
    userPreferences,
    applyUserPreferencesPatch,
    pageMetadata: null,
    setPageMetadata: () => {},
    isRoutePending: routerLocation.status === "pending",
  };

  if (authenticated) {
    return (
      <ToastProvider>
        <AdminRefreshNoticeHost />
        <AdminRouteContextProvider value={routerContext}>
          <RouterProvider router={router} context={routerContext} />
        </AdminRouteContextProvider>
      </ToastProvider>
    );
  }

  return (
    <SignInCard
      initialSearch={initialSearch}
      onSignIn={async () => {
        const { authClient } = await import("../runtime/auth/auth-client");
        await authClient.signIn.social({
          provider: "discord",
          callbackURL: getDiscordSignInCallbackUrl(initialSearch),
        });
      }}
    />
  );
}

export function buildGuildScopedViewInstanceKey(
  workspaceId: string,
  guildId: string,
  refreshVersion: number,
): string {
  return `${workspaceId}:${guildId || "no-guild"}:${refreshVersion}`;
}

function createRouterContext(): AdminRouterContext {
  return {
    currentPath: "/admin",
    currentSearch: "",
    selectedWorkspaceId: "",
    selectedGuildId: "",
    pathGuildId: "",
    reactionRulesTab: "blocklist",
    playerLinkPlatform: "steam",
    ticketsTab: "panel",
    commerceTab: "offerings",
    defaultRedirectTarget: null,
    guildDirectory: null,
    guildLookupError: null,
    guildResourcesRefreshVersion: 0,
    onSelectedGuildChange: () => {},
    refreshGuildDirectory: async () => {},
    onRefresh: async () => {},
    playstationLinkEnabled: true,
    entitlement: null,
    userProfile: {
      name: "Admin User",
      email: "",
      image: "",
    },
    userPreferences: DEFAULT_USER_PREFERENCES,
    applyUserPreferencesPatch: async () => undefined,
    pageMetadata: null,
    setPageMetadata: (_metadata: AdminPageMetadata | null) => {},
    isRoutePending: false,
  };
}

import { Navigate, createRoute } from "@tanstack/react-router";

import { Card, CardContent } from "../components/ui/card";
import { buildAdminDashboardHref } from "../lib/dashboard-urls";
import { Route as rootRoute } from "./__root";
import { createLazyAdminPage } from "./lazy-page";
import { AdminRouteShell, useAdminRouteContext } from "./page-context";

const GuildDirectoryEmptyCard = createLazyAdminPage(
  () => import("../components/admin-overview-page"),
  "GuildDirectoryEmptyCard",
);

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminIndexRoute,
});

function AdminIndexRoute() {
  const context = useAdminRouteContext();
  // The index can remain mounted while the destination route's loaders run.
  if (context.currentPath !== "/admin") return null;

  const redirectTarget = context.selectedGuildId
    ? buildAdminDashboardHref("/admin", context.selectedWorkspaceId, context.selectedGuildId)
    : context.defaultRedirectTarget;

  if (redirectTarget) {
    return <Navigate to={redirectTarget} replace />;
  }

  const isGuildDirectoryLoading = context.guildDirectory === null && !context.guildLookupError;
  const allGuildsHidden =
    context.guildDirectory !== null &&
    context.guildDirectory.length > 0 &&
    context.guildDirectory.every((guild) =>
      context.userPreferences.hiddenGuildIds.includes(guild.guildId),
    );

  return (
    <AdminRouteShell>
      {isGuildDirectoryLoading ? (
        <GuildDirectoryLoadingCard />
      ) : (
        <GuildDirectoryEmptyCard
          hasGuilds={Boolean(context.guildDirectory?.length)}
          allGuildsHidden={allGuildsHidden}
          lookupError={context.guildLookupError}
          workspaceId={context.selectedWorkspaceId}
          onRefresh={context.refreshGuildDirectory}
        />
      )}
    </AdminRouteShell>
  );
}

function GuildDirectoryLoadingCard() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span
          className="flex h-12 w-12 items-center justify-center rounded-full border bg-muted/40 text-muted-foreground"
          aria-hidden="true"
        >
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        </span>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Loading your servers…</p>
          <p className="mx-auto max-w-sm text-xs text-muted-foreground">
            Finding the Discord servers you can manage.
          </p>
        </div>
        <span role="status" aria-live="polite" className="sr-only">
          Loading your servers.
        </span>
      </CardContent>
    </Card>
  );
}

import { createRoute, Outlet } from "@tanstack/react-router";

import { Route as rootRoute } from "./__root";
import { AdminRouteShell } from "./page-context";
import { loadGuildShellRoute } from "../lib/admin-route-loaders";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/$guildId",
  remountDeps: ({ params }) => params?.guildId ?? "",
  loaderDeps: ({ search }) => ({
    workspaceId: (search as { workspaceId?: string }).workspaceId ?? "",
  }),
  loader: loadGuildShellRoute,
  component: GuildLayoutRoute,
});

function GuildLayoutRoute() {
  return (
    <AdminRouteShell>
      <Outlet />
    </AdminRouteShell>
  );
}

import { createFileRoute, Outlet } from "@tanstack/react-router";

import { AdminRouteShell } from "../../../../admin/routes/page-context";
import { loadGuildShellRoute } from "../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId")({
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

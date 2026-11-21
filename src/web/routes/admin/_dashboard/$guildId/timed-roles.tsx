import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadTimedRolesRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/timed-roles")(
  guildRouteOptions({
    path: "timed-roles",
    loader: loadTimedRolesRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-timed-roles-page"),
      exportName: "AdminTimedRolesPage",
    },
  }),
);

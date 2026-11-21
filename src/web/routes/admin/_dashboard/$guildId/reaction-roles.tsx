import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadReactionRolesRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/reaction-roles")(
  guildRouteOptions({
    path: "reaction-roles",
    loader: loadReactionRolesRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-reaction-roles-page"),
      exportName: "AdminReactionRolesPage",
    },
  }),
);

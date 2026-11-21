import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadClansRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/clans")(
  guildRouteOptions({
    path: "clans",
    loader: loadClansRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-clans-page"),
      exportName: "AdminClansPage",
    },
  }),
);

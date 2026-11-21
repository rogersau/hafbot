import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadPlayerCountRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/playercount")(
  guildRouteOptions({
    path: "playercount",
    loader: loadPlayerCountRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-playercount-page"),
      exportName: "AdminPlayerCountPage",
    },
  }),
);

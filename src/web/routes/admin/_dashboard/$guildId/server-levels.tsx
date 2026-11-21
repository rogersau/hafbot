import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadServerLevelsRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/server-levels")(
  guildRouteOptions({
    path: "server-levels",
    loader: loadServerLevelsRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-server-levels-page"),
      exportName: "AdminServerLevelsPage",
    },
  }),
);

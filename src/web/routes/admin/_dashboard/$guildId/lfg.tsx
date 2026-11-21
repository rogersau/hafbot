import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadLfgRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/lfg")(
  guildRouteOptions({
    path: "lfg",
    loader: loadLfgRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-lfg-page"),
      exportName: "AdminLfgPage",
    },
  }),
);

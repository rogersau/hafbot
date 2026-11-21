import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadWardogsRoute } from "../../../../../admin/lib/admin-route-loaders";
export const Route = createFileRoute("/admin/_dashboard/$guildId/wardogs")(
  guildRouteOptions({
    path: "wardogs",
    loader: loadWardogsRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-wardogs-page"),
      exportName: "AdminWardogsPage",
    },
  }),
);

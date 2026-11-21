import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadWardogsCommunityRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/wardogs-community")(
  guildRouteOptions({
    path: "wardogs-community",
    loader: loadWardogsCommunityRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-wardogs-community-page"),
      exportName: "AdminWardogsCommunityPage",
    },
  }),
);

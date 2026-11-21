import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadReputationRoute } from "../../../../../admin/lib/admin-route-loaders";
export const Route = createFileRoute("/admin/_dashboard/$guildId/reputation")(
  guildRouteOptions({
    path: "reputation",
    loader: loadReputationRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-reputation-page"),
      exportName: "AdminReputationPage",
    },
  }),
);

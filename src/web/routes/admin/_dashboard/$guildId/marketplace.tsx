import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadMarketplaceRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/marketplace")(
  guildRouteOptions({
    path: "marketplace",
    loader: loadMarketplaceRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-marketplace-page"),
      exportName: "AdminMarketplacePage",
    },
  }),
);

import { createGuildRoute } from "./guild-route-factory";
import { loadMarketplaceRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "marketplace",
  loader: loadMarketplaceRoute,
  page: {
    load: () => import("../../components/admin-marketplace-page"),
    exportName: "AdminMarketplacePage",
  },
});

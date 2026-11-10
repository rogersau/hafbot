import { createGuildRoute } from "./guild-route-factory";
import { loadCommerceRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "commerce",
  loader: loadCommerceRoute,
  page: {
    load: () => import("../../components/admin-commerce-page"),
    exportName: "AdminCommercePage",
  },
});

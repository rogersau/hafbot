import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadCommerceRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/commerce")(
  guildRouteOptions({
    path: "commerce",
    loader: loadCommerceRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-commerce-page"),
      exportName: "AdminCommercePage",
    },
  }),
);

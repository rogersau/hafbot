import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadImageRulesRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/image-rules")(
  guildRouteOptions({
    path: "image-rules",
    loader: loadImageRulesRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-image-rules-page"),
      exportName: "AdminImageRulesPage",
    },
    extraProps: (context) => ({
      entitlement: context.entitlement,
    }),
  }),
);

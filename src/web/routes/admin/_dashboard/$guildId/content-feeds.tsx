import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadContentFeedsRoute } from "../../../../../admin/lib/admin-route-loaders";
export const Route = createFileRoute("/admin/_dashboard/$guildId/content-feeds")(
  guildRouteOptions({
    path: "content-feeds",
    loader: loadContentFeedsRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-community-tools-page"),
      exportName: "AdminContentFeedsPage",
    },
  }),
);

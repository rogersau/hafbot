import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadBlocklistRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/blocklist")(
  guildRouteOptions({
    path: "blocklist",
    loader: loadBlocklistRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-blocklist-page"),
      exportName: "AdminBlocklistPage",
    },
    extraProps: (context, loaderData) => ({
      activeTab: context.reactionRulesTab,
      entitlement: context.entitlement ?? loaderData?.data.entitlement ?? null,
    }),
  }),
);

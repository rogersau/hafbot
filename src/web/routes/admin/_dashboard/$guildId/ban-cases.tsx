import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadBanCasesRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/ban-cases")(
  guildRouteOptions({
    path: "ban-cases",
    loader: loadBanCasesRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-ban-cases-page"),
      exportName: "AdminBanCasesPage",
    },
    extraProps: (context) => ({
      entitlement: context.entitlement,
    }),
  }),
);

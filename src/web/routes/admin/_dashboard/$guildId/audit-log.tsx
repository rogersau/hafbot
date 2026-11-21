import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadGuildAuditLogRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/audit-log")(
  guildRouteOptions({
    path: "audit-log",
    loader: loadGuildAuditLogRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-audit-log-page"),
      exportName: "AdminAuditLogPage",
    },
    extraProps: (context, loaderData) => ({
      tier: context.entitlement?.tier ?? loaderData?.data.entitlement?.tier ?? null,
    }),
  }),
);

import { createGuildRoute } from "./guild-route-factory";
import { loadGuildAuditLogRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "audit-log",
  loader: loadGuildAuditLogRoute,
  page: {
    load: () => import("../../components/admin-audit-log-page"),
    exportName: "AdminAuditLogPage",
  },
  extraProps: (context, loaderData) => ({
    tier: context.entitlement?.tier ?? loaderData?.data.entitlement?.tier ?? null,
  }),
});

import { createGuildRoute } from "./guild-route-factory";
import { loadBanCasesRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "ban-cases",
  loader: loadBanCasesRoute,
  page: {
    load: () => import("../../components/admin-ban-cases-page"),
    exportName: "AdminBanCasesPage",
  },
  extraProps: (context) => ({
    entitlement: context.entitlement,
  }),
});

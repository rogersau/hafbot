import { createGuildRoute } from "./guild-route-factory";
import { loadBlocklistRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "blocklist",
  loader: loadBlocklistRoute,
  page: {
    load: () => import("../../components/admin-blocklist-page"),
    exportName: "AdminBlocklistPage",
  },
  extraProps: (context, loaderData) => ({
    activeTab: context.reactionRulesTab,
    entitlement: context.entitlement ?? loaderData?.data.entitlement ?? null,
  }),
});

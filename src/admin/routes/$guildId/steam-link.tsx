import { createGuildRoute } from "./guild-route-factory";
import { loadSteamLinkRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "steam-link",
  loader: loadSteamLinkRoute,
  page: {
    load: () => import("../../components/admin-steam-link-page"),
    exportName: "AdminSteamLinkPage",
  },
  extraProps: (context) => ({
    entitlement: context.entitlement,
  }),
});

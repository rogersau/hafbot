import { createGuildRoute } from "./guild-route-factory";
import { loadBotDefenseRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "bot-defense",
  loader: loadBotDefenseRoute,
  page: {
    load: () => import("../../components/admin-bot-defense-page"),
    exportName: "AdminBotDefensePage",
  },
  extraProps: (context, loaderData) => ({
    entitlement: context.entitlement ?? loaderData?.data.entitlement ?? null,
  }),
});

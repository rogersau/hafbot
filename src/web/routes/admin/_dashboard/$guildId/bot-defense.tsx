import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadBotDefenseRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/bot-defense")(
  guildRouteOptions({
    path: "bot-defense",
    loader: loadBotDefenseRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-bot-defense-page"),
      exportName: "AdminBotDefensePage",
    },
    extraProps: (context, loaderData) => ({
      entitlement: context.entitlement ?? loaderData?.data.entitlement ?? null,
    }),
  }),
);

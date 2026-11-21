import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadWebhooksRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/webhooks")(
  guildRouteOptions({
    path: "webhooks",
    loader: loadWebhooksRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-webhooks-page"),
      exportName: "AdminWebhooksPage",
    },
    extraProps: (context) => ({
      entitlement: context.entitlement,
    }),
  }),
);

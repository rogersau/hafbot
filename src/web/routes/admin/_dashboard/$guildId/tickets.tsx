import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadTicketsRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/tickets")(
  guildRouteOptions({
    path: "tickets",
    loader: loadTicketsRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-tickets-page-with-history"),
      exportName: "AdminTicketsPageWithHistory",
    },
    extraProps: (context) => ({
      entitlement: context.entitlement,
    }),
  }),
);

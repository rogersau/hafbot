import { createGuildRoute } from "./guild-route-factory";
import { loadTicketsRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "tickets",
  loader: loadTicketsRoute,
  page: {
    load: () => import("../../components/admin-tickets-page-with-history"),
    exportName: "AdminTicketsPageWithHistory",
  },
  extraProps: (context) => ({
    entitlement: context.entitlement,
  }),
});

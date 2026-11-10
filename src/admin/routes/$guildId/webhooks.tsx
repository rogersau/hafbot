import { createGuildRoute } from "./guild-route-factory";
import { loadWebhooksRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "webhooks",
  loader: loadWebhooksRoute,
  page: {
    load: () => import("../../components/admin-webhooks-page"),
    exportName: "AdminWebhooksPage",
  },
  extraProps: (context) => ({
    entitlement: context.entitlement,
  }),
});

import { createGuildRoute } from "./guild-route-factory";
import { loadImageRulesRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "image-rules",
  loader: loadImageRulesRoute,
  page: {
    load: () => import("../../components/admin-image-rules-page"),
    exportName: "AdminImageRulesPage",
  },
  extraProps: (context) => ({
    entitlement: context.entitlement,
  }),
});

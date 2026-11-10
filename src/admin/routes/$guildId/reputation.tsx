import { createGuildRoute } from "./guild-route-factory";
import { loadReputationRoute } from "../../lib/admin-route-loaders";
export const Route = createGuildRoute({
  path: "reputation",
  loader: loadReputationRoute,
  page: {
    load: () => import("../../components/admin-reputation-page"),
    exportName: "AdminReputationPage",
  },
});

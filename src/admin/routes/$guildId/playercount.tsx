import { createGuildRoute } from "./guild-route-factory";
import { loadPlayerCountRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "playercount",
  loader: loadPlayerCountRoute,
  page: {
    load: () => import("../../components/admin-playercount-page"),
    exportName: "AdminPlayerCountPage",
  },
});

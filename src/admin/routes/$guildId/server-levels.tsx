import { createGuildRoute } from "./guild-route-factory";
import { loadServerLevelsRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "server-levels",
  loader: loadServerLevelsRoute,
  page: {
    load: () => import("../../components/admin-server-levels-page"),
    exportName: "AdminServerLevelsPage",
  },
});

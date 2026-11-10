import { createGuildRoute } from "./guild-route-factory";
import { loadLfgRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "lfg",
  loader: loadLfgRoute,
  page: {
    load: () => import("../../components/admin-lfg-page"),
    exportName: "AdminLfgPage",
  },
});

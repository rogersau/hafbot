import { createGuildRoute } from "./guild-route-factory";
import { loadClansRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "clans",
  loader: loadClansRoute,
  page: {
    load: () => import("../../components/admin-clans-page"),
    exportName: "AdminClansPage",
  },
});

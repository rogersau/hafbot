import { createGuildRoute } from "./guild-route-factory";
import { loadTimedRolesRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "timed-roles",
  loader: loadTimedRolesRoute,
  page: {
    load: () => import("../../components/admin-timed-roles-page"),
    exportName: "AdminTimedRolesPage",
  },
});

import { createGuildRoute } from "./guild-route-factory";
import { loadReactionRolesRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "reaction-roles",
  loader: loadReactionRolesRoute,
  page: {
    load: () => import("../../components/admin-reaction-roles-page"),
    exportName: "AdminReactionRolesPage",
  },
});

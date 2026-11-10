import { createGuildRoute } from "./guild-route-factory";
import { loadWardogsRoute } from "../../lib/admin-route-loaders";
export const Route = createGuildRoute({
  path: "wardogs",
  loader: loadWardogsRoute,
  page: {
    load: () => import("../../components/admin-wardogs-page"),
    exportName: "AdminWardogsPage",
  },
});

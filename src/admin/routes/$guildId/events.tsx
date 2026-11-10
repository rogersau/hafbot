import { createGuildRoute } from "./guild-route-factory";
import { loadEventsRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "events",
  loader: loadEventsRoute,
  page: {
    load: () => import("../../components/admin-events-page"),
    exportName: "AdminEventsPage",
  },
});

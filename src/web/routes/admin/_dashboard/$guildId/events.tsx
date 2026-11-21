import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadEventsRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/events")(
  guildRouteOptions({
    path: "events",
    loader: loadEventsRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-events-page"),
      exportName: "AdminEventsPage",
    },
  }),
);

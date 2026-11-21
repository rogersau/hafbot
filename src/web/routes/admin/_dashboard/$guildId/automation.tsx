import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadAutomationRoute } from "../../../../../admin/lib/admin-route-loaders";
export const Route = createFileRoute("/admin/_dashboard/$guildId/automation")(
  guildRouteOptions({
    path: "automation",
    loader: loadAutomationRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-community-tools-page"),
      exportName: "AdminAutomationPage",
    },
  }),
);

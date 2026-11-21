import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadSuggestionsRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/suggestions")(
  guildRouteOptions({
    path: "suggestions",
    loader: loadSuggestionsRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-suggestions-page"),
      exportName: "AdminSuggestionsPage",
    },
  }),
);

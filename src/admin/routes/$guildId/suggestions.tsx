import { createGuildRoute } from "./guild-route-factory";
import { loadSuggestionsRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "suggestions",
  loader: loadSuggestionsRoute,
  page: {
    load: () => import("../../components/admin-suggestions-page"),
    exportName: "AdminSuggestionsPage",
  },
});

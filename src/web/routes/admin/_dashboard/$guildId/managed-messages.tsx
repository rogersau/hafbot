import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadManagedMessagesRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/managed-messages")(
  guildRouteOptions({
    path: "managed-messages",
    loader: loadManagedMessagesRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-managed-messages-page"),
      exportName: "AdminManagedMessagesPage",
    },
  }),
);

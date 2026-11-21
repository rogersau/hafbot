import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadChatModerationRoute } from "../../../../../admin/lib/admin-route-loaders";
export const Route = createFileRoute("/admin/_dashboard/$guildId/chat-moderation")(
  guildRouteOptions({
    path: "chat-moderation",
    loader: loadChatModerationRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-community-tools-page"),
      exportName: "AdminChatModerationPage",
    },
  }),
);

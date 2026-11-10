import { createGuildRoute } from "./guild-route-factory";
import { loadChatModerationRoute } from "../../lib/admin-route-loaders";
export const Route = createGuildRoute({
  path: "chat-moderation",
  loader: loadChatModerationRoute,
  page: {
    load: () => import("../../components/admin-community-tools-page"),
    exportName: "AdminChatModerationPage",
  },
});

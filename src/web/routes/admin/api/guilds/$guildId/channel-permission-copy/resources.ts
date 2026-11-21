import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../../admin-api";

export const Route = createFileRoute(
  "/admin/api/guilds/$guildId/channel-permission-copy/resources",
)({
  server: {
    handlers: {
      GET: handleAdminOperation("channelPermissionCopy.resources.get"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
